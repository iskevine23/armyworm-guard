# ArmywormGuard

AI-powered detection, spread-risk estimation, and SMS alerting for fall armyworm
(*Spodoptera frugiperda*) in maize fields. Static frontend + Vercel serverless
functions — no framework, no build step.

## What's actually implemented vs. what's a stand-in

Being upfront about this so it's clear what's real and what needs work before
this is production-ready:

| Feature | Status |
|---|---|
| Photo upload + leaf damage classification | **Implemented** — calls Claude's vision model (`/api/detect`) with a fall-armyworm-specific prompt. Real AI classification, not a mock. |
| Spread-risk estimate | **Implemented as a heuristic**, not a trained ML model (`/api/predict-spread`). It scores risk from the distance, recency, and severity of other detections logged in the same browser session. Good enough for a working demo; would need real historical outbreak data and a proper spatio-temporal model to be trustworthy at scale. |
| SMS alert | **Implemented, but requires your own Twilio account.** Without `TWILIO_*` env vars set, `/api/alert` simulates the message and shows you what *would* have been sent, so the flow is demoable without paying for SMS. |
| Detection history / storage | **Session-only**, stored in the browser (`sessionStorage`). There is no database yet — refreshing the page or switching devices loses history. Fine for a prototype; you'll want Postgres/Supabase/Vercel KV before treating this as multi-user. |

## Setup

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Get an Anthropic API key** (required for detection)
   - https://console.anthropic.com/ → API Keys

3. **(Optional) Get Twilio credentials** (for real SMS instead of simulated)
   - https://www.twilio.com/ → Account SID, Auth Token, and a Twilio phone number

4. **Local env file**
   ```bash
   cp .env.example .env
   # fill in ANTHROPIC_API_KEY (and Twilio vars if you have them)
   ```

5. **Run locally** (needs the Vercel CLI: `npm i -g vercel`)
   ```bash
   vercel dev
   ```

## Deploying via GitHub + Vercel

```bash
git init
git add .
git commit -m "Initial commit: ArmywormGuard"
git branch -M main
git remote add origin https://github.com/<your-username>/<your-repo>.git
git push -u origin main
```

Then in Vercel:
1. **New Project** → import the GitHub repo
2. Framework preset: **Other** (no build step needed)
3. Add environment variables in **Project Settings → Environment Variables**:
   - `ANTHROPIC_API_KEY` (required)
   - `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` (optional)
4. Deploy — Vercel auto-detects `/api/*.js` as serverless functions and serves
   `index.html` statically.

Every push to `main` redeploys automatically once the repo is connected.

## How it works

1. **Scan** — user uploads/takes a leaf photo → `/api/detect` sends it to
   Claude with a fall-armyworm-specific prompt → returns whether the pest is
   detected, confidence, damage stage, and a recommendation.
2. **Predict** — the new detection plus any others logged this session are
   sent to `/api/predict-spread`, which scores nearby, recent, severe cases
   more heavily and returns a 0–100 risk score and an estimated weekly spread
   distance.
3. **Alert** — `/api/alert` sends (or simulates) an SMS with the stage, risk
   level, and recommended action to the farmer's phone.

## Next steps worth prioritizing

- Swap `sessionStorage` for a real database so detections persist across
  devices and farmers — this is what the spread-prediction accuracy depends on most.
- Replace the heuristic in `predict-spread.js` with a model trained on real
  historical outbreak/weather data once you have enough logged detections.
- Add farmer accounts / phone-number-based login instead of a single-session flow.
