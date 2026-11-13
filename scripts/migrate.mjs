// Creates / updates the database tables.  Usage:  npm run migrate
import { loadEnv } from "./env.mjs";
loadEnv();
const { migrate, getPool, closePool, describeConnection, dbFailure } = await import("../lib/db.js");

const d = describeConnection();
console.log(`Connecting with ${d.source || "(no connection configured)"} → host=${d.host || "?"} user=${d.user || "?"} db=${d.database || "?"}`);

let client;
try {
  client = await getPool().connect();
} catch (err) {
  console.error(`\nCould not connect: ${err.message}${err.code ? ` [${err.code}]` : ""}`);
  const failure = dbFailure(err);
  if (failure) console.error(`\n${failure.help}`);
  process.exit(1);
}
try {
  await migrate(client);
  const r = await client.query("SELECT version FROM schema_meta");
  console.log("Database ready. Schema version", r.rows[0].version);
} catch (err) {
  console.error(`\nMigration failed: ${err.message}${err.code ? ` [${err.code}]` : ""}`);
  const failure = dbFailure(err);
  if (failure) console.error(`\n${failure.help}`);
  process.exitCode = 1;
} finally {
  client.release();
  await closePool();
}
