/* Same-origin proxy for StudyBison batch detail JSON (Vercel serverless function).
   - Refuses to run unless STUDYBISON_AUTHORIZED=true is set (owner confirms StudyBison permits this integration).
   - Only fetches https://cw.studybison.in/api/batches/<allow-listed slug>.json. No client headers/cookies are forwarded,
     no login or restriction is bypassed, and an honest User-Agent is sent.
   - Cached at the CDN (s-maxage) and in memory; stale copy served if upstream fails. */
"use strict";

const UPSTREAM = "https://cw.studybison.in/api/batches/";
const ALLOWED = new Set(["maths-spl-36", "maths-spl-b35", "reasoning-special-42", "reasoning-spl-58", "english-special", "ctet-2025"]);
const TTL_MS = 30 * 60 * 1000;
const MAX_BYTES = 8 * 1024 * 1024;
const mem = new Map();

function send(res, status, body, cache) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", cache || "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.end(JSON.stringify(body));
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") return send(res, 405, { error: "method", message: "GET only." });
  if (String(process.env.STUDYBISON_AUTHORIZED || "").toLowerCase() !== "true") {
    return send(res, 503, { error: "disabled", message: "StudyBison integration is not authorized on this server (STUDYBISON_AUTHORIZED is not set)." });
  }
  const slug = String((req.query && req.query.slug) || "");
  if (!ALLOWED.has(slug)) return send(res, 404, { error: "not_found", message: "Unknown batch." });

  const hit = mem.get(slug);
  if (hit && Date.now() - hit.t < TTL_MS) return send(res, 200, hit.body, "public, s-maxage=1800, stale-while-revalidate=86400");

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 12000);
  try {
    const r = await fetch(UPSTREAM + slug + ".json", { signal: ctl.signal, redirect: "error", headers: { Accept: "application/json", "User-Agent": "CodexStudys-Integration/1.0 (+authorized proxy)" } });
    if (r.status === 429) throw Object.assign(new Error("rate"), { code: "rate_limited" });
    if (!r.ok) throw Object.assign(new Error("status " + r.status), { code: "upstream" });
    const len = Number(r.headers.get("content-length") || 0);
    if (len > MAX_BYTES) throw Object.assign(new Error("too large"), { code: "upstream" });
    const text = await r.text();
    if (text.length > MAX_BYTES) throw Object.assign(new Error("too large"), { code: "upstream" });
    let body;
    try { body = JSON.parse(text); } catch (e) { throw Object.assign(new Error("bad json"), { code: "invalid" }); }
    if (!body || !body.batch || !Array.isArray(body.batch.sections)) throw Object.assign(new Error("bad shape"), { code: "invalid" });
    mem.set(slug, { t: Date.now(), body });
    return send(res, 200, body, "public, s-maxage=1800, stale-while-revalidate=86400");
  } catch (e) {
    if (hit) return send(res, 200, hit.body, "public, s-maxage=60"); // stale-on-error
    const code = e.name === "AbortError" ? "timeout" : e.code || "upstream";
    const msg = { timeout: "StudyBison took too long to respond.", rate_limited: "StudyBison is rate limiting requests. Try again shortly.", invalid: "StudyBison returned unexpected data." }[code] || "StudyBison could not be reached.";
    return send(res, code === "timeout" ? 504 : 502, { error: code, message: msg });
  } finally { clearTimeout(timer); }
};
