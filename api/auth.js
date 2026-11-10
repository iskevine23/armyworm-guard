// /api/auth?action=register | login | logout | me | forgot | reset | change-password
import { api, str, email as emailField, HttpError, appUrl } from "../lib/http.js";
import { one, query, tx } from "../lib/db.js";
import {
  getUser, setSession, clearSession, hashPassword, checkPassword, validatePassword,
  publicUser, randomToken, sha256, USER_COLUMNS,
} from "../lib/auth.js";
import { getSettings, logActivity, rateLimit, housekeeping } from "../lib/system.js";
import { renderEmail, sendEmail, sendEmails } from "../lib/mailer.js";

const LANGS = ["en", "rw"];
let dummy = null;
async function dummyHash() {
  if (!dummy) dummy = await hashPassword("not-a-real-password-1");
  return dummy;
}

async function profileFor(user) {
  if (!user) return null;
  if (user.role === "farmer") {
    return one("SELECT farm_name, village, farm_size_ha, lat, lng FROM farmer_profiles WHERE user_id=$1", [user.id]);
  }
  if (user.role === "advisor") {
    return one("SELECT organization, title, coverage_districts, lat, lng FROM advisor_profiles WHERE user_id=$1", [user.id]);
  }
  return null;
}

export async function sendResetEmail(req, user, { invite = false } = {}) {
  const token = randomToken();
  const hours = invite ? 72 : 1;
  await query(
    "INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1,$2, now() + make_interval(hours => $3))",
    [user.id, sha256(token), hours]
  );
  const link = `${appUrl(req)}/login.html#reset=${token}`;
  const { text, html } = renderEmail(
    invite
      ? {
          heading: "Your ArmywormGuard account is ready",
          lines: [
            `Hello ${user.full_name},`,
            `An administrator created an ArmywormGuard ${user.role} account for you. Choose your password to sign in. This link works for ${hours} hours.`,
          ],
          details: [["Sign-in email", user.email], ["Role", user.role]],
          button: { label: "Choose my password", url: link },
        }
      : {
          heading: "Reset your password",
          lines: [
            `Hello ${user.full_name},`,
            "Someone asked to reset the password for your ArmywormGuard account. If it was you, use the button below. The link works for 1 hour. If it was not you, ignore this email: your password will not change.",
          ],
          button: { label: "Choose a new password", url: link },
        }
  );
  const result = await sendEmail({
    to: user.email,
    userId: user.id,
    subject: invite ? "Your ArmywormGuard account" : "Reset your ArmywormGuard password",
    text,
    html,
    template: invite ? "invite" : "password_reset",
    respectPreference: false, // account emails are always sent
  });
  return { result, link };
}

export default api(
  {
    "GET me": {
      auth: null,
      fn: async ({ user }) => {
        housekeeping();
        if (!user) return { user: null };
        const unread = await one("SELECT COUNT(*)::int AS n FROM notifications WHERE user_id=$1 AND read_at IS NULL", [user.id]);
        return { user: publicUser(user), profile: await profileFor(user), unreadNotifications: unread.n };
      },
    },

    "POST register": {
      auth: null,
      fn: async ({ req, res, body, ip, user: current }) => {
        if (current) throw new HttpError(400, "You are already logged in. Log out first to create another account.");
        await rateLimit(`register:${ip}`, 10, 3600, "Too many sign-ups from this network. Try again in an hour.");
        const settings = await getSettings();
        const fullName = str(body.fullName, 120, { required: true, name: "Full name", min: 2 });
        const email = emailField(body.email);
        const password = validatePassword(body.password);
        const phone = str(body.phone, 30, { name: "Phone" }) || null;
        const district = str(body.district, 60, { name: "District" }) || null;
        const sector = str(body.sector, 60, { name: "Sector" }) || null;
        const farmName = str(body.farmName, 80, { name: "Farm name" }) || null;
        const lang = LANGS.includes(body.lang) ? body.lang : "en";

        // First-run bootstrap: the address in BOOTSTRAP_ADMIN_EMAIL becomes administrator,
        // but only while the system has no administrator at all.
        let role = "farmer";
        const boot = (process.env.BOOTSTRAP_ADMIN_EMAIL || "").trim().toLowerCase();
        if (boot && boot === email) {
          const anyAdmin = await one("SELECT 1 FROM users WHERE role='admin' LIMIT 1");
          if (!anyAdmin) role = "admin";
        }
        if (role === "farmer" && !settings.registration.farmers_open) {
          throw new HttpError(403, "New registrations are closed right now. Contact the administrator.");
        }

        const exists = await one("SELECT 1 FROM users WHERE lower(email)=$1", [email]);
        if (exists) throw new HttpError(409, "An account with this email already exists. Log in, or reset your password.");

        const hash = await hashPassword(password);
        const created = await tx(async (c) => {
          const u = await c.query(
            `INSERT INTO users (email, password_hash, full_name, phone, role, district, sector, preferred_lang, last_login_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now()) RETURNING ${USER_COLUMNS}`,
            [email, hash, fullName, phone, role, district, sector, lang]
          );
          if (role === "farmer") {
            await c.query("INSERT INTO farmer_profiles (user_id, farm_name) VALUES ($1,$2)", [u.rows[0].id, farmName]);
          }
          return u.rows[0];
        });
        setSession(req, res, created);
        await logActivity(created.id, role === "admin" ? "register_bootstrap_admin" : "register", "user", created.id, null, ip);

        const { text, html } = renderEmail({
          heading: `Welcome to ArmywormGuard, ${fullName}`,
          lines: [
            "Your account is ready. You can now save your scans, see full results and spread risk, and ask an agricultural advisor for help.",
            "Tip: save your farm location in My farm so your reports reach the right advisor.",
          ],
          button: { label: "Open my dashboard", url: appUrl(req) + "/dashboard.html" },
        });
        await sendEmails([{ to: email, userId: created.id, subject: "Welcome to ArmywormGuard", text, html, template: "welcome" }], { budgetMs: 5000 })
          .catch((e) => console.error("welcome email:", e.message));

        return { __status: 201, user: publicUser(created), profile: await profileFor(created) };
      },
    },

    "POST login": {
      auth: null,
      fn: async ({ req, res, body, ip }) => {
        const email = emailField(body.email);
        const password = str(body.password, 200, { required: true, name: "Password" });
        await rateLimit(`login-ip:${ip}`, 30, 900, "Too many login attempts. Wait 15 minutes and try again.");
        await rateLimit(`login:${email}`, 8, 900, "Too many login attempts for this account. Wait 15 minutes, or reset your password.");
        const u = await one(`SELECT ${USER_COLUMNS}, password_hash FROM users WHERE lower(email)=$1`, [email]);
        const ok = u ? await checkPassword(password, u.password_hash) : await checkPassword(password, await dummyHash()); // same timing whether or not the email exists
        if (!u || !ok) {
          await logActivity(u?.id || null, "login_failed", "user", u?.id || null, { email }, ip);
          throw new HttpError(401, "Wrong email or password");
        }
        if (u.status !== "active") throw new HttpError(403, "This account is suspended. Contact the administrator.");
        await query("UPDATE users SET last_login_at=now() WHERE id=$1", [u.id]);
        await query("DELETE FROM rate_limits WHERE key=$1", [`login:${email}`]);
        delete u.password_hash;
        setSession(req, res, u);
        await logActivity(u.id, "login", "user", u.id, null, ip);
        return { user: publicUser(u), profile: await profileFor(u) };
      },
    },

    "POST logout": {
      auth: null,
      fn: async ({ req, res, user, ip }) => {
        clearSession(req, res);
        if (user) await logActivity(user.id, "logout", "user", user.id, null, ip);
        return { ok: true };
      },
    },

    "POST forgot": {
      auth: false,
      fn: async ({ req, body, ip }) => {
        const email = emailField(body.email);
        await rateLimit(`forgot:${ip}`, 10, 3600, "Too many requests. Try again later.");
        await rateLimit(`forgot:${email}`, 3, 3600, "A reset email was already sent. Check your inbox (and spam folder), or try again in an hour.");
        const u = await one(`SELECT ${USER_COLUMNS} FROM users WHERE lower(email)=$1 AND status='active'`, [email]);
        if (u) {
          await sendResetEmail(req, u);
          await logActivity(u.id, "password_reset_requested", "user", u.id, null, ip);
        }
        // same answer whether or not the account exists
        return { ok: true, message: "If an account exists for this email, a reset link has been sent. It works for 1 hour." };
      },
    },

    "POST reset": {
      auth: false,
      fn: async ({ req, res, body, ip }) => {
        const token = str(body.token, 200, { required: true, name: "Reset link" });
        const password = validatePassword(body.password);
        await rateLimit(`reset:${ip}`, 20, 3600);
        const pr = await one(
          "SELECT * FROM password_resets WHERE token_hash=$1 AND used_at IS NULL AND expires_at > now()",
          [sha256(token)]
        );
        if (!pr) throw new HttpError(400, "This link is invalid or has expired. Ask for a new one.");
        const hash = await hashPassword(password);
        const u = await tx(async (c) => {
          await c.query("UPDATE password_resets SET used_at=now() WHERE id=$1", [pr.id]);
          await c.query("UPDATE password_resets SET used_at=now() WHERE user_id=$1 AND used_at IS NULL", [pr.user_id]);
          const r = await c.query(
            `UPDATE users SET password_hash=$2, token_version=token_version+1, updated_at=now(), last_login_at=now()
              WHERE id=$1 AND status='active' RETURNING ${USER_COLUMNS}`,
            [pr.user_id, hash]
          );
          return r.rows[0];
        });
        if (!u) throw new HttpError(403, "This account is suspended. Contact the administrator.");
        setSession(req, res, u);
        await logActivity(u.id, "password_reset", "user", u.id, null, ip);
        return { user: publicUser(u) };
      },
    },

    "POST change-password": {
      auth: "any",
      fn: async ({ req, res, body, user, ip }) => {
        const current = str(body.currentPassword, 200, { required: true, name: "Current password" });
        const password = validatePassword(body.newPassword);
        await rateLimit(`chpw:${user.id}`, 10, 3600);
        const row = await one("SELECT password_hash FROM users WHERE id=$1", [user.id]);
        if (!(await checkPassword(current, row.password_hash))) throw new HttpError(400, "Current password is wrong");
        const u = await one(
          `UPDATE users SET password_hash=$2, token_version=token_version+1, updated_at=now() WHERE id=$1 RETURNING ${USER_COLUMNS}`,
          [user.id, await hashPassword(password)]
        );
        setSession(req, res, u); // keep this device signed in, sign out every other device
        await logActivity(user.id, "password_changed", "user", user.id, null, ip);
        return { ok: true };
      },
    },
  },
  { getUser }
);
