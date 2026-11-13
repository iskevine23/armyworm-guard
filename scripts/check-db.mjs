// Diagnoses the database connection without starting the server.
//   npm run check-db
// Prints where the app will connect (never the password), tries SELECT 1, and — on failure —
// prints the exact steps to fix it. Run this after changing DATABASE_URL, before redeploying.
import { loadEnv } from "./env.mjs";
loadEnv();
const { getPool, describeConnection, connectionCandidates, dbFailure, dbConfigured, closePool } = await import("../lib/db.js");

const d = describeConnection();
console.log("Connection target (password hidden):");
console.log(`  source   : ${d.source || "(none — no DATABASE_URL / POSTGRES_URL / PG* set)"}`);
console.log(`  host     : ${d.host || "?"}`);
console.log(`  port     : ${d.port || "(default 5432)"}`);
console.log(`  user     : ${d.user || "?"}`);
console.log(`  database : ${d.database || "?"}`);
console.log(`  pooled   : ${d.pooled ? "yes" : "no (use the provider's pooled / -pooler URL for serverless)"}`);
if (d.parseError) console.log(`  WARNING  : ${d.parseError}`);

const candidates = connectionCandidates();
if (candidates.length > 1) {
  console.log("\nMore than one connection variable is set:");
  candidates.forEach((c, i) => console.log(`  ${i === 0 ? "USING  " : "IGNORED"} ${c.source} → host=${c.host || "?"} user=${c.user || "?"} db=${c.database || "?"}`));
  console.log("Delete the stale one in Vercel (Settings → Environment Variables), then redeploy.");
}

if (!dbConfigured()) {
  console.log("\n✗ No database configured. Set DATABASE_URL in .env (local) or in Vercel → Settings → Environment Variables (deployed).");
  process.exit(1);
}

try {
  const r = await getPool().query("SELECT 1 AS ok, current_user, current_database()");
  console.log(`\n✓ Connected as "${r.rows[0].current_user}" to database "${r.rows[0].current_database}".`);
  const s = await getPool().query("SELECT to_regclass('public.schema_meta') AS t");
  console.log(s.rows[0].t ? "✓ Tables exist (schema_meta found). The app is ready." : "○ Connected, but tables do not exist yet — they will be created on the first request (or run: npm run migrate).");
} catch (err) {
  console.log(`\n✗ Connection failed: ${err.message}${err.code ? ` [${err.code}]` : ""}`);
  const failure = dbFailure(err);
  if (failure) console.log(`\nWhat this means:\n${failure.help}`);
  console.log("\nChecklist:");
  console.log("  1. Open your provider (Neon / Supabase) and copy the POOLED connection string with its copy button — never retype the password.");
  console.log("  2. Vercel → Settings → Environment Variables: set DATABASE_URL for Production AND Preview, and delete any duplicate/stale DATABASE_URL or POSTGRES_URL that points elsewhere.");
  console.log("  3. Redeploy (Deployments → ⋯ → Redeploy). Changing env vars does not take effect until you redeploy.");
  console.log("  4. Run `npm run check-db` again with the same DATABASE_URL in your local .env to confirm before redeploying.");
  process.exitCode = 1;
} finally {
  await closePool().catch(() => {});
}
