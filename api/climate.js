// /api/climate — field conditions for a farm, built from NASA POWER (free, no API key).
//
//   GET ?action=crops              the supported crops (public: the homepage picker needs it)
//   GET ?action=field&crop=beans   rain, soil moisture, heat and disease risk for the caller's farm
//       &lat=&lng=                 optional: any point the caller may look at
//       &fresh=1                   skip the 12 h cache (useful after heavy rain)
//
// Farmers get their saved farm location. Advisors and admins may pass coordinates; advisors fall
// back to the location saved on their profile. Nothing here needs a satellite image download: it is
// one small JSON call to NASA per field per 12 hours, cached in Postgres so pages stay fast.
import { api, HttpError, num } from "../lib/http.js";
import { one } from "../lib/db.js";
import { getCrop, cropOptions, DEFAULT_CROP } from "../lib/crops.js";
import { getFieldClimate } from "../lib/climate.js";
import { rateLimit } from "../lib/system.js";
import { getUser } from "../lib/auth.js";

async function savedLocation(user) {
  if (user.role === "farmer") {
    const f = await one("SELECT lat, lng, primary_crops FROM farmer_profiles WHERE user_id=$1", [user.id]);
    return { lat: f?.lat ?? null, lng: f?.lng ?? null, crops: f?.primary_crops || [] };
  }
  if (user.role === "advisor") {
    const a = await one("SELECT lat, lng FROM advisor_profiles WHERE user_id=$1", [user.id]);
    return { lat: a?.lat ?? null, lng: a?.lng ?? null, crops: [] };
  }
  return { lat: null, lng: null, crops: [] };
}

export default api(
  {
    "GET crops": {
      auth: null,
      fn: async () => ({ crops: cropOptions(), defaultCrop: DEFAULT_CROP }),
    },

    "GET field": {
      auth: "any",
      fn: async ({ query: q, user }) => {
        // each new coordinate pair is a fresh upstream call, so cap it per account
        await rateLimit(`climate:${user.id}`, 120, 86400, "That is a lot of field-condition requests for one day. Please try again tomorrow.");
        const saved = await savedLocation(user);

        const qLat = num(q.lat, { min: -90, max: 90, name: "Latitude" });
        const qLng = num(q.lng, { min: -180, max: 180, name: "Longitude" });
        if ((qLat === null) !== (qLng === null)) throw new HttpError(400, "Send both latitude and longitude, or neither");

        let lat = qLat;
        let lng = qLng;
        if (lat === null) {
          if (typeof saved.lat !== "number" || typeof saved.lng !== "number") {
            throw new HttpError(400, user.role === "farmer"
              ? "Save your farm location first, then field conditions will appear here."
              : "Send latitude and longitude, or save a location on your profile.");
          }
          lat = saved.lat;
          lng = saved.lng;
        }

        // Default crop: what the farmer told us they grow, otherwise the crop of their last scan
        let crop = q.crop ? getCrop(q.crop).id : null;
        if (!crop) {
          const lastScan = await one(
            "SELECT crop FROM scans WHERE user_id=$1 ORDER BY created_at DESC LIMIT 1",
            [user.id]
          );
          crop = getCrop(saved.crops[0] || lastScan?.crop || DEFAULT_CROP).id;
        }

        const summary = await getFieldClimate({ lat, lng, crop, fresh: q.fresh === "1" });
        return summary;
      },
    },
  },
  { getUser }
);
