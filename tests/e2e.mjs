// End-to-end test of the whole system against a real PostgreSQL database and a real SMTP server.
//
// It starts: a local SMTP server that records every email it receives, a stand-in for the Gemini
// HTTP API (so tests are repeatable and free), and the dev server. Then it drives the API like the
// browser does: public scan, registration, roles, help requests, replies, outbreak detection,
// permissions, settings, password reset and reports.
//
// Usage:  TEST_DATABASE_URL=postgres://user:pass@localhost:5432/armyworm_test npm test
// WARNING: the test database is wiped first. Never point it at production.
import http from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import pg from "pg";
import { SMTPServer } from "smtp-server";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DB = process.env.TEST_DATABASE_URL;
if (!DB) { console.error("Set TEST_DATABASE_URL (a throwaway database; it is wiped)."); process.exit(1); }
const PORT = 3100, SMTP_PORT = 2526, GEM_PORT = 4012;
const BASE = `http://127.0.0.1:${PORT}`;

/* ---------- SMTP sink ---------- */
const inbox = [];
const smtp = new SMTPServer({
  authOptional: true, disabledCommands: ["STARTTLS"], logger: false,
  onData(stream, session, cb) {
    let raw = "";
    stream.on("data", (c) => (raw += c));
    stream.on("end", () => {
      const to = session.envelope.rcptTo.map((r) => r.address.toLowerCase());
      const subject = (raw.match(/^Subject: (.*(?:\r?\n[ \t].*)*)/im) || [])[1]?.replace(/\r?\n[ \t]/g, " ") || "";
      inbox.push({ to, subject: decodeMime(subject), raw: raw.replace(/=\r?\n/g, "").replace(/=3D/g, "=") });
      cb();
    });
  },
});
function decodeMime(s) {
  return s.replace(/=\?utf-8\?Q\?(.*?)\?=/gi, (_, q) => decodeURIComponent(q.replace(/_/g, " ").replace(/=([0-9A-F]{2})/gi, "%$1")))
          .replace(/=\?utf-8\?B\?(.*?)\?=/gi, (_, b) => Buffer.from(b, "base64").toString("utf8"));
}
const mailsTo = (addr) => inbox.filter((m) => m.to.includes(addr.toLowerCase()));

/* ---------- Gemini stand-in: the "photo" text decides the answer ---------- */
const gemini = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const j = JSON.parse(body);
    const parts = j.contents?.[0]?.parts || [];
    const img = parts.find((p) => p.inline_data);
    let text;
    if (img) {
      const label = Buffer.from(img.inline_data.data, "base64").toString("utf8");
      const stage = ["severe", "moderate", "early"].find((s) => label.startsWith(s)) || "none";
      text = JSON.stringify({
        pestDetected: stage !== "none", confidence: stage === "none" ? 0.9 : 0.85, stage,
        affectedArea: stage === "none" ? "healthy leaf" : `${stage} window-pane damage in the whorl`,
        recommendation: stage === "none" ? "keep scouting weekly" : "hand-pick larvae and talk to your advisor",
      });
    } else {
      text = "Scout 20 plants in a W pattern and check the whorls.";
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }));
  });
});

/* ---------- HTTP client with a cookie jar per user ---------- */
class Client {
  constructor(name) { this.name = name; this.cookie = ""; }
  async call(method, url, body, headers = {}) {
    const res = await fetch(BASE + url, {
      method,
      headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(this.cookie ? { Cookie: this.cookie } : {}), ...headers },
      body: body !== undefined ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
    });
    const sc = res.headers.get("set-cookie");
    if (sc) { const v = sc.split(";")[0]; this.cookie = v.endsWith("=") ? "" : v; }
    const text = await res.text();
    let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data, headers: res.headers };
  }
  get(u) { return this.call("GET", u); }
  post(u, b = {}) { return this.call("POST", u, b); }
  put(u, b = {}) { return this.call("PUT", u, b); }
  del(u) { return this.call("DELETE", u); }
}
const img = (label) => Buffer.from(label + "-" + Math.random()).toString("base64");

let passed = 0;
async function step(name, fn) {
  try { await fn(); passed++; console.log("  ✓", name); }
  catch (err) { console.error("  ✗", name, "\n   ", err.message); throw err; }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function expect(r, status, msg) {
  assert.equal(r.status, status, `${msg || ""} expected HTTP ${status}, got ${r.status}: ${JSON.stringify(r.data).slice(0, 300)}`);
  return r.data;
}

/* ---------- run ---------- */
const pool = new pg.Pool({ connectionString: DB });
await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
await new Promise((r) => smtp.listen(SMTP_PORT, "127.0.0.1", r));
await new Promise((r) => gemini.listen(GEM_PORT, "127.0.0.1", r));
const server = spawn(process.execPath, [path.join(root, "scripts/dev-server.mjs")], {
  cwd: root,
  env: {
    ...process.env, PORT: String(PORT), DATABASE_URL: DB, JWT_SECRET: "test-secret-0123456789-0123456789-abcdef",
    GEMINI_API_KEY: "test", GEMINI_API_BASE: `http://127.0.0.1:${GEM_PORT}`, GEMINI_MODELS: "gemini-test",
    SMTP_HOST: "127.0.0.1", SMTP_PORT: String(SMTP_PORT), SMTP_SECURE: "false", SMTP_IGNORE_TLS: "true", SMTP_USER: "", SMTP_PASS: "",
    EMAIL_FROM: "ArmywormGuard <alerts@armywormguard.test>", APP_URL: BASE, BOOTSTRAP_ADMIN_EMAIL: "boss@test.rw",
    GMAIL_USER: "", GMAIL_APP_PASSWORD: "",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (d) => (serverLog += d));
server.stderr.on("data", (d) => (serverLog += d));
for (let i = 0; i < 50 && !serverLog.includes("dev server"); i++) await wait(100);

const anon = new Client("visitor"), admin = new Client("admin"), f1 = new Client("f1"), f2 = new Client("f2"), f3 = new Client("f3"), adv = new Client("advisor"), adv2 = new Client("advisor2");
const X = { lat: -1.4995, lng: 29.6335 }; // Musanze
let anonScan, advisorId, adv2Id, requestId, f1ScanId, alertId;

try {
  console.log("Public homepage scanning");
  await step("visitor gets the BASIC result only", async () => {
    const d = expect(await anon.post("/api/scans", { image: img("severe"), mediaType: "image/jpeg", lang: "en" }), 200);
    assert.equal(d.basic, true); assert.equal(d.stage, "severe"); assert.equal(d.pestDetected, true);
    assert.equal(d.affectedArea, undefined); assert.equal(d.recommendation, undefined); assert.equal(d.spread, undefined);
    assert.ok(d.claimToken && d.scanId);
    anonScan = d;
  });
  await step("visitor cannot list scans, chat, or request help", async () => {
    expect(await anon.get("/api/scans?action=list"), 401);
    expect(await anon.post("/api/chat", { messages: [{ role: "user", text: "hi" }] }), 401);
    expect(await anon.post("/api/requests?action=create", { subject: "help", message: "help me" }), 401);
  });
  await step("cross-site and non-JSON posts are refused", async () => {
    expect(await anon.call("POST", "/api/auth?action=login", "email=a", { "Content-Type": "application/x-www-form-urlencoded" }), 415);
    expect(await anon.call("POST", "/api/auth?action=login", { email: "a@b.c", password: "x" }, { Origin: "https://evil.example" }), 403);
  });

  console.log("Accounts and roles");
  await step("BOOTSTRAP_ADMIN_EMAIL registers as the first administrator", async () => {
    const d = expect(await admin.post("/api/auth?action=register", { fullName: "Boss Admin", email: "boss@test.rw", password: "AdminPass123" }), 201);
    assert.equal(d.user.role, "admin");
  });
  await step("farmers register (role is always farmer) and get a real welcome email", async () => {
    const d = expect(await f1.post("/api/auth?action=register", { fullName: "Farmer One", email: "f1@test.rw", password: "FarmPass123", district: "Musanze", sector: "Muhoza", role: "admin" }), 201);
    assert.equal(d.user.role, "farmer");
    expect(await f2.post("/api/auth?action=register", { fullName: "Farmer Two", email: "f2@test.rw", password: "FarmPass123", district: "Musanze" }), 201);
    expect(await f3.post("/api/auth?action=register", { fullName: "Farmer Three", email: "f3@test.rw", password: "FarmPass123", district: "Musanze" }), 201);
    await wait(200);
    assert.ok(mailsTo("f1@test.rw").some((m) => /Welcome/.test(m.subject)), "welcome email delivered");
  });
  await step("duplicate email, weak password and bad email are rejected", async () => {
    expect(await new Client().post("/api/auth?action=register", { fullName: "X Y", email: "F1@test.rw", password: "FarmPass123" }), 409);
    expect(await new Client().post("/api/auth?action=register", { fullName: "X Y", email: "x@test.rw", password: "short" }), 400);
    expect(await new Client().post("/api/auth?action=register", { fullName: "X Y", email: "not-an-email", password: "FarmPass123" }), 400);
  });
  await step("a second bootstrap attempt does not create another admin", async () => {
    const c = new Client();
    expect(await c.post("/api/auth?action=register", { fullName: "Boss Two", email: "boss@test.rw", password: "AdminPass123" }), 409);
  });
  await step("wrong password -> 401, right one -> logged in", async () => {
    const c = new Client();
    expect(await c.post("/api/auth?action=login", { email: "f1@test.rw", password: "WrongPass1" }), 401);
    const d = expect(await c.post("/api/auth?action=login", { email: "f1@test.rw", password: "FarmPass123" }), 200);
    assert.equal(d.user.email, "f1@test.rw");
  });
  await step("admin creates an advisor; the invite email arrives; the advisor sets a password", async () => {
    const d = expect(await admin.post("/api/admin?action=user-create", { fullName: "Agnes Advisor", email: "advisor@test.rw", role: "advisor", phone: "0788000000", coverageDistricts: "Musanze, Burera" }), 201);
    advisorId = d.user.id;
    assert.equal(d.setupLink, null, "email worked, so no fallback link is exposed");
    await wait(200);
    const mail = mailsTo("advisor@test.rw").find((m) => /account/i.test(m.subject));
    assert.ok(mail, "invite email delivered");
    const token = mail.raw.match(/#reset=([A-Za-z0-9_-]+)/)[1];
    expect(await adv.post("/api/auth?action=reset", { token, password: "AdvisorPass1" }), 200);
    expect(await new Client().post("/api/auth?action=reset", { token, password: "AdvisorPass1" }), 400, "reset links work once");
    const me = expect(await adv.get("/api/auth?action=me"), 200);
    assert.equal(me.user.role, "advisor");
    const d2 = expect(await admin.post("/api/admin?action=user-create", { fullName: "Bosco Advisor", email: "advisor2@test.rw", role: "advisor", coverageDistricts: "Huye" }), 201);
    adv2Id = d2.user.id;
    await wait(100);
    const t2 = mailsTo("advisor2@test.rw")[0].raw.match(/#reset=([A-Za-z0-9_-]+)/)[1];
    expect(await adv2.post("/api/auth?action=reset", { token: t2, password: "AdvisorPass2" }), 200);
  });
  await step("role checks are enforced on the server", async () => {
    expect(await f1.get("/api/admin?action=users"), 403);
    expect(await adv.get("/api/admin?action=users"), 403);
    expect(await f1.get("/api/outbreaks?action=list"), 403);
    expect(await adv.post("/api/admin?action=user-update&id=" + advisorId, { role: "admin" }), 403);
    expect(await f1.put("/api/admin?action=settings", { outbreak: { min_farmers: 2 } }), 403);
  });

  console.log("Farmer: full results, history, help requests");
  await step("farmer saves farm location", async () => {
    const d = expect(await f1.put("/api/me?action=profile", { farm: { farmName: "Hill plot", lat: X.lat, lng: X.lng } }), 200);
    assert.equal(d.farm.lat, X.lat);
  });
  await step("after logging in, the visitor's scan is claimed and the full result appears", async () => {
    const d = expect(await f1.post("/api/scans?action=claim", { scanId: anonScan.scanId, claimToken: anonScan.claimToken, locSource: "gps", lat: X.lat, lng: X.lng }), 200);
    assert.equal(d.basic, false);
    assert.ok(d.scan.affectedArea && d.scan.recommendation);
    assert.ok(d.spread && typeof d.spread.riskScore === "number");
    f1ScanId = d.scan.id;
    expect(await f2.post("/api/scans?action=claim", { scanId: anonScan.scanId, claimToken: anonScan.claimToken }), 404, "cannot claim twice");
  });
  await step("farmers only see their own scans", async () => {
    const mine = expect(await f1.get("/api/scans?action=list"), 200);
    assert.equal(mine.scans.length, 1);
    expect(await f2.get("/api/scans?action=get&id=" + f1ScanId), 404);
    const theirs = expect(await f2.get("/api/scans?action=list"), 200);
    assert.equal(theirs.scans.length, 0);
  });
  await step("farmer requests help -> assigned advisor gets a real email", async () => {
    const before = mailsTo("advisor@test.rw").length;
    const d = expect(await f1.post("/api/requests?action=create", { subject: "Holes in my maize", message: "Many leaves have holes and sawdust.", scanId: f1ScanId, priority: "high" }), 201);
    requestId = d.request.id;
    assert.equal(d.request.advisor.id, advisorId, "auto-assigned to the advisor covering Musanze");
    assert.equal(d.email.sent, 1);
    await wait(150);
    const got = mailsTo("advisor@test.rw").slice(before);
    assert.ok(got.some((m) => /Farmer needs help/.test(m.subject)), "advisor email delivered");
    assert.equal(mailsTo("advisor2@test.rw").filter((m) => /Farmer needs help/.test(m.subject)).length, 0, "advisor for another district not emailed");
  });
  await step("other farmers and the other-district advisor cannot see the request", async () => {
    expect(await f2.get("/api/requests?action=get&id=" + requestId), 404);
    expect(await adv2.get("/api/requests?action=get&id=" + requestId), 404);
  });
  await step("advisor sees the case and the scan report, replies -> farmer gets an email", async () => {
    const list = expect(await adv.get("/api/requests?action=list"), 200);
    assert.ok(list.requests.some((r) => r.id === requestId));
    const det = expect(await adv.get("/api/requests?action=get&id=" + requestId), 200);
    assert.equal(det.scan.id, f1ScanId); assert.equal(det.request.farmer.phone, null);
    const before = mailsTo("f1@test.rw").length;
    const r = expect(await adv.post("/api/requests?action=reply&id=" + requestId, { body: "I will visit tomorrow. Meanwhile crush egg masses." }), 200);
    assert.equal(r.request.status, "in_progress");
    await wait(150);
    assert.ok(mailsTo("f1@test.rw").slice(before).some((m) => /advisor answered/i.test(m.subject)));
  });
  await step("advisor changes the status -> farmer is emailed; farmer sees the thread", async () => {
    const before = mailsTo("f1@test.rw").length;
    expect(await adv.post("/api/requests?action=status&id=" + requestId, { status: "resolved", note: "Visited, treated with Bt." }), 200);
    await wait(150);
    assert.ok(mailsTo("f1@test.rw").slice(before).some((m) => /Resolved/.test(m.subject)));
    const t = expect(await f1.get("/api/requests?action=get&id=" + requestId), 200);
    assert.ok(t.messages.some((m) => m.kind === "message" && /visit tomorrow/.test(m.body)));
    const n = expect(await f1.get("/api/me?action=notifications"), 200);
    assert.ok(n.unread >= 2);
  });
  await step("farmers cannot set advisor-only statuses", async () => {
    expect(await f1.post("/api/requests?action=status&id=" + requestId, { status: "in_progress" }), 403);
  });
  await step("assistant works for logged-in users", async () => {
    const d = expect(await f1.post("/api/chat", { messages: [{ role: "user", text: "How do I scout?" }] }), 200);
    assert.ok(d.reply.length > 5);
  });

  console.log("Automatic outbreak detection");
  const near = (km) => ({ lat: X.lat + km / 111, lng: X.lng });
  await step("repeated scans by ONE farmer never raise an alert", async () => {
    for (let i = 0; i < 3; i++) {
      const d = expect(await f1.post("/api/scans", { image: img("severe"), locSource: "gps", ...X }), 200);
      assert.equal(d.outbreak.action, "none");
      assert.equal(d.outbreak.qualifies, true);
    }
    const a = expect(await admin.get("/api/outbreaks?action=list"), 200);
    assert.equal(a.alerts.length, 0);
  });
  await step("healthy / early scans and scans without a real location do not count", async () => {
    const h = expect(await f2.post("/api/scans", { image: img("healthy"), locSource: "gps", ...near(1) }), 200);
    assert.equal(h.outbreak.qualifies, false);
    const e = expect(await f2.post("/api/scans", { image: img("early"), locSource: "gps", ...near(1) }), 200);
    assert.equal(e.outbreak.qualifies, false);
    const nl = expect(await f3.post("/api/scans", { image: img("severe"), locSource: "default", ...near(1) }), 200);
    assert.equal(nl.outbreak.qualifies, false);
  });
  await step("second farmer: still below the threshold (2 of 3)", async () => {
    const d = expect(await f2.post("/api/scans", { image: img("moderate"), locSource: "gps", ...near(1.2) }), 200);
    assert.equal(d.outbreak.action, "none");
    assert.equal(d.outbreak.farmersNearby, 2);
  });
  await step("a far-away farmer does not complete the cluster", async () => {
    const far = new Client();
    expect(await far.post("/api/auth?action=register", { fullName: "Far Farmer", email: "far@test.rw", password: "FarmPass123", district: "Huye" }), 201);
    const d = expect(await far.post("/api/scans", { image: img("severe"), locSource: "gps", lat: -2.6, lng: 29.74 }), 200);
    assert.equal(d.outbreak.action, "none");
  });
  await step("third independent farmer nearby -> SUSPECTED alert, advisors + admins emailed", async () => {
    const advBefore = mailsTo("advisor@test.rw").length, adminBefore = mailsTo("boss@test.rw").length;
    const d = expect(await f3.post("/api/scans", { image: img("severe"), locSource: "gps", ...near(2) }), 200);
    assert.equal(d.outbreak.action, "created");
    assert.equal(d.outbreak.alertStatus, "suspected");
    alertId = d.outbreak.alertId;
    await wait(200);
    assert.ok(mailsTo("advisor@test.rw").slice(advBefore).some((m) => /Suspected outbreak/.test(m.subject)), "advisor emailed");
    assert.ok(mailsTo("boss@test.rw").slice(adminBefore).some((m) => /Suspected outbreak/.test(m.subject)), "admin emailed");
    assert.equal(mailsTo("advisor2@test.rw").filter((m) => /Suspected outbreak/.test(m.subject)).length, 0, "other-district advisor not emailed");
    const det = expect(await adv.get("/api/outbreaks?action=get&id=" + alertId), 200);
    assert.equal(det.alert.farmerCount, 3);
    assert.ok(det.scans.length >= 5, "all qualifying scans in the cluster are linked");
    assert.equal(new Set(det.scans.map((s) => s.farmer.id)).size, 3);
  });
  await step("later scans join the open alert instead of creating a new one", async () => {
    const d = expect(await f1.post("/api/scans", { image: img("moderate"), locSource: "gps", ...near(0.5) }), 200);
    assert.equal(d.outbreak.action, "joined");
    assert.equal(d.outbreak.alertId, alertId);
    const list = expect(await admin.get("/api/outbreaks?action=list"), 200);
    assert.equal(list.alerts.length, 1);
  });
  await step("advisor can now see the outbreak scan reports of farmers in the alert", async () => {
    const s = expect(await adv.get("/api/scans?action=list&pest=1"), 200);
    assert.ok(s.scans.length >= 5);
  });
  await step("confirming requires a field note; confirming emails the farmers in the area", async () => {
    expect(await adv.post("/api/outbreaks?action=status&id=" + alertId, { status: "confirmed" }), 400);
    expect(await adv.post("/api/outbreaks?action=status&id=" + alertId, { status: "investigating", note: "Going to the site" }), 200);
    const fBefore = mailsTo("f2@test.rw").length;
    const d = expect(await adv.post("/api/outbreaks?action=status&id=" + alertId, { status: "confirmed", note: "Larvae found in 30% of plants." }), 200);
    assert.equal(d.alert.status, "confirmed");
    assert.equal(d.alert.confirmedBy.id, advisorId);
    await wait(200);
    assert.ok(mailsTo("f2@test.rw").slice(fBefore).some((m) => /outbreak confirmed/i.test(m.subject)));
    const near1 = expect(await f1.get("/api/outbreaks?action=nearby"), 200);
    assert.equal(near1.alerts.length, 1);
    const hist = expect(await admin.get("/api/outbreaks?action=get&id=" + alertId), 200);
    assert.ok(hist.updates.length >= 3);
  });
  await step("admin changes the threshold; invalid values are refused", async () => {
    expect(await admin.put("/api/admin?action=settings", { outbreak: { min_farmers: 1 } }), 400);
    expect(await admin.put("/api/admin?action=settings", { outbreak: { qualifying_stages: [] } }), 400);
    const d = expect(await admin.put("/api/admin?action=settings", { outbreak: { min_farmers: 4, radius_km: 3, window_days: 10 } }), 200);
    assert.equal(d.settings.outbreak.min_farmers, 4);
  });

  console.log("Administration");
  await step("admin sees every scan, request, email and activity", async () => {
    const s = expect(await admin.get("/api/admin?action=stats"), 200);
    assert.ok(s.scans.total >= 9);
    const e = expect(await admin.get("/api/admin?action=emails"), 200);
    assert.ok(e.emails.some((m) => m.status === "sent"));
    const a = expect(await admin.get("/api/admin?action=activity"), 200);
    assert.ok(a.activity.some((x) => x.action === "outbreak_status"));
    const h = expect(await admin.get("/api/admin?action=health"), 200);
    assert.equal(h.database, true); assert.equal(h.email, true);
    assert.equal(h.dbCode, null);
    // Health must stay reachable without a session: when the DB credentials break nobody can log in,
    // and this endpoint is how the operator finds out why.
    const pub = expect(await anon.get("/api/admin?action=health"), 200);
    assert.equal(pub.database, true);
    assert.equal(pub.dbTarget, undefined, "anonymous callers do not get infrastructure details");
    assert.equal(pub.dbHelp, undefined);
  });
  await step("CSV reports download", async () => {
    for (const type of ["scans", "requests", "outbreaks", "users", "districts", "emails"]) {
      const r = await admin.get("/api/admin?action=report&type=" + type);
      assert.equal(r.status, 200); assert.match(r.headers.get("content-type"), /text\/csv/);
    }
  });
  await step("admin test email is really delivered", async () => {
    expect(await admin.post("/api/admin?action=email-test", { to: "boss@test.rw" }), 200);
    await wait(100);
    assert.ok(mailsTo("boss@test.rw").some((m) => /test email/.test(m.subject)));
  });
  await step("suspending a user ends their session immediately", async () => {
    const f2id = (await f2.get("/api/auth?action=me")).data.user.id;
    expect(await admin.post("/api/admin?action=user-update&id=" + f2id, { status: "suspended" }), 200);
    const me = expect(await f2.get("/api/auth?action=me"), 200);
    assert.equal(me.user, null);
    expect(await new Client().post("/api/auth?action=login", { email: "f2@test.rw", password: "FarmPass123" }), 403);
  });
  await step("the last administrator cannot be demoted or deleted", async () => {
    const bossId = (await admin.get("/api/auth?action=me")).data.user.id;
    expect(await admin.post("/api/admin?action=user-update&id=" + bossId, { role: "farmer" }), 400);
    expect(await admin.del("/api/admin?action=user&id=" + bossId), 400);
  });
  await step("promoting a farmer to advisor changes their access", async () => {
    const f3id = (await f3.get("/api/auth?action=me")).data.user.id;
    expect(await admin.post("/api/admin?action=user-update&id=" + f3id, { role: "advisor", coverageDistricts: ["Musanze"] }), 200);
    expect(await f3.get("/api/auth?action=me"), 200); // old token is now invalid
    expect(await f3.get("/api/outbreaks?action=list"), 401);
    expect(await f3.post("/api/auth?action=login", { email: "f3@test.rw", password: "FarmPass123" }), 200);
    expect(await f3.get("/api/outbreaks?action=list"), 200);
    expect(await admin.post("/api/admin?action=user-update&id=" + f3id, { role: "farmer" }), 200);
  });

  console.log("Password reset and limits");
  await step("forgot password -> email -> new password works, old one does not", async () => {
    const before = mailsTo("f1@test.rw").length;
    expect(await new Client().post("/api/auth?action=forgot", { email: "f1@test.rw" }), 200);
    expect(await new Client().post("/api/auth?action=forgot", { email: "nobody@test.rw" }), 200, "same answer for unknown emails");
    await wait(150);
    const mail = mailsTo("f1@test.rw").slice(before).find((m) => /Reset/.test(m.subject));
    const token = mail.raw.match(/#reset=([A-Za-z0-9_-]+)/)[1];
    const c = new Client();
    expect(await c.post("/api/auth?action=reset", { token, password: "NewFarmPass9" }), 200);
    expect(await f1.get("/api/scans?action=list"), 401, "old sessions are signed out");
    expect(await new Client().post("/api/auth?action=login", { email: "f1@test.rw", password: "FarmPass123" }), 401);
    expect(await f1.post("/api/auth?action=login", { email: "f1@test.rw", password: "NewFarmPass9" }), 200);
  });
  await step("public scan limit per IP is enforced", async () => {
    expect(await admin.put("/api/admin?action=settings", { public_scan: { daily_limit_per_ip: 1 } }), 200);
    await wait(50);
    // the settings cache lives 30 s per server instance; restart is not needed because the limit check reads fresh after update in this instance
    expect(await anon.post("/api/scans", { image: img("early") }), 429);
  });
  await step("farmers can delete their own unlinked scans but not linked ones", async () => {
    const d = expect(await f1.post("/api/scans", { image: img("healthy"), locSource: "gps", lat: -1.9, lng: 30.06 }), 200);
    expect(await f1.del("/api/scans?id=" + d.scan.id), 200);
    expect(await f1.del("/api/scans?id=" + f1ScanId), 409);
  });
  await step("email failures are logged as failed, never pretended", async () => {
    await new Promise((r) => smtp.close(r));
    const r = await admin.post("/api/admin?action=email-test", { to: "boss@test.rw" });
    assert.equal(r.status, 502);
    const e = expect(await admin.get("/api/admin?action=emails&status=failed"), 200);
    assert.ok(e.emails.length >= 1 && e.emails[0].error);
  });

  console.log(`\nAll ${passed} checks passed. ${inbox.length} real emails were delivered over SMTP.`);
} catch (err) {
  console.error("\nServer log (tail):\n" + serverLog.split("\n").slice(-40).join("\n"));
  process.exitCode = 1;
} finally {
  server.kill();
  try { smtp.close(); } catch {}
  gemini.close();
  await pool.end();
}
