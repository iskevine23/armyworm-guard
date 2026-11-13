# ArmywormGuard v2

Fall armyworm (nkongwa) early warning for maize farmers in Rwanda and East Africa.
Anyone can photograph a maize leaf and get a basic AI check. Farmers with a free account get full
results, history, spread risk and help from agricultural advisors. When several farmers report
serious damage close together, the system raises an outbreak alert and emails advisors and administrators.

Static pages + Vercel serverless functions + PostgreSQL. No framework, no build step.

## What each person can do

| | Visitor | Farmer | Advisor | Administrator |
|---|---|---|---|---|
| Scan a leaf on the homepage | basic result (damage yes/no, stage, confidence) | full result | full result | full result |
| What the AI saw, what to do, spread risk | — | ✓ | ✓ | ✓ |
| Scan history (any phone), CSV export | — | own | area | all |
| Request advisor help, follow the conversation | — | ✓ | answers | all |
| Assistant (chat) | — | ✓ | ✓ | ✓ |
| Outbreak alerts: view, investigate, confirm, close | — | sees *confirmed* ones near the farm | ✓ | ✓ |
| Users, roles, suspend, delete, invites | — | — | — | ✓ |
| Thresholds, limits, email log + retry, activity log, CSV reports | — | — | — | ✓ |

Every rule is enforced on the server (`lib/access.js`, `lib/http.js`), not only hidden in the page.
Advisors see requests assigned to them, unassigned requests in their districts, farmer scans in their
districts, and every scan attached to a request or outbreak they can see.

## Emails (real delivery over SMTP)

| When | Who gets it |
|---|---|
| Farmer creates a help request | the assigned advisor (or all advisors covering the district) |
| Advisor replies / changes status / is assigned | the farmer / the advisor |
| Farmer replies or marks resolved | the advisor |
| Suspected outbreak raised automatically | advisors covering the district + all admins |
| Outbreak status changes | advisors covering the district + admins |
| Outbreak confirmed (and later closed) | farmers who reported it + farmers whose farm is inside the area |
| Account created by admin, password reset, welcome | that person |

Every email is written to `email_log` first, then sent. The log shows `sent` (with the server's message
id), `failed` (with the error), or `skipped` (the user turned emails off). Admins can retry failures.
Nothing is simulated: if email is not configured, sends are logged as failed and the admin overview
shows a red "Email not configured" warning. Users also get the same messages in the app (🔔).

## How outbreak detection works (`lib/outbreak.js`)

A scan **counts** when it is from an active **farmer** account, the AI found a qualifying stage
(default moderate or severe) with confidence ≥ 0.6, and it has a real location (phone GPS or the
saved farm location, never the Musanze fallback).

When **N different farmers** (default 3) have counting scans within **R km** (default 5) during the
last **D days** (default 7), a **suspected** alert is created. Repeat scans by one farmer always count
once (distinct accounts), and the alert centre uses one point per farmer, so one person scanning
many times cannot raise or move an alert. Later scans in the area join the open alert instead of
creating new ones. Scans already in an alert closed as resolved or false alarm do not count again.
A database lock prevents two simultaneous scans from creating duplicate alerts.

Statuses: `suspected` (automatic) → `investigating` → `confirmed` (needs a field note; only a
person can confirm) or `false_alarm` → `resolved`. Every change is kept in the alert's history.
Admins change N, R, D, stages and confidence in **Settings**.

## Project layout

```
index.html            public homepage: scanning only
login.html            log in / sign up / forgot / reset password
farmer.html           farmer dashboard     js/farmer.js
advisor.html          advisor dashboard    js/advisor.js
admin.html            admin dashboard      js/admin.js
dashboard.html        email links land here and open the right dashboard
js/ui.js              API calls, session, modals, toasts, tabs
js/scanner.js, js/result.js, js/home.js   photo handling and result display
js/threads.js, js/staff.js                help-request conversation, outbreaks, scan reports
js/i18n.js, js/store.js, js/nearby.js     unchanged in spirit: languages, location, nearby directory
api/auth.js           register, login, logout, me, forgot, reset, change-password
api/scans.js          scan (public basic / full), claim, list, get, delete, export
api/requests.js       help requests and replies
api/outbreaks.js      outbreak alerts
api/me.js             own profile, notifications
api/admin.js          users, settings, stats, health, emails, activity, reports
api/chat.js           assistant (logged in)       api/alert.js  send a result to own email/Telegram
api/predict-spread.js unchanged public calculation
lib/                  database, auth, mailer, outbreak engine, access rules, Gemini, validation
db/schema.sql         all tables (created automatically on first request, or `npm run migrate`)
scripts/              dev server, migrate, create-admin
tests/e2e.mjs         38 end-to-end checks against real Postgres + a real SMTP server
```

Vercel's Hobby plan allows 12 functions; this uses 9.

## Deploy on Vercel (step by step)

1. **Push** this folder to your GitHub repository (replace the old files; `.env` is ignored).
2. **Database**: Vercel → your project → *Storage* → *Create* → **Neon (Postgres)** → connect to the
   project. This adds `DATABASE_URL` automatically. (Or paste a Supabase/other Postgres URL yourself.)
3. **Email**: create an account with an SMTP provider and verify your sending domain or address.
   Brevo and Resend have free tiers; Gmail with an app password works for a small pilot.
4. **Environment variables**: Settings → Environment Variables. Add everything marked REQUIRED in
   `.env.example`: `JWT_SECRET`, `GEMINI_API_KEY`, `APP_URL`, `BOOTSTRAP_ADMIN_EMAIL`, and the
   `SMTP_*` + `EMAIL_FROM` values (or `GMAIL_*`). Keep `TELEGRAM_BOT_TOKEN` if you used it before.
5. **Redeploy** (Deployments → ⋯ → Redeploy). The tables are created on the first request.
6. Open the site → **Sign up** with the `BOOTSTRAP_ADMIN_EMAIL` address → you are the administrator.
   (Alternative: `npm run create-admin -- you@example.org "Your Name"` from your computer with
   `DATABASE_URL` in `.env`.)
7. Admin → **Overview**: all four checks should be green. **Emails** → *Send test email* to yourself.
8. Admin → **Users** → *Add user* for each advisor, with the districts they cover. They receive an
   email to choose their password.
9. Admin → **Settings**: set the outbreak threshold for your pilot.

Optional, after the first admin exists: remove `BOOTSTRAP_ADMIN_EMAIL` (it is ignored anyway once an admin exists).

## Troubleshooting: `password authentication failed for user "postgres"` (28P01)

This means the app reached your Postgres server but the password in `DATABASE_URL` is wrong.
It is a deployment setting, not an app bug — every request fails the same way until the
connection string matches the database. Fix it in this order:

1. **Get a fresh URL.** In Neon (Dashboard → your project → *Connect*) or Supabase
   (Project Settings → Database → *Connection pooling*, port 6543), copy the **pooled**
   connection string with the provider's copy button. Never retype the password: characters
   like `@ # / ? %` break the URL when typed by hand. On Supabase the pooler user must be
   `postgres.<project-ref>` — plain `postgres` is rejected.
2. **Reset the password if unsure.** Neon: *Roles → Reset password*. Supabase: *Database →
   Reset database password*. Then copy the new string again.
3. **Paste it into Vercel.** Settings → Environment Variables: set `DATABASE_URL` for
   **Production and Preview**. Delete any duplicate or stale `DATABASE_URL`/`POSTGRES_URL`
   that points at a different database — the app uses `DATABASE_URL` first, so a wrong
   hand-pasted value shadows the correct one from the Vercel/Neon integration.
4. **Redeploy.** Changing environment variables does nothing until you redeploy
   (Deployments → ⋯ → Redeploy). The server logs will then show
   `Database: using DATABASE_URL → host=… user=…` — check it names the right host/user.
5. **Verify before redeploying.** Put the same value in your local `.env` and run
   `npm run check-db` — it prints the target (never the password) and the exact fix for
   the error code it hits.

## Run locally

```bash
npm install
cp .env.example .env          # fill in DATABASE_URL, JWT_SECRET, GEMINI_API_KEY, email
npm run migrate
npm run dev                   # http://localhost:3000  (no Vercel account needed)
```

Tests (uses a throwaway database, which is wiped, a local SMTP server and a stand-in for the Gemini API):

```bash
TEST_DATABASE_URL=postgres://user:pass@localhost:5432/armyworm_test npm test
```

## Security notes

- Passwords: bcrypt. Sessions: signed JWT in an HttpOnly, SameSite=Lax, Secure cookie; the user is
  re-read from the database on each request, so suspensions, role changes and password changes
  take effect immediately (other devices are signed out).
- Cross-site requests are refused (JSON-only + Origin check). Inputs are validated and length-capped;
  all SQL is parameterised; the pages insert all text with `textContent`.
- Rate limits (stored in the database): login, sign-up, password reset, public scans per IP,
  scans and assistant questions per user. Admins can change the usage limits.
- No secret is ever sent to the browser. The old public `/api/detect` (anyone could spend your
  Gemini quota) and the open email relay in `/api/alert` were removed / locked to logged-in users.
- Visitors' unclaimed scans are deleted after 48 hours.

## Honest limits

- The leaf result is an AI estimate with no measured accuracy yet; outbreak alerts built on it are
  *suspected* until an advisor checks the field.
- Spread risk is still the rule-based heuristic, now fed with every farmer's reports instead of one phone.
- One person creating several accounts could still look like several farmers. Watch the Users
  list; email verification or phone (SMS) verification would close this gap.
- Scan history saved on phones by v1 stays on those phones; it is not imported.
- New Kinyarwanda text was written quickly. Ask a Kinyarwanda speaker and an agronomist to review
  `js/i18n.js`. Advisor and admin screens are English only.
- Photos and chat text go to Google Gemini; read the Gemini API terms before real farmers use it.
