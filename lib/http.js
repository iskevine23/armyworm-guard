// Small helpers shared by the API functions: errors, routing by ?action=, input validation.

export class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export function clientIp(req) {
  const xf = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return xf || req.headers["x-real-ip"] || req.socket?.remoteAddress || "unknown";
}

export function isHttps(req) {
  return String(req.headers["x-forwarded-proto"] || "").includes("https") || !!req.socket?.encrypted;
}

// Base URL used in email links. Set APP_URL in production so links never depend on request headers.
export function appUrl(req) {
  const env = (process.env.APP_URL || "").trim().replace(/\/+$/, "");
  if (env) return env;
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return "https://" + process.env.VERCEL_PROJECT_PRODUCTION_URL;
  const host = req?.headers?.host || "localhost:3000";
  return (req && isHttps(req) ? "https://" : "http://") + host;
}

// Blocks cross-site form posts: state-changing calls must be JSON and, when the browser says
// where it came from, come from this site.
function checkCsrf(req) {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return;
  const ct = String(req.headers["content-type"] || "");
  // DELETE cannot be sent cross-site without a CORS preflight, which this API never approves
  if (req.method !== "DELETE" && !ct.includes("application/json")) throw new HttpError(415, "Send JSON (Content-Type: application/json)");
  const origin = req.headers.origin;
  if (origin && origin !== "null") {
    let host = "";
    try { host = new URL(origin).host; } catch {}
    const allowed = [req.headers.host, req.headers["x-forwarded-host"]].filter(Boolean);
    if (!allowed.includes(host)) throw new HttpError(403, "Cross-site request blocked");
  }
}

// routes: { "GET list": { auth: null | "any" | ["admin", ...], fn: async (ctx) => data } }
// ctx = { req, res, body, query, user, ip }
export function api(routes, { getUser } = {}) {
  return async function handler(req, res) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    try {
      checkCsrf(req);
      const query = req.query || {};
      const action = String(query.action || "");
      const route = routes[`${req.method} ${action}`];
      if (!route) {
        const methods = Object.keys(routes).filter((k) => k.endsWith(" " + action)).map((k) => k.split(" ")[0]);
        if (methods.length) {
          res.setHeader("Allow", methods.join(", "));
          throw new HttpError(405, "Use " + methods.join(" or "));
        }
        throw new HttpError(404, "Unknown action");
      }
      let body = req.body;
      if (typeof body === "string") {
        try { body = JSON.parse(body); } catch { throw new HttpError(400, "Invalid JSON body"); }
      }
      if (body === undefined || body === null) body = {};
      if (typeof body !== "object" || Array.isArray(body)) throw new HttpError(400, "Body must be a JSON object");

      let user = null;
      if (route.auth !== undefined && route.auth !== false && getUser) {
        user = await getUser(req, res, { optional: route.auth === null });
        if (route.auth !== null) {
          if (!user) throw new HttpError(401, "Please log in");
          if (Array.isArray(route.auth) && !route.auth.includes(user.role)) {
            throw new HttpError(403, "You do not have permission to do this");
          }
        }
      }
      const data = await route.fn({ req, res, body, query, user, ip: clientIp(req) });
      if (res.headersSent || res.writableEnded) return;
      if (data && data.__raw) {
        res.statusCode = 200;
        res.setHeader("Content-Type", data.contentType);
        if (data.filename) res.setHeader("Content-Disposition", `attachment; filename="${data.filename}"`);
        res.end(data.body);
        return;
      }
      return res.status(data?.__status || 200).json(data ?? { ok: true });
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status >= 500) console.error(`[${req.method} ${req.url}]`, err);
      const message = err instanceof HttpError ? err.message : "Server error. Please try again.";
      if (res.headersSent) return;
      return res.status(status).json({ error: message, ...(err.extra || {}) });
    }
  };
}

/* ---------------- input validation ---------------- */

export function str(v, max = 500, { required = false, name = "field", min = 0 } = {}) {
  const s = v === undefined || v === null ? "" : String(v).trim();
  if (required && !s) throw new HttpError(400, `${name} is required`);
  if (s.length > max) throw new HttpError(400, `${name} is too long (max ${max} characters)`);
  if (s && s.length < min) throw new HttpError(400, `${name} must be at least ${min} characters`);
  return s;
}

export function optStr(v, max = 500, name) {
  const s = str(v, max, { name });
  return s || null;
}

export function email(v, { required = true } = {}) {
  const s = str(v, 200, { required, name: "Email" }).toLowerCase();
  if (s && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw new HttpError(400, "Enter a valid email address");
  return s;
}

export function num(v, { min = -Infinity, max = Infinity, name = "value", required = false } = {}) {
  if (v === undefined || v === null || v === "") {
    if (required) throw new HttpError(400, `${name} is required`);
    return null;
  }
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `${name} must be a number between ${min} and ${max}`);
  return n;
}

export function int(v, opts = {}) {
  const n = num(v, opts);
  return n === null ? null : Math.trunc(n);
}

export function oneOf(v, allowed, { name = "value", fallback } = {}) {
  if ((v === undefined || v === null || v === "") && fallback !== undefined) return fallback;
  if (!allowed.includes(v)) throw new HttpError(400, `${name} must be one of: ${allowed.join(", ")}`);
  return v;
}

export function id(v, name = "id") {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `Invalid ${name}`);
  return n;
}

export function paging(query, { max = 100, def = 25 } = {}) {
  const limit = Math.min(max, Math.max(1, Number(query.limit) || def));
  const offset = Math.max(0, Number(query.offset) || 0);
  return { limit, offset };
}
