/* StudyBison batch loader + mapper for the CODEX STUDYS batch viewer.
   Loads a batch detail JSON ({batch:{name,sections:[{name,type,topics:[{name,lectures:[{id,title,url,type}]}]}]}}),
   validates it, and maps it to the viewer's internal shape:
   { id, name, by, about, credit, lectures:[{n,i:[[title,src,kind]]}], notes:[{n,i:[[title,url,kind?]]}], skipped } */
(function () {
  "use strict";
  const SLUG_RE = /^[a-z0-9-]{1,80}$/;
  const YT_RE = /(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=|shorts\/))([\w-]{11})/;

  class SBError extends Error {
    constructor(code, message) { super(message); this.code = code; }
  }

  let configPromise = null;
  function getConfig() {
    if (!configPromise) {
      configPromise = fetch("integrations.json", { cache: "no-cache" })
        .then((r) => (r.ok ? r.json() : {}))
        .then((j) => j.studybison || {})
        .catch(() => ({}));
    }
    return configPromise;
  }

  const httpsUrl = (u) => {
    if (typeof u !== "string") return null;
    try { const x = new URL(u.trim()); return x.protocol === "https:" ? x.href : null; } catch (e) { return null; }
  };

  /* item type -> where it goes and how it plays/opens */
  function classify(item) {
    const type = String(item.type || "").toLowerCase();
    const raw = typeof item.url === "string" ? item.url.trim() : "";
    const title = typeof item.title === "string" ? item.title.trim() : "";
    if (!title || !raw) return null;
    if (type === "youtube") {
      const m = raw.match(YT_RE) || (/^[\w-]{11}$/.test(raw) ? [null, raw] : null);
      if (m) return { tab: "lectures", row: [title, m[1], "y"] };
      const u = httpsUrl(raw);
      return u ? { tab: "lectures", row: [title, u, "p"] } : null;
    }
    const url = httpsUrl(raw);
    if (!url) return null;
    if (type === "hls" || /\.m3u8(\?|#|$)/i.test(url)) return { tab: "lectures", row: [title, url, "v"] };
    if (type === "pdf" || /\.pdf(\?|#|$)/i.test(url)) return { tab: "notes", row: [title, url] };
    if (/\.(mp4|webm)(\?|#|$)/i.test(url)) return { tab: "lectures", row: [title, url, "v"] };
    if (type === "link") return { tab: "notes", row: [title, url, "l"] }; // external resource: open in a new tab, never claimed as PDF/video
    return { tab: "notes", row: [title, url, "l"] };
  }

  /* validate + map. Throws SBError("invalid"|"empty") */
  function normalize(slug, payload) {
    const b = payload && payload.batch;
    if (!b || typeof b !== "object" || !Array.isArray(b.sections)) throw new SBError("invalid", "Unexpected data format from StudyBison.");
    let skipped = 0;
    const out = { lectures: [], notes: [] };
    const contrib = { lectures: new Set(), notes: new Set() };
    const parts = [];
    b.sections.forEach((sec, si) => {
      if (!sec || !Array.isArray(sec.topics)) { skipped++; return; }
      sec.topics.forEach((top, ti) => {
        const items = top && Array.isArray(top.lectures) ? top.lectures : null;
        if (!items) { skipped++; return; }
        const buckets = { lectures: [], notes: [] };
        items.forEach((it) => {
          const c = it && typeof it === "object" ? classify(it) : null;
          if (!c) { skipped++; return; }
          buckets[c.tab].push(c.row);
        });
        ["lectures", "notes"].forEach((tab) => {
          if (buckets[tab].length) { parts.push({ tab, si, name: String((top && top.name) || "Untitled").trim() || "Untitled", secName: String((sec && sec.name) || "").trim(), i: buckets[tab] }); contrib[tab].add(si); }
        });
      });
    });
    parts.forEach((p) => {
      const prefix = contrib[p.tab].size > 1 && p.secName ? p.secName + " › " : "";
      out[p.tab].push({ n: prefix + p.name, i: p.i });
    });
    if (!out.lectures.length && !out.notes.length) throw new SBError("empty", "No lectures or notes are listed for this batch.");
    const about = [b.description, b.tagline].find((x) => typeof x === "string" && x.trim());
    return {
      id: slug,
      name: String(b.name || slug),
      by: String(b.instructor || b.tagline || ""),
      about: about ? about.trim() : "",
      credit: "",
      lectures: out.lectures,
      notes: out.notes,
      skipped
    };
  }

  async function fetchJson(url) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20000);
    let res;
    try { res = await fetch(url, { signal: ctl.signal, headers: { Accept: "application/json" } }); }
    catch (e) { throw new SBError(e && e.name === "AbortError" ? "timeout" : "network", e && e.name === "AbortError" ? "StudyBison took too long to respond." : "Could not reach the data source."); }
    finally { clearTimeout(timer); }
    let body = null;
    try { body = await res.json(); } catch (e) {}
    if (!res.ok) throw new SBError((body && body.error) || (res.status === 404 ? "not_found" : "upstream"), (body && body.message) || "The data source returned an error (" + res.status + ").");
    if (!body) throw new SBError("invalid", "The data source returned unreadable data.");
    return body;
  }

  const cacheKey = (slug) => "sb-cache-v1-" + slug;
  function readCache(slug, maxAgeMs) {
    try {
      const c = JSON.parse(sessionStorage.getItem(cacheKey(slug)) || "null");
      if (c && c.data && (maxAgeMs === Infinity || Date.now() - c.t < maxAgeMs)) return c.data;
    } catch (e) {}
    return null;
  }
  function writeCache(slug, data) { try { sessionStorage.setItem(cacheKey(slug), JSON.stringify({ t: Date.now(), data })); } catch (e) {} }

  /* load(slug, {force}) -> { batch, fromCache, stale } */
  async function load(slug, opts) {
    opts = opts || {};
    if (!SLUG_RE.test(slug)) throw new SBError("invalid", "Invalid batch id.");
    const cfg = await getConfig();
    if (!cfg.enabled) throw new SBError("disabled", "This batch is not enabled yet. StudyBison's permission for this integration has not been confirmed by the site owner.");
    const ttl = (cfg.cacheMinutes || 30) * 60000;
    if (!opts.force) { const c = readCache(slug, ttl); if (c) return { batch: c, fromCache: true }; }
    const url = cfg.mode === "direct"
      ? String(cfg.directBase || "").replace(/\/$/, "") + "/" + slug + ".json"
      : (cfg.proxyPath || "/api/studybison") + "?slug=" + encodeURIComponent(slug);
    try {
      const payload = await fetchJson(url);
      const batch = normalize(slug, payload);
      batch.credit = cfg.credit || "";
      writeCache(slug, batch);
      return { batch, fromCache: false };
    } catch (e) {
      if (!(e instanceof SBError)) throw new SBError("invalid", "Could not read this batch's data.");
      if (e.code === "network" && cfg.mode === "direct") e.message = "The browser could not reach StudyBison (the request may be blocked by CORS, or you are offline). Use proxy mode in integrations.json.";
      if (["network", "timeout", "upstream", "rate_limited"].includes(e.code)) {
        const old = readCache(slug, Infinity);
        if (old) return { batch: old, fromCache: true, stale: true };
      }
      throw e;
    }
  }

  window.SB = { load, normalize, SBError, getConfig };
})();
