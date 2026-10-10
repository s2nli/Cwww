(function () {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const esc = (v = "") => String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c]));
  const params = new URLSearchParams(location.search);
  const batchId = params.get("id") || "";
  const ICON = {
    video: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="2.5" y="6" width="13" height="12" rx="3"/><path d="m15.5 10.5 6-3.5v10l-6-3.5"/></svg>',
    doc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/></svg>',
    chev: '<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m9 5 7 7-7 7"/></svg>',
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
    tick: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.2 4.2L19 7"/></svg>'
  };

  let batch = null, meta = null;
  let state = { tab: "lectures", s: null };
  let curList = [], curIdx = -1, hls = null, filterText = "";
  /* Lecture completion: localStorage "cx-done" = { "<batchId>:<subjectIndex>-<lectureIndex>": 1 } (batchId prefix keeps batches apart) */
  const DONE_KEY = "cx-done";
  const readDone = () => { try { const o = JSON.parse(localStorage.getItem(DONE_KEY) || "{}"); return o && typeof o === "object" && !Array.isArray(o) ? o : {}; } catch (e) { return {}; } };
  const dkey = (s, i) => batchId + ":" + s + "-" + i;
  function setDone(s, i, on) {
    const d = readDone();
    if (on) d[dkey(s, i)] = 1; else delete d[dkey(s, i)];
    try { localStorage.setItem(DONE_KEY, JSON.stringify(d)); } catch (e) {}
    return !!on;
  }
  const toggleDone = (s, i) => setDone(s, i, !readDone()[dkey(s, i)]);
  function prog(s, d) {
    d = d || readDone();
    const n = batch.lectures[s] ? batch.lectures[s].i.length : 0; let c = 0;
    for (let i = 0; i < n; i++) if (d[dkey(s, i)]) c++;
    return { d: c, n, p: n ? Math.round(c * 100 / n) : 0 };
  }
  function overallProg() {
    const d = readDone(); let c = 0, n = 0;
    batch.lectures.forEach((_, s) => { const p = prog(s, d); c += p.d; n += p.n; });
    return { d: c, n, p: n ? Math.round(c * 100 / n) : 0 };
  }
  const barHtml = (p) => '<div class="prog' + (p.n && p.p === 100 ? " full" : "") + '"><div class="pbar"><i style="width:' + p.p + '%"></i></div><span>' + p.p + "%</span></div>";

  function toast(msg) { const t = $("#toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("show"), 2200); }

  async function init() {
    if (!/^[a-z0-9-]+$/i.test(batchId)) return fail("Batch not found.");
    let bRes = null;
    try { bRes = await fetch("batches.json"); const bj = await bRes.json(); meta = (bj.batches || []).find((b) => b._id === batchId) || null; } catch (e) {}
    if (meta && meta.source === "studybison") return loadRemote();
    try {
      const dRes = await fetch("data/" + batchId + ".json");
      if (!dRes.ok) throw new Error("not found");
      batch = await dRes.json();
    } catch (e) { return fail("This batch could not be loaded. Please go back and try again.", init); }
    start();
  }

  function loading() { $("#topTitle").textContent = (meta && meta.name) || "Loading…"; $("#page").innerHTML = '<div class="list"><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div></div>'; }

  async function loadRemote(force) {
    loading();
    try {
      const r = await window.SB.load(batchId, { force: !!force });
      batch = r.batch;
      if (r.stale) setTimeout(() => toast("Showing a saved copy — could not refresh"), 400);
    } catch (e) {
      const code = e && e.code;
      const msg = (e && e.message) || "This batch could not be loaded.";
      return fail(msg, code === "disabled" ? null : () => loadRemote(true), code === "empty" ? "Nothing to show" : (code === "disabled" ? "Not enabled" : "Could not load batch"));
    }
    start();
  }

  function start() {
    document.title = batch.name + " — CODEX STUDYS";
    trackRecent();
    const h = readHash();
    const g = h.tab === "notes" ? batch.notes : batch.lectures;
    if (h.s !== null && (h.tab === "about" || !g[h.s])) h.s = null;
    state = h;
    history.replaceState(state, "");
    render();
  }

  function fail(msg, retry, title) {
    $("#topTitle").textContent = (meta && meta.name) || "Batch";
    $("#page").innerHTML = '<div class="empty state-box" role="alert">' + (title ? "<h3>" + esc(title) + "</h3>" : "") + "<p>" + esc(msg) + "</p>" + (retry ? '<button class="pill-btn solid" id="retryBtn" type="button">Retry</button>' : "") + "</div>";
    const b = $("#retryBtn"); if (b) b.addEventListener("click", () => retry());
  }

  function readHash() {
    const m = location.hash.match(/tab=(lectures|notes|about)(?:&s=(\d+))?/);
    return { tab: m ? m[1] : "lectures", s: m && m[2] !== undefined ? +m[2] : null };
  }
  function go(tab, s) {
    state = { tab, s: s === undefined ? null : s };
    filterText = "";
    history.pushState(state, "", "#tab=" + tab + (state.s !== null ? "&s=" + state.s : ""));
    render(); window.scrollTo(0, 0);
  }
  window.addEventListener("popstate", (e) => {
    if (playerOpen && !(e.state && e.state.p)) closePlayer(true);
    state = (e.state && e.state.tab) ? { tab: e.state.tab, s: e.state.s === undefined ? null : e.state.s } : readHash();
    filterText = ""; render();
  });
  $("#backBtn").addEventListener("click", () => {
    if (state.s !== null) { history.back(); return; }
    if (document.referrer && new URL(document.referrer).origin === location.origin && history.length > 1) history.back();
    else location.href = "index.html#courses";
  });

  function trackRecent() {
    try {
      const k = "codex-studys-recent";
      const arr = JSON.parse(localStorage.getItem(k) || "[]").filter((x) => x._id !== batchId);
      arr.unshift({ _id: batchId, name: batch.name, byName: batch.by || "", language: (meta && meta.language) || "", previewImage: (meta && meta.previewImage) || "" });
      localStorage.setItem(k, JSON.stringify(arr.slice(0, 8)));
    } catch (e) {}
  }

  const total = (groups) => groups.reduce((n, g) => n + g.i.length, 0);

  function render() {
    const page = $("#page");
    const groups = state.tab === "notes" ? batch.notes : batch.lectures;
    const inSubject = state.s !== null && state.tab !== "about" && groups[state.s];
    $("#topTitle").textContent = inSubject ? groups[state.s].n : batch.name;
    if (inSubject) { page.innerHTML = renderItems(groups[state.s]); bindItems(groups[state.s]); return; }
    const img = (meta && meta.previewImage) || "assets/batch-" + batchId + ".webp";
    let html = '<div class="hero"><img class="hero-img" src="' + esc(img) + '" alt="' + esc(batch.name) + '" onerror="this.src=\'assets/codex-telegram.png\'">' +
      '<div class="hero-body"><h2 class="hero-title">' + esc(batch.name) + '</h2><p class="hero-sub">' + esc(batch.by || "") + '</p>' +
      '<div class="badges"><span class="badge accent">Recorded</span><span class="badge">' + esc((meta && meta.language) || "Hinglish") + '</span></div>' + heroProgress() + '</div></div>' +
      '<div class="tabs">' + ["lectures", "notes", "about"].map((t) => '<button class="tab' + (state.tab === t ? " active" : "") + '" data-tab="' + t + '" type="button">' + t[0].toUpperCase() + t.slice(1) + "</button>").join("") + "</div>";
    if (state.tab === "about") html += renderAbout();
    else html += '<div class="list">' + (groups.length ? groups.map((g, i) => subjectRow(g, i)).join("") : '<div class="empty">' + (state.tab === "notes" ? "No notes are listed for this batch." : "No lectures are listed for this batch.") + "</div>") + "</div>";
    page.innerHTML = html;
    page.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => { if (b.dataset.tab !== state.tab) go(b.dataset.tab); }));
    page.querySelectorAll("[data-s]").forEach((b) => b.addEventListener("click", () => go(state.tab, +b.dataset.s)));
  }

  function heroProgress() {
    const p = overallProg();
    return p.n ? '<div class="ov"><small>' + p.d + "/" + p.n + " lectures completed</small>" + barHtml(p) + "</div>" : "";
  }

  function subjectRow(g, i) {
    const notes = state.tab === "notes";
    const n = g.i.length;
    if (notes) return '<button class="row" type="button" data-s="' + i + '"><span class="ico pdf">' + ICON.doc + '</span><span class="row-main"><span class="row-name">' + esc(g.n) + '</span><div class="row-sub">' + n + (n === 1 ? " note" : " notes") + "</div></span>" + ICON.chev + "</button>";
    const p = prog(i), full = p.n && p.d === p.n;
    return '<button class="row sub' + (full ? " full" : "") + '" type="button" data-s="' + i + '"><span class="ico' + (full ? " done" : "") + '">' + (full ? ICON.tick : ICON.video) + '</span><span class="row-main"><span class="row-name">' + esc(g.n) + '</span><div class="row-sub">' + p.d + "/" + p.n + " lectures done</div>" + barHtml(p) + "</span>" + ICON.chev + "</button>";
  }

  function renderAbout() {
    const subj = batch.lectures.map((g) => g.n);
    return '<div class="stats"><div class="stat"><b>' + total(batch.lectures) + '</b><span>Lectures</span></div><div class="stat"><b>' + total(batch.notes) + '</b><span>Notes</span></div><div class="stat"><b>' + batch.lectures.length + '</b><span>Subjects</span></div></div>' +
      '<div class="about-card"><h3>About this batch</h3><p>' + esc(batch.about || "") + '</p>' + (batch.credit ? '<p style="margin-top:10px;font-size:12px;opacity:.7">' + esc(batch.credit) + '</p>' : "") + '</div>' +
      '<div class="about-card" style="margin-top:14px"><h3>Subjects</h3><div class="tags">' + subj.map((s) => '<span class="tag">' + esc(s) + "</span>").join("") + "</div></div>";
  }

  function renderItems(g) {
    const notes = state.tab === "notes";
    let h = '<p class="crumb">' + esc(batch.name) + " › " + (notes ? "Notes" : "Lectures") + " › " + esc(g.n) + "</p>";
    if (!notes) h += '<div class="shead" id="shead"></div>';
    if (g.i.length > 10) h += '<input class="search" id="itemSearch" type="search" placeholder="Search in ' + esc(g.n) + '…" autocomplete="off" value="' + esc(filterText) + '">';
    h += '<div class="list" id="itemList"></div>';
    return h;
  }

  function bindItems(g) {
    const notes = state.tab === "notes";
    const list = $("#itemList");
    const draw = () => {
      const q = filterText.trim().toLowerCase();
      const rows = [];
      g.i.forEach((it, idx) => { if (!q || it[0].toLowerCase().includes(q)) rows.push([it, idx]); });
      curList = rows.map((r) => ({ it: r[0], idx: r[1] }));
      const doneMap = readDone();
      list.innerHTML = rows.length ? rows.map(([it, idx], n) => itemRow(it, idx, n, notes, doneMap)).join("") : '<div class="empty">No results found.</div>';
      list.querySelectorAll("[data-n]").forEach((el) => {
        const open = (e) => { const n = +el.dataset.n; const a = e.target.closest("[data-act]"); if (notes) { openNote(curList[n], a && a.dataset.act); } else openLecture(n); };
        el.addEventListener("click", (e) => { if (e.target.closest(".chk")) return; open(e); });
        el.addEventListener("keydown", (e) => { if (e.target === el && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); open(e); } });
      });
      list.querySelectorAll("[data-c]").forEach((btn) => btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const idx = +btn.dataset.c, on = toggleDone(state.s, idx), row = btn.closest(".row");
        row.classList.toggle("done", on); btn.classList.toggle("on", on);
        btn.setAttribute("aria-pressed", String(on)); btn.setAttribute("aria-label", on ? "Mark as not done" : "Mark as done");
        const num = row.querySelector(".num"); if (num) num.innerHTML = on ? ICON.tick : String(idx + 1);
        updateHead();
      }));
    };
    const search = $("#itemSearch");
    if (search) search.addEventListener("input", () => { filterText = search.value; draw(); });
    draw(); updateHead();
  }

  function updateHead() {
    const el = $("#shead"); if (!el || state.s === null) return;
    const p = prog(state.s);
    el.innerHTML = "<small>" + p.d + "/" + p.n + " lectures completed</small>" + barHtml(p);
  }

  const wkey = (idx) => state.tab[0] + state.s + ":" + idx;
  function itemRow(it, idx, n, notes, doneMap) {
    if (notes) return '<div class="row item" data-n="' + n + '" role="button" tabindex="0"><span class="ico pdf" style="width:42px;height:42px;border-radius:13px">' + ICON.doc + '</span><span class="row-main"><span class="row-name">' + esc(it[0]) + '</span></span><span class="act">' + (it[2] === "l" ? '<button class="pill-btn solid" data-act="view" type="button">Open</button>' : '<button class="pill-btn solid" data-act="view" type="button">View</button><button class="pill-btn" data-act="dl" type="button">Download</button>') + "</span></div>";
    const done = !!(doneMap || readDone())[dkey(state.s, idx)];
    return '<div class="row item' + (done ? " done" : "") + '" data-n="' + n + '" role="button" tabindex="0"><span class="num">' + (done ? ICON.tick : idx + 1) + '</span><span class="row-main"><span class="row-name">' + esc(it[0]) + '</span></span><button class="chk' + (done ? " on" : "") + '" type="button" data-c="' + idx + '" aria-pressed="' + done + '" aria-label="' + (done ? "Mark as not done" : "Mark as done") + '">' + ICON.tick + "</button></div>";
  }

  function openNote(entry, act) {
    const url = entry.it[1];
    if (act === "dl" && entry.it[2] !== "l") { const a = document.createElement("a"); a.href = url; a.download = ""; a.target = "_blank"; a.rel = "noopener noreferrer"; document.body.appendChild(a); a.click(); a.remove(); toast("Download started"); }
    else window.open(url, "_blank", "noopener,noreferrer");
  }

  /* ---------- player (LecturePlayer from the KD build) ---------- */
  let player = null, playerOpen = false, curN = -1;
  const ytWatch = (id) => "https://www.youtube.com/watch?v=" + id;
  const isPlayable = (it) => it[2] !== "p";

  function lpData(n) {
    const e = curList[n], it = e.it, kind = it[2];
    const mk = (i) => ({ id: batchId + ":" + wkey(curList[i].idx), title: curList[i].it[0], i });
    const groups = state.tab === "notes" ? batch.notes : batch.lectures;
    return {
      id: batchId + ":" + wkey(e.idx), title: it[0], videoUrl: kind === "y" ? ytWatch(it[1]) : it[1], quality: {}, chapters: [], attachments: [],
      downloadUrl: /\.(mp4|webm)(\?|#|$)/i.test(it[1]) ? it[1] : null, autoplay: true,
      course: batch.name, lectures: curList.map((_, i) => mk(i)),
      previousLecture: n > 0 ? mk(n - 1) : null, nextLecture: n < curList.length - 1 ? mk(n + 1) : null,
      _s: state.s, _i: e.idx, _group: groups[state.s] ? groups[state.s].n : ""
    };
  }

  function drawPlayerInfo(n) {
    const d = curList[n], g = (state.tab === "notes" ? batch.notes : batch.lectures)[state.s];
    $("#pTitle").textContent = d.it[0];
    $("#pSub").textContent = (g ? g.n + " · " : "") + (n + 1) + "/" + curList.length;
    const l = $("#pList");
    l.innerHTML = curList.map((e, i) => '<div class="row item' + (i === n ? " now" : "") + '" data-p="' + i + '" role="button" tabindex="0"><span class="num">' + (e.idx + 1) + '</span><span class="row-main"><span class="row-name">' + esc(e.it[0]) + "</span></span></div>").join("");
    l.querySelectorAll("[data-p]").forEach((el) => el.addEventListener("click", () => playN(+el.dataset.p)));
    const now = l.querySelector(".now"); if (now) now.scrollIntoView({ block: "nearest" });
  }

  function playN(n) {
    const e = curList[n]; if (!e) return;
    curN = n;
    drawPlayerInfo(n);
    const d = lpData(n);
    const root = $("#playerRoot");
    if (e.it[2] === "p") { // embedded-page lectures can't run in the custom player: open in a new tab instead
      destroyPlayer();
      root.innerHTML = '<div class="p-note" style="margin:16px">This lecture plays on its own page. <a href="' + esc(e.it[1]) + '" target="_blank" rel="noopener noreferrer">Open lecture</a></div>';
      return;
    }
    const nav = (x) => { if (x) playN(x.i); };
    if (player) { player.load(d); return; }
    root.innerHTML = "";
    if (typeof window.LecturePlayer !== "function") { root.innerHTML = '<div class="p-note" style="margin:16px">The player could not load. Check your connection and <a href="" onclick="location.reload();return false">retry</a>.</div>'; return; }
    player = new window.LecturePlayer(root, d, {
      onBack: () => closePlayer(false), onNavigate: nav, onSelectLecture: nav,
      onEnded: (dd) => { if (dd && dd._s != null && dd._i != null) setDone(dd._s, dd._i, true); }
    });
    try { window.LecturePlayer.mediaSession(player, "assets/icon-512.png"); } catch (e2) {}
  }

  function destroyPlayer() { try { player && player.destroy(); } catch (e) {} player = null; $("#playerRoot").innerHTML = ""; }

  function openLecture(n) {
    if (!playerOpen) history.pushState(Object.assign({}, state, { p: 1 }), "");
    playerOpen = true;
    $("#playerLayer").hidden = false; document.body.style.overflow = "hidden";
    playN(n);
    $("#playerLayer").scrollTop = 0;
  }

  function closePlayer(fromPop) {
    if (!playerOpen) return;
    playerOpen = false; destroyPlayer(); curN = -1;
    $("#playerLayer").hidden = true; document.body.style.overflow = "";
    if (!fromPop && history.state && history.state.p) history.back();
    if (state.s !== null) render();
  }

  init();
})();
