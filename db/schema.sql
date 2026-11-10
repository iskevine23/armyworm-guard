-- ArmywormGuard database schema (PostgreSQL 13+; works on Neon, Supabase, Vercel Postgres, RDS, local)
-- Safe to run more than once: every statement is idempotent.
-- Run with:  npm run migrate      (or it runs automatically on the first API call)

CREATE TABLE IF NOT EXISTS users (
  id              BIGSERIAL PRIMARY KEY,
  email           TEXT NOT NULL,
  password_hash   TEXT NOT NULL,
  full_name       TEXT NOT NULL,
  phone           TEXT,
  role            TEXT NOT NULL DEFAULT 'farmer' CHECK (role IN ('farmer','advisor','admin')),
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  district        TEXT,
  sector          TEXT,
  token_version   INTEGER NOT NULL DEFAULT 0,      -- bump to log a user out everywhere
  email_notifications BOOLEAN NOT NULL DEFAULT TRUE,
  preferred_lang  TEXT NOT NULL DEFAULT 'en',
  created_by      BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at   TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx ON users (lower(email));
CREATE INDEX IF NOT EXISTS users_role_idx ON users (role, status);

CREATE TABLE IF NOT EXISTS farmer_profiles (
  user_id     BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  farm_name   TEXT,
  village     TEXT,
  farm_size_ha NUMERIC(8,2),
  lat         DOUBLE PRECISION,
  lng         DOUBLE PRECISION,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS advisor_profiles (
  user_id        BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  organization   TEXT,
  title          TEXT,
  coverage_districts TEXT[] NOT NULL DEFAULT '{}',  -- empty = covers every district
  lat            DOUBLE PRECISION,
  lng            DOUBLE PRECISION,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS scans (
  id              BIGSERIAL PRIMARY KEY,
  user_id         BIGINT REFERENCES users(id) ON DELETE CASCADE,  -- NULL = anonymous public scan
  claim_token_hash TEXT,                                          -- lets a visitor attach the scan after logging in
  pest_detected   BOOLEAN NOT NULL DEFAULT FALSE,
  stage           TEXT NOT NULL DEFAULT 'none' CHECK (stage IN ('none','early','moderate','severe')),
  confidence      REAL,
  affected_area   TEXT,
  recommendation  TEXT,
  risk_score      INTEGER,
  risk_level      TEXT,
  spread_km_week  REAL,
  lat             DOUBLE PRECISION,
  lng             DOUBLE PRECISION,
  loc_source      TEXT CHECK (loc_source IN ('gps','farm','default','none')),
  district        TEXT,
  sector          TEXT,
  thumb           TEXT,          -- small JPEG data URL (~5 KB)
  lang            TEXT,
  model           TEXT,
  qualifies_outbreak BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS scans_user_idx ON scans (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS scans_outbreak_idx ON scans (created_at) WHERE qualifies_outbreak;
CREATE INDEX IF NOT EXISTS scans_anon_idx ON scans (created_at) WHERE user_id IS NULL;

CREATE TABLE IF NOT EXISTS assistance_requests (
  id            BIGSERIAL PRIMARY KEY,
  farmer_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  advisor_id    BIGINT REFERENCES users(id) ON DELETE SET NULL,
  scan_id       BIGINT REFERENCES scans(id) ON DELETE SET NULL,
  subject       TEXT NOT NULL,
  message       TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','awaiting_farmer','resolved','closed')),
  priority      TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  district      TEXT,
  sector        TEXT,
  lat           DOUBLE PRECISION,
  lng           DOUBLE PRECISION,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS req_farmer_idx ON assistance_requests (farmer_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS req_advisor_idx ON assistance_requests (advisor_id, status);
CREATE INDEX IF NOT EXISTS req_status_idx ON assistance_requests (status, updated_at DESC);

CREATE TABLE IF NOT EXISTS request_messages (
  id          BIGSERIAL PRIMARY KEY,
  request_id  BIGINT NOT NULL REFERENCES assistance_requests(id) ON DELETE CASCADE,
  author_id   BIGINT REFERENCES users(id) ON DELETE SET NULL,
  body        TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'message' CHECK (kind IN ('message','status','system')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS reqmsg_req_idx ON request_messages (request_id, created_at);

CREATE TABLE IF NOT EXISTS outbreak_alerts (
  id              BIGSERIAL PRIMARY KEY,
  status          TEXT NOT NULL DEFAULT 'suspected'
                  CHECK (status IN ('suspected','investigating','confirmed','resolved','false_alarm')),
  center_lat      DOUBLE PRECISION NOT NULL,
  center_lng      DOUBLE PRECISION NOT NULL,
  radius_km       REAL NOT NULL,
  district        TEXT,
  sector          TEXT,
  farmer_count    INTEGER NOT NULL DEFAULT 0,
  scan_count      INTEGER NOT NULL DEFAULT 0,
  max_stage       TEXT,
  threshold_farmers INTEGER NOT NULL,
  window_days     INTEGER NOT NULL,
  first_report_at TIMESTAMPTZ NOT NULL,
  last_report_at  TIMESTAMPTZ NOT NULL,
  assigned_advisor_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  confirmed_by    BIGINT REFERENCES users(id) ON DELETE SET NULL,
  confirmed_at    TIMESTAMPTZ,
  closed_at       TIMESTAMPTZ,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS outbreak_status_idx ON outbreak_alerts (status, last_report_at DESC);

CREATE TABLE IF NOT EXISTS outbreak_alert_scans (
  alert_id  BIGINT NOT NULL REFERENCES outbreak_alerts(id) ON DELETE CASCADE,
  scan_id   BIGINT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  farmer_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  added_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (alert_id, scan_id)
);
CREATE INDEX IF NOT EXISTS oas_scan_idx ON outbreak_alert_scans (scan_id);

CREATE TABLE IF NOT EXISTS outbreak_updates (
  id          BIGSERIAL PRIMARY KEY,
  alert_id    BIGINT NOT NULL REFERENCES outbreak_alerts(id) ON DELETE CASCADE,
  user_id     BIGINT REFERENCES users(id) ON DELETE SET NULL,
  old_status  TEXT,
  new_status  TEXT,
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS outbreak_updates_idx ON outbreak_updates (alert_id, created_at);

CREATE TABLE IF NOT EXISTS notifications (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT,
  link        TEXT,
  read_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notif_user_idx ON notifications (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS email_log (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT REFERENCES users(id) ON DELETE SET NULL,
  to_email      TEXT NOT NULL,
  subject       TEXT NOT NULL,
  body_text     TEXT NOT NULL,
  body_html     TEXT,
  template      TEXT,
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed','skipped')),
  error         TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  provider_id   TEXT,
  related_type  TEXT,
  related_id    BIGINT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at       TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS email_log_status_idx ON email_log (status, created_at DESC);

CREATE TABLE IF NOT EXISTS activity_log (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT REFERENCES users(id) ON DELETE SET NULL,
  action      TEXT NOT NULL,
  entity_type TEXT,
  entity_id   BIGINT,
  details     JSONB,
  ip          TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS activity_created_idx ON activity_log (created_at DESC);

CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL,
  updated_by  BIGINT REFERENCES users(id) ON DELETE SET NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS password_resets (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rate_limits (
  key          TEXT PRIMARY KEY,
  window_start TIMESTAMPTZ NOT NULL,
  count        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_meta (
  id       INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  version  INTEGER NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO schema_meta (id, version) VALUES (1, 1) ON CONFLICT (id) DO NOTHING;
