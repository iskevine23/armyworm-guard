// Local development server: serves the static site and runs api/*.js the way Vercel does
// (req.query, req.body, res.status().json()). No Vercel account needed.
//   npm run dev            -> http://localhost:3000
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadEnv } from "./env.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
loadEnv(root);
const PORT = Number(process.env.PORT || 3000);
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json",
  ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8",
};
const handlers = new Map();

async function loadHandler(name) {
  if (!handlers.has(name)) {
    const file = path.join(root, "api", name + ".js");
    if (!fs.existsSync(file)) return null;
    handlers.set(name, (await import(pathToFileURL(file).href)).default);
  }
  return handlers.get(name);
}

function vercelify(req, res, url) {
  req.query = Object.fromEntries(url.searchParams);
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (obj) => {
    if (!res.getHeader("Content-Type")) res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(obj));
    return res;
  };
  res.send = (b) => { res.end(typeof b === "string" || Buffer.isBuffer(b) ? b : JSON.stringify(b)); return res; };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    const m = url.pathname.match(/^\/api\/([a-z0-9-]+)\/?$/);
    if (m) {
      const handler = await loadHandler(m[1]);
      if (!handler) { res.statusCode = 404; return res.end(JSON.stringify({ error: "Not found" })); }
      const chunks = [];
      let size = 0;
      for await (const c of req) {
        size += c.length;
        if (size > 4.5 * 1024 * 1024) { res.statusCode = 413; return res.end(JSON.stringify({ error: "Request body too large" })); }
        chunks.push(c);
      }
      const raw = Buffer.concat(chunks).toString("utf8");
      vercelify(req, res, url);
      if (raw && String(req.headers["content-type"] || "").includes("application/json")) {
        try { req.body = JSON.parse(raw); } catch { return res.status(400).json({ error: "Invalid JSON" }); }
      } else req.body = raw || undefined;
      return await handler(req, res);
    }
    let p = decodeURIComponent(url.pathname);
    if (p.endsWith("/")) p += "index.html";
    const file = path.join(root, p);
    if (!file.startsWith(root) || /\/(\.|node_modules|lib|db|scripts)/.test(p) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.statusCode = 404;
      return res.end("Not found");
    }
    res.setHeader("Content-Type", MIME[path.extname(file)] || "application/octet-stream");
    fs.createReadStream(file).pipe(res);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) { res.statusCode = 500; res.end(JSON.stringify({ error: "Dev server error: " + err.message })); }
  }
});

server.listen(PORT, () => console.log(`ArmywormGuard dev server on http://localhost:${PORT}`));
