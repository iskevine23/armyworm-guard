// PostgreSQL connection shared by every API function.
// Reads DATABASE_URL (or POSTGRES_URL, which the Vercel/Neon integration sets).
// Use the *pooled* connection string from your provider for serverless (Neon: the "-pooler" host).
import pg from "pg";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { HttpError } from "./http.js";

// BIGINT ids and COUNT(*) come back as strings by default; they are always far below 2^53 here
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v))); // NUMERIC

let pool = null;
let schemaReady = null;
let poolLogged = false;

// Environment values pasted into the Vercel dashboard sometimes arrive with surrounding
// quotes or stray whitespace, which breaks the URL parse. Clean them here.
function cleanEnvValue(v) {
  if (v === undefined || v === null) return "";
  let s = String(v).trim();
  if ((s.startsWith('"') && s.endsWith('"') && s.length >= 2) || (s.startsWith("'") && s.endsWith("'") && s.length >= 2)) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

// Connection-string variables, in priority order. DATABASE_URL wins because it is the one
// documented in .env.example — but that also means a stale hand-pasted DATABASE_URL shadows
// a correct POSTGRES_URL from the Vercel/Neon integration. describeConnection() logs which
// one is actually in use so that mistake is visible in the server logs.
const URL_VARS = ["DATABASE_URL", "POSTGRES_URL", "POSTGRES_PRISMA_URL", "NEON_DATABASE_URL"];

function connectionSource() {
  for (const name of URL_VARS) {
    const url = cleanEnvValue(process.env[name]);
    if (url) return { source: name, url };
  }
  return { source: null, url: "" };
}

function connectionString() {
  return connectionSource().url;
}

// Some providers (Railway, Render, plain Docker) expose discrete PG* variables instead of a URL.
function pgEnvConfig() {
  const host = cleanEnvValue(process.env.PGHOST);
  const user = cleanEnvValue(process.env.PGUSER);
  const password = process.env.PGPASSWORD || "";
  const database = cleanEnvValue(process.env.PGDATABASE);
  const port = cleanEnvValue(process.env.PGPORT);
  if (!host && !user && !database) return null;
  return { host: host || undefined, user: user || undefined, password: password || undefined, database: database || undefined, port: port ? Number(port) : undefined };
}

// Set to true when the server's certificate chain is not trusted by this Node runtime
// (Supabase's pooler presents a self-signed chain). See withSslRetry().
let sslRelaxed = false;

function isLocalTarget(target) {
  return /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(target) || /host=(\/|%2F)/.test(target) || target === "localhost" || target === "127.0.0.1";
}

// Removes sslmode/ssl from a URL so an explicit `ssl` option is not silently overridden by
// pg-connection-string (pg treats sslmode=require as verify-full, which rejects Supabase's
// self-signed pooler chain even when DATABASE_SSL=no-verify).
function stripSslParams(url) {
  if (!url || !/^(postgres|postgresql):/i.test(url)) return url;
  try {
    const u = new URL(url);
    if (!u.searchParams.has("sslmode") && !u.searchParams.has("ssl")) return url;
    u.searchParams.delete("sslmode");
    u.searchParams.delete("ssl");
    return u.toString();
  } catch {
    return url;
  }
}

// Decides both the TLS options and the connection string to use with them.
function resolveSsl(rawUrl) {
  const url = rawUrl || "";
  const mode = (process.env.DATABASE_SSL || "").trim().toLowerCase();
  if (mode === "disable" || mode === "off" || mode === "false" || mode === "0") return { url: stripSslParams(url), ssl: false };
  const insecure = ["no-verify", "noverify", "insecure", "allow", "relaxed", "require"].includes(mode) || sslRelaxed;
  // No explicit setting: let the connection string decide, exactly as before.
  if (!mode && !sslRelaxed && /sslmode=/.test(url)) return { url, ssl: undefined };
  const target = url || cleanEnvValue(process.env.PGHOST) || "";
  if (isLocalTarget(target)) return { url: stripSslParams(url), ssl: insecure ? { rejectUnauthorized: false } : false };
  return { url: stripSslParams(url), ssl: insecure ? { rejectUnauthorized: false } : { rejectUnauthorized: true } };
}

// Sanitized description of where the app is trying to connect (never includes the password).
// Used in server logs, the admin health check and `npm run check-db`.
export function describeConnection() {
  const { source, url } = connectionSource();
  if (source && url) {
    try {
      const u = new URL(url);
      return {
        source,
        host: u.hostname || null,
        port: u.port ? Number(u.port) : null,
        user: u.username ? decodeURIComponent(u.username) : null,
        database: u.pathname ? decodeURIComponent(u.pathname.replace(/^\//, "")) : null,
        sslmode: u.searchParams.get("sslmode") || null,
        pooled: /-pooler|pooler|6543/.test(url),
      };
    } catch {
      return { source, host: null, port: null, user: null, database: null, sslmode: null, pooled: false, parseError: "DATABASE_URL is not a valid URL — check for quotes, spaces or a missing scheme (it must start with postgres:// or postgresql://)" };
    }
  }
  const pgEnv = pgEnvConfig();
  if (pgEnv) {
    return { source: "PG* variables", host: pgEnv.host || null, port: pgEnv.port || null, user: pgEnv.user || null, database: pgEnv.database || null, sslmode: null, pooled: false };
  }
  return { source: null, host: null, port: null, user: null, database: null, sslmode: null, pooled: false };
}

// Classifies a connection failure. Returns null for errors that are not connection problems
// (constraint violations, bad SQL, ...) so those pass through untouched.
//   client : one or two sentences, safe to show in the browser (never includes host/password)
//   help   : full operator checklist, goes to the server log and to `npm run check-db`
export function dbFailure(err) {
  // Unwrap errors we already translated so callers (health check, scripts) still get the code.
  if (err instanceof HttpError) {
    if (err.cause) return dbFailure(err.cause);
    if (err.extra?.code) return { code: err.extra.code, client: err.message, help: err.message };
    return null;
  }
  const code = err?.code || "";
  const msg = String(err?.message || "");
  const target = describeConnection();
  const where = target.source ? `${target.source} host=${target.host || "?"} user=${target.user || "?"} db=${target.database || "?"}` : "no connection configured";
  if (code === "28P01" || code === "28000" || /password authentication failed/i.test(msg)) {
    return {
      code: code || "28P01",
      client: "Database authentication failed (28P01): the database password the server is using is wrong, so nothing can be saved yet " +
        "— sign-up, login and every other action fail until it is fixed. An administrator must correct DATABASE_URL on the server and redeploy; " +
        "the deployment logs and the admin Health panel show which host and user it is trying to use.",
      help: `Database authentication failed for user "${target.user || "?"}" on ${target.host || "?"} (${where}).\n` +
        "The app reached the server, but the password is not accepted. Fix it like this:\n" +
        "  1. Copy a FRESH pooled connection string from your provider with its copy button — never retype the password.\n" +
        "     Neon: Dashboard → project → Connect (use the -pooler host). Supabase: Project Settings → Database → Connection pooling, port 6543.\n" +
        "  2. Not sure of the password? Reset it: Neon → Roles → Reset password; Supabase → Database → Reset database password.\n" +
        "  3. Vercel → Settings → Environment Variables: set DATABASE_URL for Production AND Preview.\n" +
        "     Delete any duplicate or stale DATABASE_URL / POSTGRES_URL that points at a different database — DATABASE_URL wins,\n" +
        "     so a stale hand-pasted value silently shadows the correct one set by the Vercel/Neon integration.\n" +
        "  4. Redeploy (Deployments → ⋯ → Redeploy). Env changes have no effect until the deployment is rebuilt.\n" +
        "  5. Verify locally first: put the same value in .env and run `npm run check-db`.\n" +
        "Supabase pooler note: the user must be postgres.<project-ref>, not plain postgres.",
    };
  }
  if (code === "3D000") {
    return {
      code,
      client: "Database not found (3D000): the database name in the server's DATABASE_URL does not exist. An administrator must fix DATABASE_URL and redeploy.",
      help: `Database "${target.database || "?"}" does not exist on ${target.host || "?"} (${where}). Copy the connection string from your provider again — the database name is part of it.`,
    };
  }
  if (code === "42501") {
    return {
      code,
      client: "Database permission denied (42501): the database user has no access to this database. An administrator must fix DATABASE_URL and redeploy.",
      help: `User "${target.user || "?"}" may not access "${target.database || "?"}" (${where}). Use the owner user from the provider's connection string.`,
    };
  }
  if (["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "ECONNRESET", "EHOSTUNREACH", "08006", "08001", "57P03"].includes(code)) {
    return {
      code,
      client: `The database is unreachable (${code}) right now, so this action could not be saved. Please try again in a minute; if it keeps failing, an administrator must check the database host.`,
      help: `Cannot reach the database (${code}) at ${target.host || "?"}:${target.port || "?"} (${where}).\n` +
        "  • Check the host/port in DATABASE_URL.\n" +
        "  • A paused database refuses connections — Neon's free tier pauses after inactivity; open the Neon dashboard to wake it.\n" +
        "  • For serverless hosting use the pooled (-pooler) host, not the direct one.\n" +
        "  • Missing hostname on Vercel usually means the env var was set only for another environment (Preview vs Production) — set it for both, then redeploy.",
    };
  }
  if (/ssl|certificate|tls/i.test(msg)) {
    return {
      code: code || "SSL",
      client: "The database connection could not be secured over TLS. An administrator must update the database settings and redeploy.",
      help: `SSL handshake failed (${where}): ${msg}\nFor Supabase's pooler set DATABASE_SSL=no-verify, or make sure the URL ends with ?sslmode=require.`,
    };
  }
  return null;
}

// Short, client-safe sentence for an HttpError; null when the error is not a DB connection issue.
export function friendlyDbError(err) {
  return dbFailure(err)?.client || null;
}

const loggedCodes = new Set();
function asDbHttpError(err) {
  if (err instanceof HttpError) return err;
  const failure = dbFailure(err);
  if (!failure) return err;
  // Log the full operator instructions once per code so the deployed function logs stay readable.
  if (!loggedCodes.has(failure.code)) {
    loggedCodes.add(failure.code);
    console.error(`Database connection problem [${failure.code}]: ${failure.help}`);
  }
  const wrapped = new HttpError(503, failure.client, { code: failure.code });
  wrapped.cause = err;
  return wrapped;
}

// True for "the server's certificate chain is not trusted" failures. Supabase's pooler serves a
// self-signed chain that newer Node.js runtimes reject, which would otherwise take the whole app
// down with an error the operator cannot act on from the app itself.
export function isCertError(err) {
  const code = err?.code || "";
  const msg = String(err?.message || "");
  return (
    [
      "SELF_SIGNED_CERT_IN_CHAIN",
      "DEPTH_ZERO_SELF_SIGNED_CERT",
      "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      "UNABLE_TO_GET_ISSUER_CERT",
      "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
      "CERT_UNTRUSTED",
      "ERR_TLS_CERT_ALTNAME_INVALID",
    ].includes(code) || /self[- ]signed certificate|certificate in chain|unable to verify the first certificate|certificate has expired/i.test(msg)
  );
}

function dropPool() {
  const old = pool;
  pool = null;
  schemaReady = null;
  poolLogged = false;
  if (old) { try { old.end().catch(() => {}); } catch {} }
}

// Runs fn once; if the only problem is an untrusted certificate chain, reconnect without
// certificate verification and try again. DATABASE_SSL=no-verify does the same thing up front;
// DATABASE_SSL=strict turns this recovery off.
async function withSslRetry(fn) {
  try {
    return await fn();
  } catch (err) {
    const strict = ["strict", "verify", "verify-full", "verify-ca"].includes(String(process.env.DATABASE_SSL || "").trim().toLowerCase());
    if (!isCertError(err) || sslRelaxed || strict) throw err;
    sslRelaxed = true;
    console.warn(
      "Database TLS: the server's certificate chain is not trusted by this Node.js runtime " +
        `(${err.code || err.message}). Reconnecting once without certificate verification. ` +
        "Make it explicit with DATABASE_SSL=no-verify, or set DATABASE_SSL=strict to refuse this."
    );
    dropPool();
    return await fn();
  }
}

export function getPool() {
  if (pool) return pool;
  const { source, url } = connectionSource();
  const pgEnv = url ? null : pgEnvConfig();
  if (!url && !pgEnv) {
    throw new HttpError(503, "The database is not configured. Set DATABASE_URL in the server environment variables.");
  }
  const { url: connectUrl, ssl } = resolveSsl(url);
  const base = {
    ssl,
    max: Number(process.env.DATABASE_POOL_MAX || 3),
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 8000,
  };
  pool = new pg.Pool(url ? { connectionString: connectUrl, ...base } : { ...pgEnv, ...base });
  pool.on("error", (err) => console.error("pg pool error:", err.message));
  if (!poolLogged) {
    poolLogged = true;
    const d = describeConnection();
    console.log(`Database: using ${d.source} → host=${d.host || "?"} port=${d.port || 5432} user=${d.user || "?"} db=${d.database || "?"}${d.pooled ? " (pooled)" : ""}`);
    warnAboutConflicts();
  }
  return pool;
}

export function dbConfigured() {
  return !!connectionString() || !!pgEnvConfig();
}

// Every configured connection target, so a stale variable that shadows a correct one is visible
// in the logs instead of silently winning. Example: a hand-pasted DATABASE_URL with an old
// password plus the correct POSTGRES_URL written by the Vercel/Neon integration.
export function connectionCandidates() {
  const out = [];
  for (const name of URL_VARS) {
    const url = cleanEnvValue(process.env[name]);
    if (!url) continue;
    try {
      const u = new URL(url);
      out.push({
        source: name,
        host: u.hostname || null,
        user: u.username ? decodeURIComponent(u.username) : null,
        database: u.pathname ? decodeURIComponent(u.pathname.replace(/^\//, "")) : null,
      });
    } catch {
      out.push({ source: name, host: null, user: null, database: null, invalid: true });
    }
  }
  return out;
}

function warnAboutConflicts() {
  const list = connectionCandidates();
  if (list.length < 2) return;
  const used = list[0];
  const others = list.slice(1);
  const differ = others.filter((o) => o.host !== used.host || o.database !== used.database || o.user !== used.user);
  if (!differ.length) return;
  console.warn(
    `Multiple database connection variables are set and they do not point at the same database:\n` +
      list.map((c, i) => `  ${i === 0 ? "USING   " : "IGNORED "} ${c.source} → host=${c.host || "?"} user=${c.user || "?"} db=${c.database || "?"}${c.invalid ? " (invalid URL!)" : ""}`).join("\n") +
      `\n${used.source} wins because it is checked first. If "${used.source}" is a stale value, delete it (Vercel → Settings → Environment Variables) and redeploy so the correct one is used.`
  );
}

function schemaSql() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "..", "db", "schema.sql"),
    path.join(process.cwd(), "db", "schema.sql"),
  ];
  for (const p of candidates) {
    try { return fs.readFileSync(p, "utf8"); } catch {}
  }
  throw new Error("db/schema.sql not found");
}

// Creates the tables on first use (idempotent). An advisory lock stops two cold starts racing.
export async function migrate(client) {
  const c = client || (await getPool().connect());
  try {
    await c.query("SELECT pg_advisory_lock(727001)");
    await c.query(schemaSql());
  } catch (err) {
    // Let a certificate failure reach withSslRetry() so it can reconnect once without verification.
    throw isCertError(err) ? err : asDbHttpError(err);
  } finally {
    try { await c.query("SELECT pg_advisory_unlock(727001)"); } catch {}
    if (!client) c.release();
  }
}

export async function ensureSchema() {
  if (!schemaReady) {
    schemaReady = withSslRetry(async () => {
      const r = await getPool().query("SELECT to_regclass('public.schema_meta') AS t");
      if (!r.rows[0].t) await migrate();
    }).catch((err) => {
      schemaReady = null;
      throw asDbHttpError(err);
    });
  }
  return schemaReady;
}

export async function query(text, params) {
  try {
    await ensureSchema();
    return await withSslRetry(() => getPool().query(text, params));
  } catch (err) {
    throw asDbHttpError(err);
  }
}

export async function one(text, params) {
  const r = await query(text, params);
  return r.rows[0] || null;
}

export async function many(text, params) {
  const r = await query(text, params);
  return r.rows;
}

// Runs fn(client) inside a transaction
export async function tx(fn) {
  await ensureSchema();
  try {
    return await withSslRetry(async () => {
      const client = await getPool().connect();
      try {
        await client.query("BEGIN");
        const result = await fn(client);
        await client.query("COMMIT");
        return result;
      } catch (err) {
        try { await client.query("ROLLBACK"); } catch {}
        throw err;
      } finally {
        client.release();
      }
    });
  } catch (err) {
    throw asDbHttpError(err);
  }
}

export async function closePool() {
  if (pool) { await pool.end(); pool = null; schemaReady = null; }
}
