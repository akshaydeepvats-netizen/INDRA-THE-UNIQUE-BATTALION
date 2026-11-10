// INDRA core: API client, live link, shared state, formatting, alarm, notifications, voice.
export const BASE = (window.INDRA_API_BASE || "").replace(/\/$/, "");
export const LEVELS = ["MINIMAL", "LOW", "MEDIUM", "HIGH", "CRITICAL"];
export const LV_COLOR = { MINIMAL: "#9fb2c0", LOW: "#23a597", MEDIUM: "#d39a12", HIGH: "#e2621f", CRITICAL: "#cc1f55", UNKNOWN: "#b6c3cd" };
export const HAZARDS = ["thunderstorm", "lightning", "hail", "cloudburst", "downburst", "heavy_rain"];
export const HZ_LABEL = { thunderstorm: "Thunderstorm", lightning: "Lightning", hail: "Hailstorm", cloudburst: "Cloudburst", downburst: "Downburst / squall", heavy_rain: "Heavy rain", all: "All hazards" };

export const S = {
  status: null, national: null, states: {}, cells: [], alerts: [], lightning: [], radar: null, sat: null,
  selected: null, events: [], lastEventId: 0, link: "LINKING",
  prefs: JSON.parse(localStorage.getItem("indra.prefs") || '{"sound":true,"notify":false,"voice":true}'),
  acked: new Set(JSON.parse(localStorage.getItem("indra.acked") || "[]")),
};
export function savePrefs() { localStorage.setItem("indra.prefs", JSON.stringify(S.prefs)); }

const bus = new EventTarget();
export const on = (t, fn) => bus.addEventListener(t, (e) => fn(e.detail));
export const emit = (t, d) => bus.dispatchEvent(new CustomEvent(t, { detail: d }));

// ---------- session (account tier) ----------
export const AUTH = { token: localStorage.getItem("indra.token") || "", user: null, features: {} };
export function setSession(tok, user, features) {
  AUTH.token = tok || ""; AUTH.user = user || null; AUTH.features = features || {};
  if (tok) localStorage.setItem("indra.token", tok); else localStorage.removeItem("indra.token");
  emit("auth", AUTH);
}
export const can = (f) => !!AUTH.features[f];
export const tier = () => AUTH.user?.tier || null;

export async function api(path, opts = {}) {
  const ctl = new AbortController();
  const tm = setTimeout(() => ctl.abort(), opts.timeout || 30000);
  try {
    const h = { "Content-Type": "application/json", ...(opts.headers || {}) };
    if (AUTH.token) h.Authorization = "Bearer " + AUTH.token;
    const r = await fetch(BASE + path, { ...opts, signal: ctl.signal, headers: h });
    if (r.status === 204) return null;
    const ct = r.headers.get("content-type") || "";
    const body = ct.includes("json") ? await r.json() : await r.text();
    if (!r.ok) {
      if (r.status === 401 && !path.startsWith("/api/auth/")) emit("auth:required", body);
      throw Object.assign(new Error(body?.error || r.statusText), { status: r.status, body, locked: r.status === 403 });
    }
    return body;
  } finally { clearTimeout(tm); }
}
// URLs used directly by the browser (EventSource, <img>, Leaflet overlays, CSV links) carry the token as a query param.
export const url = (p) => {
  if (!AUTH.token || !p.startsWith("/api/")) return BASE + p;
  return BASE + p + (p.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(AUTH.token);
};
export function disconnectLive() { try { es && es.close(); } catch (_) {} es = null; clearInterval(pollTimer); }

// ---------- live link: SSE with polling fallback ----------
let es = null, pollTimer = null, sseFails = 0;
export function connectLive() {
  if (window.EventSource && sseFails < 3) {
    try {
      es = new EventSource(url(`/api/stream?since=${S.lastEventId}`));
      es.onopen = () => { setLink("LIVE"); sseFails = 0; };
      es.onmessage = (m) => { try { ingest(JSON.parse(m.data)); } catch (_) {} };
      es.onerror = () => {
        setLink("RECONNECTING");
        sseFails++;
        if (sseFails >= 3) { es.close(); es = null; startPolling(); }
      };
      return;
    } catch (_) { /* fall through */ }
  }
  startPolling();
}
function startPolling() {
  setLink("POLLING");
  clearInterval(pollTimer);
  const tick = async () => {
    try {
      const r = await api(`/api/events?since=${S.lastEventId}`, { timeout: 15000 });
      r.events.forEach(ingest);
      setLink("POLLING");
    } catch (_) { setLink("OFFLINE"); }
  };
  tick();
  pollTimer = setInterval(tick, 5000);
}
function ingest(e) {
  if (!e || e.id <= S.lastEventId) return;
  S.lastEventId = e.id;
  S.events.push(e);
  if (S.events.length > 400) S.events.splice(0, S.events.length - 400);
  emit("event", e);
  emit("ev:" + e.type, e);
}
function setLink(s) { if (S.link !== s) { S.link = s; emit("link", s); } }

// ---------- formatting ----------
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export function fmtTime(ts, opts = {}) {
  if (!ts) return "—";
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata", ...(opts.sec ? { second: "2-digit" } : {}) }) + (opts.noTz ? "" : " IST");
}
export function fmtDateTime(ts) {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" }) + " IST";
}
export function fmtAge(s) {
  if (s == null) return "—";
  if (s < 0) s = 0;
  if (s < 90) return `${Math.round(s)} s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  if (s < 172800) return `${(s / 3600).toFixed(1)} h`;
  return `${Math.round(s / 86400)} d`;
}
export const ago = (ts) => (ts ? fmtAge(Date.now() / 1000 - ts) + " ago" : "—");
export const n0 = (v, d = 0) => (v == null || Number.isNaN(+v) ? "—" : (+v).toLocaleString("en-IN", { maximumFractionDigits: d, minimumFractionDigits: d }));
export const lvl = (l) => `<span class="lv lv-${esc(l || "UNKNOWN")}">${esc(l || "UNKNOWN")}</span>`;
export function levelOf(score) { return score >= 80 ? "CRITICAL" : score >= 60 ? "HIGH" : score >= 40 ? "MEDIUM" : score >= 20 ? "LOW" : "MINIMAL"; }
export function stateBadge(st) {
  const s = String(st || "UNKNOWN").toUpperCase();
  const cls = s === "LIVE" ? "b-live" : s.startsWith("STALE") || s === "CACHED" || s === "DEGRADED" || s === "DELAYED" ? "b-stale"
    : s === "UNAVAILABLE" || s === "ERROR" ? "b-unavail" : s === "EXPERIMENTAL" ? "b-exp" : s === "ESTIMATED" ? "b-est"
    : s === "SIMULATION" ? "b-sim" : s === "OFFICIAL" ? "b-official" : s === "OBSERVED" ? "b-obs" : s === "INITIALISING" || s === "CONNECTING" || s === "LINKING" ? "b-init" : "b-nc";
  return `<span class="badge ${cls}">${esc(s)}</span>`;
}
export function compass(deg) {
  if (deg == null) return "—";
  return ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"][Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
}
export function scoreBar(v) { const l = levelOf(v || 0); return `<div class="bar"><i style="width:${Math.max(2, Math.min(100, v || 0))}%;background:${LV_COLOR[l]}"></i></div>`; }
export function hzColor(v) {
  if (v == null) return "rgba(110,150,178,.08)";
  const l = levelOf(v); const c = LV_COLOR[l];
  const a = l === "MINIMAL" ? 0.12 : 0.25 + (v / 100) * 0.6;
  return hexA(c, a);
}
export function hexA(hex, a) { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; }
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

// ---------- alarm ----------
let actx = null;
["pointerdown", "keydown", "touchstart"].forEach((ev) => addEventListener(ev, () => unlockAudio(), { once: true, passive: true }));
export function unlockAudio() { try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); if (actx.state === "suspended") actx.resume(); } catch (_) {} }
export function alarm(level = "HIGH") {
  if (!S.prefs.sound) return;
  // Browsers only allow audio after a user gesture; the first click/key anywhere unlocks it.
  if (!actx || actx.state !== "running") return;
  const crit = level === "CRITICAL";
  const t0 = actx.currentTime;
  const seq = crit ? [880, 660, 880, 660, 880, 660] : [740, 990, 740];
  seq.forEach((f, i) => {
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = crit ? "square" : "triangle";
    o.frequency.value = f;
    const s = t0 + i * (crit ? 0.22 : 0.28);
    g.gain.setValueAtTime(0.0001, s);
    g.gain.exponentialRampToValueAtTime(crit ? 0.18 : 0.14, s + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, s + (crit ? 0.2 : 0.25));
    o.connect(g).connect(actx.destination);
    o.start(s); o.stop(s + 0.3);
  });
}
export function chirp() {
  if (!S.prefs.sound || !actx) return;
  const o = actx.createOscillator(), g = actx.createGain(), t = actx.currentTime;
  o.frequency.setValueAtTime(1600, t); o.frequency.exponentialRampToValueAtTime(600, t + 0.06);
  g.gain.setValueAtTime(0.025, t); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
  o.connect(g).connect(actx.destination); o.start(t); o.stop(t + 0.1);
}

// ---------- browser notifications ----------
export async function enableNotify() {
  if (!("Notification" in window)) return false;
  const p = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
  S.prefs.notify = p === "granted"; savePrefs();
  return S.prefs.notify;
}
export function notify(title, body, tag) {
  if (!S.prefs.notify || !("Notification" in window) || Notification.permission !== "granted") return;
  try { const n = new Notification(title, { body, tag, requireInteraction: false }); n.onclick = () => { window.focus(); emit("open-alert", tag); }; } catch (_) {}
}

// ---------- speech ----------
export function say(text) {
  emit("say", text);
  if (!S.prefs.voice || !("speechSynthesis" in window)) return;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.onstart = () => emit("speaking", true); u.onend = () => emit("speaking", false); u.onerror = () => emit("speaking", false);
    u.lang = "en-IN"; u.rate = 1.04; u.pitch = 0.95;
    const v = speechSynthesis.getVoices().find((x) => /en-IN/i.test(x.lang)) || speechSynthesis.getVoices().find((x) => /^en/i.test(x.lang));
    if (v) u.voice = v;
    speechSynthesis.speak(u);
  } catch (_) {}
}

export function toast(html, level = "info", ms = 6000) {
  const box = document.getElementById("toasts");
  const el = document.createElement("div");
  el.className = "toast"; el.dataset.l = level;
  el.innerHTML = html;
  box.prepend(el);
  while (box.children.length > 4) box.lastChild.remove();
  if (ms) setTimeout(() => { el.style.transition = "opacity .4s"; el.style.opacity = 0; setTimeout(() => el.remove(), 400); }, ms);
  return el;
}
