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

function connectionString() {
  return process.env.DATABASE_URL || process.env.POSTGRES_URL || "";
}

function sslOption(url) {
  const mode = (process.env.DATABASE_SSL || "").toLowerCase();
  if (mode === "disable" || mode === "off") return false;
  if (mode === "no-verify") return { rejectUnauthorized: false };
  if (/sslmode=/.test(url)) return undefined; // let the connection string decide
  if (/@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url) || /host=\/|%2F/.test(url)) return false;
  return { rejectUnauthorized: true };
}

export function getPool() {
  if (pool) return pool;
  const url = connectionString();
  if (!url) {
    throw new HttpError(503, "The database is not configured. Set DATABASE_URL in the server environment variables.");
  }
  pool = new pg.Pool({
    connectionString: url,
    ssl: sslOption(url),
    max: Number(process.env.DATABASE_POOL_MAX || 3),
    idleTimeoutMillis: 10000,
    connectionTimeoutMillis: 8000,
  });
  pool.on("error", (err) => console.error("pg pool error:", err.message));
  return pool;
}

export function dbConfigured() {
  return !!connectionString();
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
  } finally {
    try { await c.query("SELECT pg_advisory_unlock(727001)"); } catch {}
    if (!client) c.release();
  }
}

export async function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      const r = await getPool().query("SELECT to_regclass('public.schema_meta') AS t");
      if (!r.rows[0].t) await migrate();
    })().catch((err) => {
      schemaReady = null;
      throw err;
    });
  }
  return schemaReady;
}

export async function query(text, params) {
  await ensureSchema();
  return getPool().query(text, params);
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
}

export async function closePool() {
  if (pool) { await pool.end(); pool = null; schemaReady = null; }
}
