// Creates / updates the database tables.  Usage:  npm run migrate
import { loadEnv } from "./env.mjs";
loadEnv();
const { migrate, getPool, closePool } = await import("../lib/db.js");
const client = await getPool().connect();
try {
  await migrate(client);
  const r = await client.query("SELECT version FROM schema_meta");
  console.log("Database ready. Schema version", r.rows[0].version);
} finally {
  client.release();
  await closePool();
}
