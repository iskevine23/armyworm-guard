// /api/demo — only meaningful when DEMO_MODE=1 (a separate deployment with its own database).
//
//   GET ?action=switch&persona=advisor&next=advisor.html
//        sets the demo_persona cookie and redirects, so reviewers can move between the farmer,
//        advisor and administrator screens without a password
//   GET (no action)   current demo status for the browser
//
// When DEMO_MODE is not set this endpoint refuses everything, so deploying it costs nothing.

import { demoMode, personaOf, PERSONAS } from "../lib/demo.js";

const PAGES = { farmer: "farmer.html", advisor: "advisor.html", admin: "admin.html" };

function safeNext(next, persona) {
  const fallback = PAGES[persona] || "index.html";
  const n = String(next || "");
  // only same-site .html pages, never a URL that could send the visitor somewhere else
  return /^[a-z0-9-]+\.html(#[a-zA-Z0-9_-]*)?$/.test(n) ? n : fallback;
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!demoMode()) return res.status(404).json({ error: "Not found" });

  const url = new URL(req.url, "http://localhost");
  const action = url.searchParams.get("action") || "status";

  if (action === "switch") {
    const persona = String(url.searchParams.get("persona") || "farmer");
    if (!PERSONAS.includes(persona)) return res.status(400).json({ error: "Unknown persona" });
    const next = safeNext(url.searchParams.get("next"), persona);
    const secure = String(req.headers["x-forwarded-proto"] || "").includes("https") ? "; Secure" : "";
    res.setHeader("Set-Cookie", `demo_persona=${persona}; Path=/; Max-Age=86400; SameSite=Lax${secure}`);
    res.statusCode = 302;
    res.setHeader("Location", "/" + next);
    return res.end();
  }

  return res.status(200).json({
    demo: true,
    persona: personaOf(req),
    personas: PERSONAS.map((p) => ({ id: p, label: p[0].toUpperCase() + p.slice(1), page: PAGES[p] })),
    note: "Demo mode: authentication is off and no email is sent. Data in this deployment is seeded sample data.",
  });
}
