// Incremental migrations.
//
// db/schema.sql creates everything a FRESH database needs, and is idempotent. But an existing
// installation already has schema_meta, so ensureSchema() never re-runs schema.sql — without this
// file, new columns would only appear on brand-new deployments and every query touching them would
// fail with "column does not exist" on the live database.
//
// Rules:
//   - append only, never edit a released entry
//   - every statement must be idempotent anyway (IF NOT EXISTS), so a crashed run can be retried
//   - `version` must increase by exactly 1
//
// Applied automatically on the first API request after a deploy (and by `npm run migrate`).

export const MIGRATIONS = [
  {
    version: 2,
    what: "multi-crop support + NASA POWER field-condition cache",
    sql: `
      ALTER TABLE scans ADD COLUMN IF NOT EXISTS crop TEXT NOT NULL DEFAULT 'maize';
      ALTER TABLE scans ADD COLUMN IF NOT EXISTS pest_label TEXT;
      CREATE INDEX IF NOT EXISTS scans_crop_idx ON scans (crop, created_at DESC);

      ALTER TABLE farmer_profiles ADD COLUMN IF NOT EXISTS primary_crops TEXT[] NOT NULL DEFAULT '{maize}';

      ALTER TABLE outbreak_alerts ADD COLUMN IF NOT EXISTS crop TEXT NOT NULL DEFAULT 'maize';

      CREATE TABLE IF NOT EXISTS climate_cache (
        key        TEXT PRIMARY KEY,
        payload    JSONB NOT NULL,
        fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS climate_cache_fetched_idx ON climate_cache (fetched_at DESC);
    `,
  },
  {
    version: 3,
    what: "demo accounts follow the Umurima rename (older demos seeded *@armywormguard.test)",
    sql: `
      -- A database seeded before the rename still holds demo.persona@armywormguard.test, while
      -- lib/demo.js now looks for demo.persona@umurima.test. Without this, demo mode quietly creates
      -- a second, empty account and the dashboard shows no farm and no history. Drop such an empty
      -- duplicate first so the email rename cannot collide, then rename the seeded people.
      DELETE FROM users u
       WHERE lower(u.email) LIKE 'demo.%@umurima.test'
         AND NOT EXISTS (SELECT 1 FROM farmer_profiles f WHERE f.user_id = u.id)
         AND NOT EXISTS (SELECT 1 FROM advisor_profiles a WHERE a.user_id = u.id)
         AND NOT EXISTS (SELECT 1 FROM scans s WHERE s.user_id = u.id)
         AND NOT EXISTS (SELECT 1 FROM assistance_requests r WHERE r.farmer_id = u.id)
         AND EXISTS (SELECT 1 FROM users l WHERE lower(l.email) = lower(replace(u.email, '@umurima.test', '@armywormguard.test')));

      UPDATE users SET email = replace(email, '@armywormguard.test', '@umurima.test')
       WHERE lower(email) LIKE 'demo.%@armywormguard.test';
    `,
  },
  {
    version: 4,
    what: "nutrient deficiencies alongside pests (issue_type, nutrient, nutrient_confidence, nutrient_signs)",
    sql: `
      ALTER TABLE scans ADD COLUMN IF NOT EXISTS issue_type TEXT NOT NULL DEFAULT 'none';
      ALTER TABLE scans ADD COLUMN IF NOT EXISTS nutrient TEXT;
      ALTER TABLE scans ADD COLUMN IF NOT EXISTS nutrient_confidence REAL;
      ALTER TABLE scans ADD COLUMN IF NOT EXISTS nutrient_signs TEXT;

      -- older rows: a detection was a pest, no detection was nothing
      UPDATE scans SET issue_type = 'pest' WHERE issue_type = 'none' AND pest_detected;
      UPDATE scans SET issue_type = 'none' WHERE pest_detected = false AND nutrient IS NULL;

      CREATE INDEX IF NOT EXISTS scans_nutrient_idx ON scans (nutrient) WHERE nutrient IS NOT NULL;
    `,
  },
];

export const LATEST_VERSION = MIGRATIONS.reduce((n, m) => Math.max(n, m.version), 1);

// Applies every migration newer than the version recorded in schema_meta.
// The caller holds the advisory lock, so two cold starts cannot race.
export async function applyMigrations(client) {
  const r = await client.query("SELECT version FROM schema_meta WHERE id = 1");
  let current = Number(r.rows[0]?.version ?? 0);
  for (const m of [...MIGRATIONS].sort((a, b) => a.version - b.version)) {
    if (m.version <= current) continue;
    await client.query(m.sql);
    await client.query("UPDATE schema_meta SET version = $1, applied_at = now() WHERE id = 1", [m.version]);
    current = m.version;
    console.log(`Database migrated to version ${m.version}: ${m.what}`);
  }
  return current;
}
