// /api/me — the logged-in user's own profile and notifications
//   GET  ?action=profile
//   PUT  ?action=profile        { fullName, phone, district, sector, emailNotifications, preferredLang, farm{...} | advisor{...} }
//   GET  ?action=notifications  ?unread=1
//   POST ?action=read           { ids: [..] } or { all: true }
import { api, str, num, HttpError } from "../lib/http.js";
import { one, many, query, tx } from "../lib/db.js";
import { getUser, publicUser, USER_COLUMNS } from "../lib/auth.js";
import { logActivity } from "../lib/system.js";
import { districtList } from "../lib/format.js";

async function profile(user) {
  const out = { user: publicUser(user) };
  if (user.role === "farmer") {
    const f = await one("SELECT farm_name, village, farm_size_ha, lat, lng FROM farmer_profiles WHERE user_id=$1", [user.id]);
    out.farm = f ? { farmName: f.farm_name, village: f.village, farmSizeHa: f.farm_size_ha, lat: f.lat, lng: f.lng } : {};
  }
  if (user.role === "advisor") {
    const a = await one("SELECT organization, title, coverage_districts, lat, lng FROM advisor_profiles WHERE user_id=$1", [user.id]);
    out.advisor = a ? { organization: a.organization, title: a.title, coverageDistricts: a.coverage_districts, lat: a.lat, lng: a.lng } : { coverageDistricts: [] };
  }
  return out;
}

function coords(o) {
  const lat = num(o.lat, { min: -90, max: 90, name: "Latitude" });
  const lng = num(o.lng, { min: -180, max: 180, name: "Longitude" });
  if ((lat === null) !== (lng === null)) throw new HttpError(400, "Enter both latitude and longitude, or leave both empty");
  return { lat, lng };
}

export default api(
  {
    "GET profile": { auth: "any", fn: async ({ user }) => profile(user) },

    "PUT profile": {
      auth: "any",
      fn: async ({ body, user, ip }) => {
        const fullName = str(body.fullName ?? user.full_name, 120, { required: true, name: "Full name", min: 2 });
        const phone = str(body.phone ?? user.phone, 30, { name: "Phone" }) || null;
        const district = str(body.district ?? user.district, 60, { name: "District" }) || null;
        const sector = str(body.sector ?? user.sector, 60, { name: "Sector" }) || null;
        const emailNotifications = body.emailNotifications === undefined ? user.email_notifications : !!body.emailNotifications;
        const lang = body.preferredLang === "rw" ? "rw" : body.preferredLang === "en" ? "en" : user.preferred_lang;
        await tx(async (c) => {
          await c.query(
            `UPDATE users SET full_name=$2, phone=$3, district=$4, sector=$5, email_notifications=$6, preferred_lang=$7, updated_at=now() WHERE id=$1`,
            [user.id, fullName, phone, district, sector, emailNotifications, lang]
          );
          if (user.role === "farmer" && body.farm) {
            const f = body.farm;
            const { lat, lng } = coords(f);
            const size = num(f.farmSizeHa, { min: 0, max: 100000, name: "Farm size" });
            await c.query(
              `INSERT INTO farmer_profiles (user_id, farm_name, village, farm_size_ha, lat, lng, updated_at) VALUES ($1,$2,$3,$4,$5,$6, now())
               ON CONFLICT (user_id) DO UPDATE SET farm_name=$2, village=$3, farm_size_ha=$4, lat=$5, lng=$6, updated_at=now()`,
              [user.id, str(f.farmName, 80, { name: "Farm name" }) || null, str(f.village, 80, { name: "Village" }) || null, size, lat, lng]
            );
          }
          if (user.role === "advisor" && body.advisor) {
            const a = body.advisor;
            const { lat, lng } = coords(a);
            await c.query(
              `INSERT INTO advisor_profiles (user_id, organization, title, coverage_districts, lat, lng, updated_at) VALUES ($1,$2,$3,$4,$5,$6, now())
               ON CONFLICT (user_id) DO UPDATE SET organization=$2, title=$3, coverage_districts=$4, lat=$5, lng=$6, updated_at=now()`,
              [user.id, str(a.organization, 120, { name: "Organisation" }) || null, str(a.title, 80, { name: "Title" }) || null, districtList(a.coverageDistricts), lat, lng]
            );
          }
        });
        await logActivity(user.id, "profile_updated", "user", user.id, null, ip);
        const fresh = await one(`SELECT ${USER_COLUMNS} FROM users WHERE id=$1`, [user.id]);
        return profile(fresh);
      },
    },

    "GET notifications": {
      auth: "any",
      fn: async ({ query: q, user }) => {
        const rows = await many(
          `SELECT id, type, title, body, link, read_at, created_at FROM notifications
            WHERE user_id=$1 ${q.unread === "1" ? "AND read_at IS NULL" : ""} ORDER BY created_at DESC LIMIT 60`,
          [user.id]
        );
        const unread = await one("SELECT COUNT(*)::int AS n FROM notifications WHERE user_id=$1 AND read_at IS NULL", [user.id]);
        return {
          unread: unread.n,
          notifications: rows.map((n) => ({ id: n.id, type: n.type, title: n.title, body: n.body, link: n.link, read: !!n.read_at, createdAt: n.created_at })),
        };
      },
    },

    "POST read": {
      auth: "any",
      fn: async ({ body, user }) => {
        if (body.all) {
          await query("UPDATE notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL", [user.id]);
        } else {
          const ids = (Array.isArray(body.ids) ? body.ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 200);
          if (ids.length) await query("UPDATE notifications SET read_at=now() WHERE user_id=$1 AND id = ANY($2) AND read_at IS NULL", [user.id, ids]);
        }
        return { ok: true };
      },
    },
  },
  { getUser }
);
