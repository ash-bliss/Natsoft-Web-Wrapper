// Natsoft Live — phone timing page. Talks to this site's relay at /api/live (WebSocket).
const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};

// ---------- formatting ----------
function lap(s) {
  if (!(s > 0)) return "";
  const ms = Math.round(s * 1000), m = Math.floor(ms / 60000), r = ms % 60000;
  const sec = Math.floor(r / 1000), frac = String(r % 1000).padStart(3, "0");
  return m > 0 ? `${m}:${String(sec).padStart(2, "0")}.${frac}` : `${sec}.${frac}`;
}
function gap(s, laps) {
  if (laps > 0) return laps === 1 ? "+1 Lap" : `+${laps} Laps`;
  if (!(s > 0)) return "";
  return s >= 60 ? "+" + lap(s) : "+" + s.toFixed(3);
}
function sector(s) { return s > 0 ? (s >= 60 ? lap(s) : s.toFixed(3)) : ""; }
function clock(sec) {
  sec = Math.max(0, sec | 0);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const p = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
}
// Natsoft times are the track's wall clock encoded as if UTC.
function trackTime(t) { return t ? new Date(t * 1000).toISOString().slice(11, 19) : ""; }
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const near = (a, b) => a > 0 && b > 0 && Math.abs(a - b) < 0.0005;

function flagInfo(flag) {
  switch ((flag || "").toLowerCase()) {
    case "green": return ["Green", "green"];
    case "yellow": return ["Yellow", "yellow"];
    case "red": return ["Red Flag", "red"];
    case "checkered": case "chequered": return ["Chequered", "chequered"];
    case "ended": return ["Ended", ""];
    case "waitstart": return ["Waiting to start", ""];
    case "": return ["—", ""];
    default: return [flag, ""];
  }
}

// ---------- state ----------
let meeting = "";
let snap = null;               // last full state
let ws = null, wsTimer = null, pingTimer = null, retries = 0;
let key = store.get("accessKey", "");
let needsKey = false;
let metric = store.get("metric", "gap");
let starred = new Set(store.get("starred", []));
let expanded = new Set();
let tab = "timing";
let rcSeen = 0;
const local = new Map();       // per car: { pos, posDelta, posAt, last, lastAt }

// ---------- routing ----------
function route() {
  const h = decodeURIComponent(location.hash.slice(1));
  for (const id of ["start", "keyscreen", "checkscreen", "app"]) $(id).hidden = true;
  if (needsKey && !key) { $("keyscreen").hidden = false; return; }
  if (h.startsWith("check:")) { disconnect(); showCheck(h.slice(6)); return; }
  if (!h) { disconnect(); showStart(); return; }
  if (h.toUpperCase() !== meeting.toUpperCase() || !ws) start(h);
  $("app").hidden = false;
}

function showStart() {
  $("start").hidden = false;
  const recents = store.get("recents", ["V8SUPER"]);
  $("meeting-input").value = $("meeting-input").value || recents[0] || "";
  $("recents").innerHTML = recents.map((r) => `<button data-m="${esc(r)}">${esc(r)}</button>`).join("");
}

function parseMeeting(input) {
  let s = input.trim();
  const m = /LiveMeeting\/([^/?#\s]+)/i.exec(s);
  if (m) s = m[1];
  return /^[A-Za-z0-9._-]{1,40}$/.test(s) ? s : "";
}

$("start-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const m = parseMeeting($("meeting-input").value);
  $("start-error").hidden = !!m;
  if (!m) { $("start-error").textContent = "That doesn't look like a meeting ID or LiveMeeting link."; return; }
  location.hash = m;
});
$("recents").addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) location.hash = b.dataset.m; });
$("check-link").addEventListener("click", (e) => {
  e.preventDefault();
  const m = parseMeeting($("meeting-input").value) || "V8SUPER";
  location.hash = "check:" + m;
});
$("back").addEventListener("click", () => { location.hash = ""; });
$("key-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  key = $("key-input").value.trim();
  const ok = await fetch(`/api/auth?key=${encodeURIComponent(key)}`).then((r) => r.ok).catch(() => false);
  if (!ok) { key = ""; $("key-input").value = ""; $("key-input").placeholder = "That key didn't work"; return; }
  store.set("accessKey", key);
  route();
});

function remember(m) {
  const list = store.get("recents", []).filter((x) => x.toUpperCase() !== m.toUpperCase());
  list.unshift(m);
  store.set("recents", list.slice(0, 8));
}

// ---------- connection ----------
function start(m) {
  disconnect();
  meeting = m;
  snap = null;
  local.clear();
  expanded.clear();
  rcSeen = 0;
  if (m.toUpperCase() !== "DEMO") remember(m);
  render();
  connect();
}

function disconnect() {
  clearTimeout(wsTimer); clearInterval(pingTimer);
  if (ws) { ws.onclose = null; ws.close(); ws = null; }
}

function connect() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const q = new URLSearchParams({ meeting });
  if (key) q.set("key", key);
  const sock = new WebSocket(`${proto}//${location.host}/api/live?${q}`);
  ws = sock;
  setStatus("connecting");
  sock.onopen = () => {
    retries = 0;
    clearInterval(pingTimer);
    pingTimer = setInterval(() => { if (sock.readyState === 1) sock.send("ping"); }, 25000);
  };
  sock.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === "full") snap = msg.data;
    else if (msg.type === "patch" && snap) applyPatch(msg.data);
    else return;
    render();
  };
  sock.onclose = async () => {
    clearInterval(pingTimer);
    if (ws !== sock) return;
    ws = null;
    // A closed socket can't tell us why; check whether it was the access key.
    if (needsKey) {
      const ok = await fetch(`/api/auth?key=${encodeURIComponent(key)}`).then((r) => r.ok).catch(() => true);
      if (!ok) { key = ""; store.set("accessKey", ""); route(); return; }
    }
    setStatus("offline");
    const wait = [1000, 2000, 5000, 10000][Math.min(retries++, 3)];
    wsTimer = setTimeout(() => { if (meeting && !ws) connect(); }, wait);
  };
}

function applyPatch(p) {
  if (p.header) {
    const { cars, raceControl } = snap;
    snap = { ...p.header, cars, raceControl };
  }
  if (p.cars) {
    const byId = new Map(snap.cars.map((c) => [c.id, c]));
    for (const c of p.cars) byId.set(c.id, c);
    snap.cars = p.order ? p.order.map((id) => byId.get(id)).filter(Boolean) : snap.cars.map((c) => byId.get(c.id)).concat(p.cars.filter((c) => !snap.cars.some((o) => o.id === c.id)));
  } else if (p.order) {
    const byId = new Map(snap.cars.map((c) => [c.id, c]));
    snap.cars = p.order.map((id) => byId.get(id)).filter(Boolean);
  }
  if (p.raceControl) snap.raceControl = p.raceControl;
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && meeting && !ws && !$("app").hidden) { clearTimeout(wsTimer); connect(); }
  if (document.visibilityState === "visible" && wantAwake) requestWake();
});

// ---------- rendering ----------
function setStatus(kind, text) {
  const el = $("status");
  el.className = "status " + ({ live: "live", demo: "demo", notLive: "warn", retrying: "warn", offline: "warn", connecting: "warn" }[kind] || "");
  $("status-text").textContent = text || ({
    live: "Live", demo: "Demo", connecting: "Connecting", notLive: "Not live", retrying: "Retrying", offline: "Reconnecting", idle: "Idle",
  }[kind] || kind);
}

function render() {
  if (!snap) {
    $("session-name").textContent = meeting ? `Connecting to ${meeting}…` : "";
    $("meeting-name").textContent = $("session-sub").textContent = "";
    $("tower").innerHTML = "";
    $("empty").hidden = false;
    $("empty").textContent = "Connecting…";
    return;
  }
  const s = snap;
  // Header
  $("meeting-name").textContent = s.meetingName || meeting;
  $("session-name").textContent = s.sessionName || (s.status === "notLive" ? `${meeting} isn't live right now` : meeting);
  $("session-sub").textContent = [s.trackName, s.sessionType].filter(Boolean).join(" · ");
  document.title = s.sessionName ? `${s.sessionName} — Natsoft Live` : "Natsoft Live";

  const c = s.clock || {};
  if (c.remaining === undefined) { $("clock").textContent = "—"; $("clock-sub").textContent = ""; }
  else if (c.type === "L") {
    $("clock").textContent = c.remaining <= 0 ? "Finish" : c.remaining === 1 ? "1 lap" : `${c.remaining} laps`;
    const done = c.elapsed || 0;
    $("clock-sub").textContent = c.remaining <= 0 ? "" : c.scheduledLaps ? `to go · lap ${Math.min(done + 1, c.scheduledLaps)} of ${c.scheduledLaps}` : "to go";
  } else {
    $("clock").textContent = clock(c.remaining);
    $("clock-sub").textContent = c.elapsed ? `${clock(c.elapsed)} elapsed` : "";
  }

  const [flagText, flagClass] = flagInfo(s.flag);
  $("flag").textContent = flagText;
  $("flag").className = "flag " + flagClass;
  $("flagbar").className = "flagbar " + flagClass;
  $("best").innerHTML = s.best && s.best.lap > 0
    ? `Best <b>${lap(s.best.lap)}</b> ${s.best.number ? "#" + esc(s.best.number) : ""} ${esc(s.best.driver || "")}`
    : s.record ? `Record ${lap(s.record.time)} ${esc(s.record.driver)}` : "";
  const detail = s.status === "retrying" && s.statusDetail ? s.statusDetail : undefined;
  if (!ws || ws.readyState !== 1) setStatus(ws ? "connecting" : "offline");
  else setStatus(s.status, detail ? "Retrying" : undefined);
  $("status").title = detail || "";

  renderTower(s);
  renderRc(s);
}

function renderTower(s) {
  const now = Date.now();
  const tower = $("tower");
  $("empty").hidden = s.cars.length > 0;
  $("empty").textContent = s.status === "notLive"
    ? "Natsoft says this meeting isn't live. This page will update by itself when a session starts."
    : "Waiting for cars…";
  $("metric-head").textContent = { gap: "Gap", int: "Int", last: "Last", best: "Best" }[metric];

  const html = s.cars.map((car) => {
    // Remember position changes and fresh laps on this phone (no clock-sync issues).
    let l = local.get(car.id);
    if (!l) { l = { pos: car.pos, last: car.last }; local.set(car.id, l); }
    if (car.pos !== undefined && l.pos !== undefined && car.pos !== l.pos) { l.posDelta = l.pos - car.pos; l.posAt = now; }
    if (car.last && car.last !== l.last && l.last !== undefined) l.lastAt = now;
    l.pos = car.pos; l.last = car.last;

    const isStar = starred.has(car.no);
    const leader = car.pos === 1;
    const arrow = l.posAt && now - l.posAt < 20000 && l.posDelta
      ? `<i class="arrow ${l.posDelta > 0 ? "up" : "down"}">${l.posDelta > 0 ? "▲" : "▼"}</i>` : "";
    const lastCls = near(car.last, s.best?.lap) && s.best?.carId === car.id ? "ob" : near(car.last, car.best) ? "pb" : "";
    const fresh = l.lastAt && now - l.lastAt < 4000 ? " fresh" : "";
    const bestCls = near(car.best, s.best?.lap) && (!s.best?.carId || s.best.carId === car.id) ? "ob" : "";
    const gapText = leader ? (s.isRace ? "Leader" : "") : gap(car.gap, car.gapLaps);
    const intText = leader ? "" : gap(car.int, car.intLaps);
    const secCls = (v, own, overall) => near(v, overall) ? "ob" : near(v, own) ? "pb" : "dim";
    const metricHtml = {
      gap: `<span class="${leader ? "dim" : ""}">${gapText}</span>`,
      int: intText,
      last: `<span class="${lastCls}${fresh}">${lap(car.last)}</span>`,
      best: `<span class="${bestCls}">${lap(car.best)}</span>`,
    }[metric];

    const main = `<div class="row-main">`
      + `<span class="pos">${arrow}${car.pos ?? "–"}</span>`
      + `<span class="no">${esc(car.no)}</span>`
      + `<span class="driver">${isStar ? '<i class="star">★</i>' : ""}${esc(car.driver)}${car.pit ? '<i class="tag">PIT</i>' : ""}</span>`
      + `<span class="c-wide c-laps">${car.laps ?? ""}</span>`
      + `<span class="c-wide c-gap ${leader ? "dim" : ""}">${gapText}</span>`
      + `<span class="c-wide c-int">${intText}</span>`
      + `<span class="c-wide c-last ${lastCls}${fresh}">${lap(car.last)}</span>`
      + `<span class="c-wide c-bestlap ${bestCls}">${lap(car.best)}</span>`
      + `<span class="c-xwide c-s ${secCls(car.s1, car.bs1, s.best?.s1)}">${sector(car.s1)}</span>`
      + `<span class="c-xwide c-s ${secCls(car.s2, car.bs2, s.best?.s2)}">${sector(car.s2)}</span>`
      + `<span class="c-xwide c-s ${secCls(car.s3, car.bs3, s.best?.s3)}">${sector(car.s3)}</span>`
      + `<span class="metric">${metricHtml}</span>`
      + `</div>`;

    const details = expanded.has(car.id) ? `<div class="details">`
      + `<div class="full">${esc(car.vehicle)}</div>`
      + `<div><span>Laps</span>${car.laps ?? "–"}</div>`
      + `<div><span>Gap</span>${gapText || "–"}</div>`
      + `<div><span>Interval</span>${intText || "–"}</div>`
      + `<div><span>Last</span><b class="${lastCls}">${lap(car.last) || "–"}</b></div>`
      + `<div><span>Best${car.bestLapNo ? " (lap " + car.bestLapNo + ")" : ""}</span><b class="${bestCls}">${lap(car.best) || "–"}</b></div>`
      + `<div><span>Pit stops</span>${car.stops ?? 0}${car.pit ? " · in pit" : ""}</div>`
      + `<div><span>S1</span><b class="${secCls(car.s1, car.bs1, s.best?.s1)}">${sector(car.s1) || "–"}</b></div>`
      + `<div><span>S2</span><b class="${secCls(car.s2, car.bs2, s.best?.s2)}">${sector(car.s2) || "–"}</b></div>`
      + `<div><span>S3</span><b class="${secCls(car.s3, car.bs3, s.best?.s3)}">${sector(car.s3) || "–"}</b></div>`
      + (car.bs1 || car.bs2 || car.bs3 ? `<div class="full">Best sectors ${sector(car.bs1) || "–"} · ${sector(car.bs2) || "–"} · ${sector(car.bs3) || "–"}${car.speed ? ` · ${car.speed} km/h` : ""}</div>` : "")
      + `<button data-star="${esc(car.no)}">${isStar ? "★ Unstar" : "☆ Star"} car ${esc(car.no)}</button>`
      + `</div>` : "";

    return `<li class="row${isStar ? " starred" : ""}${car.pit ? " pit" : ""}" data-id="${esc(car.id)}">${main}${details}</li>`;
  }).join("");
  tower.innerHTML = html;
}

function renderRc(s) {
  const list = s.raceControl || [];
  $("rc-empty").hidden = list.length > 0;
  $("rc").innerHTML = list.map((m) => {
    const t = m.text.toLowerCase();
    const cls = /penalty|disqualif|black flag/.test(t) ? "penalty" : /investigat|noted/.test(t) ? "investigation" : "";
    const when = m.trackTime ? trackTime(m.trackTime) : new Date(m.receivedAt).toLocaleTimeString();
    return `<li class="${cls}"><time>${when}</time>${esc(m.text)}</li>`;
  }).join("");
  if (tab === "rc") rcSeen = list.length;
  const unread = list.length - rcSeen;
  $("rc-badge").hidden = unread <= 0;
  $("rc-badge").textContent = unread;
}

// ---------- interactions ----------
$("tower").addEventListener("click", (e) => {
  const starBtn = e.target.closest("[data-star]");
  if (starBtn) {
    const no = starBtn.dataset.star;
    if (starred.has(no)) starred.delete(no); else starred.add(no);
    store.set("starred", [...starred]);
    render();
    return;
  }
  const row = e.target.closest(".row");
  if (!row) return;
  const id = row.dataset.id;
  if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
  render();
});

document.querySelector(".metric-bar").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  metric = b.dataset.metric;
  store.set("metric", metric);
  document.querySelectorAll(".metric-bar button").forEach((x) => x.classList.toggle("on", x === b));
  render();
});
document.querySelectorAll(".metric-bar button").forEach((x) => x.classList.toggle("on", x.dataset.metric === metric));

function setTab(t) {
  tab = t;
  $("timing-view").hidden = t !== "timing";
  $("rc-view").hidden = t !== "rc";
  $("tab-timing").classList.toggle("on", t === "timing");
  $("tab-rc").classList.toggle("on", t === "rc");
  if (snap) renderRc(snap);
  window.scrollTo(0, 0);
}
$("tab-timing").addEventListener("click", () => setTab("timing"));
$("tab-rc").addEventListener("click", () => setTab("rc"));

// Keep the screen on (trackside). Safari 16.4+.
let wakeLock = null, wantAwake = false;
async function requestWake() {
  try { wakeLock = await navigator.wakeLock.request("screen"); wakeLock.addEventListener("release", () => { wakeLock = null; }); }
  catch { /* unsupported or refused */ }
}
$("tab-awake").addEventListener("click", async () => {
  if (!("wakeLock" in navigator)) { $("tab-awake").textContent = "Not supported"; return; }
  wantAwake = !wantAwake;
  if (wantAwake) await requestWake(); else { await wakeLock?.release(); wakeLock = null; }
  $("tab-awake").classList.toggle("on", wantAwake);
});

// ---------- connection check page ----------
async function showCheck(m) {
  $("checkscreen").hidden = false;
  $("check-meeting").textContent = m;
  $("check-steps").innerHTML = `<li class="wait"><b>Checking…</b><span>This takes up to about 20 seconds.</span></li>`;
  $("check-summary").textContent = "";
  try {
    const q = new URLSearchParams({ meeting: m });
    if (key) q.set("key", key);
    const r = await fetch(`/api/check?${q}`).then((x) => x.json());
    if (!r.steps) throw new Error(r.error || "no result");
    $("check-steps").innerHTML = r.steps.map((s) =>
      `<li class="${s.ok ? "ok" : "bad"}"><b>${esc(s.step)}</b><span>${esc(s.detail)}${s.ms ? ` · ${s.ms} ms` : ""}</span></li>`).join("");
    $("check-summary").textContent = r.ok
      ? "The relay can reach Natsoft. You're good to go."
      : "The relay couldn't get through. Send these results to whoever set this up.";
  } catch (e) {
    $("check-steps").innerHTML = `<li class="bad"><b>Check failed</b><span>${esc(e.message)}</span></li>`;
  }
}

// Tick the "time since" bits and expire highlights
setInterval(() => { if (snap && !$("app").hidden) render(); }, 1000);

// ---------- boot ----------
window.addEventListener("hashchange", route);
fetch("/api/config").then((r) => r.json()).then((c) => { needsKey = !!c.needsKey; }).catch(() => {}).finally(route);
