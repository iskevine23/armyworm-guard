// Demo mode: a public, no-login copy of ArmywormGuard for reviews and submissions.
//
// It is switched on with ONE environment variable (DEMO_MODE=1) on a SEPARATE Vercel project with
// its OWN database. Production never sets it. What it does:
//
//   - authentication is bypassed: every request acts as one of three seeded people
//     (farmer, advisor, admin), chosen with the demo_persona cookie
//   - the login / register / reset routes are refused, so no real account can be created
//   - email is queued as 'skipped' in email_log instead of being sent, so the demo can never use
//     the real Gmail/SMTP sender
//   - the database seeds itself the first time it is used (lib/demo.js seeds realistic data)
//
// The safety comes from the separate database, not from clever filtering: nothing a visitor does
// here can reach a real farmer's record.

const COOKIE = "demo_persona";
export const PERSONAS = ["farmer", "advisor", "admin"];

const PEOPLE = {
  farmer: { name: "Uwase Mukamana", role: "farmer", district: "Musanze", sector: "Muhoza", phone: "+250 788 000 101" },
  advisor: { name: "Eric Habimana", role: "advisor", district: "Musanze", sector: "Muhoza", phone: "+250 788 000 102" },
  admin: { name: "Demo Administrator", role: "admin", district: "Kigali", sector: "Nyarugenge", phone: "+250 788 000 103" },
};

export function demoMode() {
  return String(process.env.DEMO_MODE || "").trim() === "1";
}

export function demoEmail(persona) {
  const prefix = (process.env.DEMO_EMAIL_PREFIX || "demo").toLowerCase();
  const domain = (process.env.DEMO_EMAIL_DOMAIN || "armywormguard.test").toLowerCase();
  return `${prefix}.${persona}@${domain}`;
}

// Reads the persona from the request cookie. Unknown values fall back to 'farmer'.
export function personaOf(req) {
  const raw = String(req?.headers?.cookie || "");
  const m = raw.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([a-z]+)`));
  const p = m ? m[1] : "";
  return PERSONAS.includes(p) ? p : "farmer";
}

// Routes the demo refuses. Everything else works, because the demo has its own database.
export function demoRouteBlocked(method, urlPath, action) {
  if (urlPath !== "/api/auth") return null;
  if (method === "GET" && action === "me") return null;
  return "This is a demo: log in, sign up and password reset are switched off. You are already signed in as the demo " +
    "user — use the role switch at the top of the page to see the advisor and administrator screens.";
}

/* ---------------- the people ---------------- */

let cached = new Map(); // persona -> { user, at }

async function findUser(email) {
  const { one } = await import("./db.js");
  return one("SELECT * FROM users WHERE lower(email) = lower($1)", [email]);
}

async function ensureUser(persona) {
  const p = PEOPLE[persona];
  if (!p) throw new Error("Unknown demo persona: " + persona);
  const { one } = await import("./db.js");
  const email = demoEmail(persona);
  const existing = await findUser(email);
  if (existing) return existing;
  // password_hash is deliberately not a bcrypt hash: this account can never log in normally
  return one(
    `INSERT INTO users (email, password_hash, full_name, phone, role, status, district, sector, preferred_lang)
     VALUES ($1,$2,$3,$4,$5,'active',$6,$7,'en')
     ON CONFLICT (lower(email)) DO UPDATE SET full_name = EXCLUDED.full_name
     RETURNING *`,
    [email, "demo-account-cannot-log-in", p.name, p.phone, p.role, p.district, p.sector]
  );
}

// The row every demo request acts as. Seeds the demo database the first time it is called.
export async function demoUser(req) {
  const persona = personaOf(req);
  const hit = cached.get(persona);
  if (hit && Date.now() - hit.at < 60_000) return hit.user;
  await ensureDemoData();
  const user = await ensureUser(persona);
  cached.set(persona, { user, at: Date.now() });
  return user;
}

/* ---------------- seed data ---------------- */

let seeding = null; // dedupe concurrent cold starts inside one instance
export const SEED_LOCK = 727003;

export async function ensureDemoData() {
  if (seeding) return seeding;
  seeding = seedOnce().finally(() => { seeding = null; });
  return seeding;
}

async function seedOnce() {
  const { tx } = await import("./db.js");
  return tx(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock($1)", [SEED_LOCK]);
    const claim = await c.query(
      `INSERT INTO settings (key, value) VALUES ('demo_seeded', jsonb_build_object('at', now()))
       ON CONFLICT (key) DO NOTHING RETURNING key`
    );
    if (!claim.rowCount) return; // someone else already seeded this database

    const emails = {
      farmer: demoEmail("farmer"), advisor: demoEmail("advisor"), admin: demoEmail("admin"),
      far2: demoEmail("farmer2"), far3: demoEmail("farmer3"),
    };
    const people = [
      ["farmer", PEOPLE.farmer, emails.farmer],
      ["advisor", PEOPLE.advisor, emails.advisor],
      ["admin", PEOPLE.admin, emails.admin],
      ["far2", { name: "Jean Bosco Niyonzima", role: "farmer", district: "Musanze", sector: "Muhoza", phone: "+250 788 000 104" }, emails.far2],
      ["far3", { name: "Claudine Uwera", role: "farmer", district: "Burera", sector: "Butaro", phone: "+250 788 000 105" }, emails.far3],
    ];
    const ids = {};
    for (const [key, p, email] of people) {
      const r = await c.query(
        `INSERT INTO users (email, password_hash, full_name, phone, role, status, district, sector, preferred_lang)
         VALUES ($1,'demo-account-cannot-log-in',$2,$3,$4,'active',$5,$6,'en')
         ON CONFLICT (lower(email)) DO UPDATE SET full_name = users.full_name
         RETURNING id`,
        [email, p.name, p.phone, p.role, p.district, p.sector]
      );
      ids[key] = r.rows[0].id;
    }

    // Farms: the demo farmer is on a hillside above Musanze, so the NASA POWER card has real data.
    await c.query(
      `INSERT INTO farmer_profiles (user_id, farm_name, village, farm_size_ha, lat, lng, primary_crops)
       VALUES ($1,'Uwase plot, Muhoza','Kigombe',0.4,-1.4995,29.6335,'{maize,beans,potato}')
       ON CONFLICT (user_id) DO NOTHING`, [ids.farmer]
    );
    await c.query(
      `INSERT INTO farmer_profiles (user_id, farm_name, village, farm_size_ha, lat, lng, primary_crops)
       VALUES ($1,'Niyonzima plot','Rwaza',0.25,-1.5071,29.6242,'{maize,potato}')
       ON CONFLICT (user_id) DO NOTHING`, [ids.far2]
    );
    await c.query(
      `INSERT INTO farmer_profiles (user_id, farm_name, village, farm_size_ha, lat, lng, primary_crops)
       VALUES ($1,'Uwera plot, Butaro','Nyamicucu',0.6,-1.4004,29.8286,'{maize,beans}')
       ON CONFLICT (user_id) DO NOTHING`, [ids.far3]
    );
    await c.query(
      `INSERT INTO advisor_profiles (user_id, organization, title, coverage_districts, lat, lng)
       VALUES ($1,'RAB — Musanze','District agronomist','{Musanze,Burera}',-1.4991,29.6341)
       ON CONFLICT (user_id) DO NOTHING`, [ids.advisor]
    );

    // Scans: spread over the last three weeks, three crops, one cluster around Muhoza.
    const scans = [
      ["farmer", 1, "maize", "fall armyworm", "severe", 0.91, 4, true],
      ["farmer", 3, "beans", "bean rust", "moderate", 0.78, 3, false],
      ["farmer", 6, "maize", "fall armyworm", "moderate", 0.84, 2, true],
      ["farmer", 8, "potato", "late blight", "early", 0.66, 2, false],
      ["farmer", 11, "maize", "none", "none", 0.88, 1, false],
      ["farmer", 14, "beans", "none", "none", 0.81, 1, false],
      ["farmer", 18, "potato", "late blight", "moderate", 0.73, 2, false],
      ["far2", 2, "maize", "fall armyworm", "severe", 0.89, 4, true],
      ["far2", 9, "potato", "late blight", "early", 0.71, 2, false],
      ["far2", 16, "maize", "fall armyworm", "moderate", 0.8, 3, true],
      ["far3", 5, "maize", "fall armyworm", "moderate", 0.82, 3, false],
      ["far3", 12, "beans", "bean anthracnose", "early", 0.69, 2, false],
      ["far3", 20, "maize", "none", "none", 0.9, 1, false],
    ];
    const risk = { none: [6, "low"], early: [28, "low"], moderate: [61, "high"], severe: [84, "critical"] };
    const scanIds = [];
    for (const [who, days, crop, pest, stage, conf, km, qualifies] of scans) {
      const [score, level] = risk[stage];
      const loc = {
        farmer: [-1.4995, 29.6335, "Musanze", "Muhoza"],
        far2: [-1.5071, 29.6242, "Musanze", "Muhoza"],
        far3: [-1.4004, 29.8286, "Burera", "Butaro"],
      }[who];
      const r = await c.query(
        `INSERT INTO scans (user_id, crop, pest_label, pest_detected, stage, confidence, affected_area, recommendation,
                risk_score, risk_level, spread_km_week, lat, lng, loc_source, district, sector, lang, model,
                qualifies_outbreak, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'farm',$14,$15,'en','gemini-demo',$16, now() - make_interval(days => $17))
         RETURNING id`,
        [ids[who], crop, pest, stage !== "none", stage, conf,
          demoArea(crop, stage), demoAdvice(crop, stage, pest),
          score, level, km, loc[0], loc[1], loc[2], loc[3], qualifies, days]
      );
      scanIds.push({ id: r.rows[0].id, who, qualifies, days, district: loc[2], sector: loc[3], lat: loc[0], lng: loc[1] });
    }

    // One confirmed outbreak around Muhoza, with the qualifying scans linked to it
    const cluster = scanIds.filter((s) => s.qualifies && s.district === "Musanze");
    const alert = await c.query(
      `INSERT INTO outbreak_alerts (status, crop, center_lat, center_lng, radius_km, district, sector, farmer_count, scan_count,
              max_stage, threshold_farmers, window_days, first_report_at, last_report_at, assigned_advisor_id, confirmed_by,
              confirmed_at, notes)
       VALUES ('confirmed','maize',-1.5032,29.6291,5,'Musanze','Muhoza',$1,$2,'severe',3,7,
              now() - interval '4 days', now() - interval '1 day', $3, $3, now() - interval '1 day',
              'Confirmed in the field: armyworm larvae found on 6 of 20 plants in Muhoza. Farmers advised to scout twice a week.')
       RETURNING id`,
      [cluster.length, cluster.length, ids.advisor]
    );
    const alertId = alert.rows[0].id;
    for (const s of cluster) {
      await c.query("INSERT INTO outbreak_alert_scans (alert_id, scan_id, farmer_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
        [alertId, s.id, ids[s.who]]);
    }
    await c.query(
      `INSERT INTO outbreak_updates (alert_id, old_status, new_status, note, created_at)
       VALUES ($1,'suspected','investigating','Advisor assigned and travelling to the sector.', now() - interval '3 days'),
              ($1,'investigating','confirmed','Confirmed in the field: larvae on 6 of 20 plants.', now() - interval '1 day')`,
      [alertId]
    );

    // Two support conversations, one still open
    const req1 = await c.query(
      `INSERT INTO assistance_requests (farmer_id, advisor_id, scan_id, subject, message, status, priority, district, sector, lat, lng, created_at, updated_at)
       VALUES ($1,$2,$3,'Armyworm in my maize after the rain','I found holes and droppings in the whorls yesterday. Please advise.',
               'open','high','Musanze','Muhoza',-1.4995,29.6335, now() - interval '2 days', now() - interval '2 days')
       RETURNING id`,
      [ids.farmer, ids.advisor, scanIds[0].id]
    );
    const req2 = await c.query(
      `INSERT INTO assistance_requests (farmer_id, advisor_id, subject, message, status, priority, district, sector, lat, lng, created_at, updated_at)
       VALUES ($1,$2,'Brown spots on my potato leaves','The lower leaves have dark patches after the wet week.',
               'in_progress','normal','Musanze','Muhoza',-1.4995,29.6335, now() - interval '5 days', now() - interval '1 day')
       RETURNING id`,
      [ids.farmer, ids.advisor]
    );
    const r1 = req1.rows[0].id, r2 = req2.rows[0].id;
    await c.query(
      `INSERT INTO request_messages (request_id, author_id, body, kind, created_at) VALUES
         ($1,$2,'I found holes and droppings in the whorls yesterday. Please advise.','message', now() - interval '2 days'),
         ($1,$3,'Thank you for the photo. Hand-pick the larvae in the whorls and avoid spraying in the heat of the day. I will visit on Thursday.','message', now() - interval '1 day')`,
      [r1, ids.farmer, ids.advisor]
    );
    await c.query(
      `INSERT INTO request_messages (request_id, author_id, body, kind, created_at) VALUES
         ($1,$2,'The lower leaves have dark patches after the wet week.','message', now() - interval '5 days'),
         ($1,$3,'That looks like late blight. Remove and bury the affected leaves and keep the rows apart so air moves.','message', now() - interval '4 days'),
         ($1,$3,'Status changed to in progress','status', now() - interval '1 day')`,
      [r2, ids.farmer, ids.advisor]
    );

    await c.query(
      `INSERT INTO notifications (user_id, type, title, body, link, created_at) VALUES
         ($1,'outbreak','Confirmed armyworm outbreak near your farm','An advisor confirmed armyworm in Muhoza, about 1 km from you. Scout your maize every 2–3 days.','/dashboard.html#outbreak-' || $2, now() - interval '1 day'),
         ($1,'request','Eric Habimana replied to your request','"Hand-pick the larvae in the whorls and avoid spraying in the heat of the day."','/farmer.html#requests-' || $3, now() - interval '1 day'),
         ($1,'weather','Dry spell ahead for your field','Only 6 mm of rain in 30 days where your field normally gets much more. Check the field conditions card.','/farmer.html#overview', now() - interval '6 hours')`,
      [ids.farmer, alertId, r1]
    );
    await c.query(
      `INSERT INTO notifications (user_id, type, title, body, link, created_at) VALUES
         ($1,'outbreak','Suspected outbreak confirmed','Armyworm confirmed in Muhoza — 3 farmers reported damage within 5 km.','/advisor.html#outbreaks', now() - interval '1 day')`,
      [ids.advisor]
    );
  });
}

function demoArea(crop, stage) {
  if (stage === "none") return "Healthy leaf, no damage visible";
  const areas = {
    maize: "Window-pane feeding and ragged holes in the whorl, frass visible",
    beans: "Dark sunken lesions on the leaves with a yellow halo",
    potato: "Water-soaked grey-green patches with white mould at the leaf edge",
  };
  return areas[crop] || "Damage visible on the leaf";
}

function demoAdvice(crop, stage, pest) {
  if (stage === "none") return "Keep scouting twice a week and keep the field weeded.";
  if (pest === "fall armyworm") return "Hand-pick larvae and egg masses from the whorls, then ask your advisor before spraying.";
  if (pest === "late blight") return "Remove and bury the affected leaves, widen the rows for airflow, and ask your advisor about a protectant spray.";
  if (pest === "bean rust") return "Remove badly affected leaves and avoid working in the field while it is wet.";
  return "Remove affected plant parts and ask your advisor for a local recommendation.";
}
