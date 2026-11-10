// Sessions: a signed JWT in an HttpOnly cookie. Every request re-reads the user from the database,
// so suspending an account, changing a role or resetting a password takes effect at once.
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import { one } from "./db.js";
import { HttpError, isHttps } from "./http.js";

export const COOKIE = "ag_session";
const MAX_AGE_S = 60 * 60 * 24 * 7; // 7 days

function secret() {
  const s = process.env.JWT_SECRET || "";
  if (s.length < 32) {
    throw new HttpError(503, "JWT_SECRET is not set (or shorter than 32 characters) in the server environment variables.");
  }
  return s;
}

export async function hashPassword(pw) {
  return bcrypt.hash(pw, 10);
}
export async function checkPassword(pw, hash) {
  if (!hash) return false;
  return bcrypt.compare(pw, hash);
}

export function validatePassword(pw) {
  const s = String(pw || "");
  if (s.length < 8) throw new HttpError(400, "Password must be at least 8 characters");
  if (s.length > 128) throw new HttpError(400, "Password is too long");
  if (!/[A-Za-z]/.test(s) || !/\d/.test(s)) throw new HttpError(400, "Password must contain letters and numbers");
  return s;
}

function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || "").split(";").forEach((p) => {
    const i = p.indexOf("=");
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function cookieHeader(req, value, maxAge) {
  const parts = [`${COOKIE}=${value}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAge}`];
  if (isHttps(req) || process.env.NODE_ENV === "production") parts.push("Secure");
  return parts.join("; ");
}

export function setSession(req, res, user) {
  const token = jwt.sign({ sub: String(user.id), tv: user.token_version, r: user.role }, secret(), {
    expiresIn: MAX_AGE_S,
    algorithm: "HS256",
  });
  res.setHeader("Set-Cookie", cookieHeader(req, token, MAX_AGE_S));
}

export function clearSession(req, res) {
  res.setHeader("Set-Cookie", cookieHeader(req, "", 0));
}

export const USER_COLUMNS =
  "id, email, full_name, phone, role, status, district, sector, token_version, email_notifications, preferred_lang, created_at, last_login_at";

// Returns the logged-in user or null. Invalid / stale cookies are cleared.
export async function getUser(req, res, { optional = true } = {}) {
  const token = parseCookies(req)[COOKIE];
  if (!token) return null;
  let payload;
  try {
    payload = jwt.verify(token, secret(), { algorithms: ["HS256"] });
  } catch (err) {
    if (err instanceof HttpError) throw err;
    if (res) clearSession(req, res);
    return null;
  }
  const user = await one(`SELECT ${USER_COLUMNS} FROM users WHERE id = $1`, [Number(payload.sub)]);
  if (!user || user.token_version !== payload.tv) {
    if (res) clearSession(req, res);
    return null;
  }
  if (user.status !== "active") {
    if (res) clearSession(req, res);
    if (optional) return null;
    throw new HttpError(403, "This account is suspended. Contact the administrator.");
  }
  return user;
}

export function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    email: u.email,
    fullName: u.full_name,
    phone: u.phone,
    role: u.role,
    status: u.status,
    district: u.district,
    sector: u.sector,
    emailNotifications: u.email_notifications,
    preferredLang: u.preferred_lang,
    createdAt: u.created_at,
    lastLoginAt: u.last_login_at,
  };
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString("base64url");
}
export function sha256(s) {
  return crypto.createHash("sha256").update(String(s)).digest("hex");
}
