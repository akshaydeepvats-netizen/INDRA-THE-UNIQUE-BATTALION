// INDRA app shell: router, live data loops, alerts, search, voice and command palette.
import {
  S, AUTH, can, api, on, emit, esc, connectLive, fmtTime, LV_COLOR, HZ_LABEL, toast, alarm, notify, say, unlockAudio, chirp,
  enableNotify, savePrefs, debounce, sleep, stateBadge, LEVELS,
} from "./core.js";
import * as M from "./map.js";
import * as V from "./modules.js";
import * as P from "./simple.js";
import { ensureSession, renderAccount, lockedCard, startTour, tierLabel, renderVerifyBanner } from "./account.js";
import { admin as adminView } from "./admin.js";
import * as H from "./holo.js";

const ICONS = {
  home: '<path d="M3 11 12 4l9 7"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>',
  accuracy: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.2"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.3-1 .9-1 1.7v.5M12 17v.5"/>',
  desk: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  atlas: '<path d="M9 4 3 6v14l6-2 6 2 6-2V4l-6 2z"/><path d="M9 4v14M15 6v14"/>',
  weather: '<path d="M7 18a4 4 0 0 1-.6-8A6 6 0 0 1 18 9a4.5 4.5 0 0 1-.5 9z"/>',
  radar: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><path d="M12 12 19 5"/>',
  storms: '<path d="M6 15a4 4 0 0 1 .5-8A6 6 0 0 1 18 8a4 4 0 0 1 0 8"/><path d="m13 12-3 5h4l-3 5"/>',
  nowcast: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/>',
  impact: '<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17v.5"/>',
  alerts: '<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z"/><path d="M10 20a2 2 0 0 0 4 0"/>',
  verify: '<path d="M4 19V9M10 19V5M16 19v-7M22 19H2"/>',
  system: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  admin: '<path d="M12 3 4 6v6c0 4.5 3.4 8.3 8 9 4.6-.7 8-4.5 8-9V6z"/><circle cx="12" cy="10" r="2.5"/><path d="M8 16c.8-1.6 2.3-2.5 4-2.5s3.2.9 4 2.5"/>',
};
const MODULES = [
  { id: "home", label: "Home", title: "Home", kicker: "Your weather in plain words", render: P.home, feature: "home", tip: "Simple local weather, next 12 h, nearby station, alerts and safety tips" },
  { id: "desk", label: "Command", title: "Command Desk", kicker: "National monitoring desk", render: V.desk, live: true, feature: "command", tip: "National threat, priority districts, live log (professional)" },
  { id: "atlas", label: "Atlas", title: "National Atlas", kicker: "States · districts · towns · villages", render: V.atlas, live: true, feature: "atlas", tip: "Drill down from India to state, district, town and village" },
  { id: "weather", label: "Weather", title: "Weather Report", kicker: "Detailed point report", render: V.weather, feature: "weather", tip: "Full report for any point on the map" },
  { id: "radar", label: "Radar/Sat", title: "Radar & Satellite Centre", kicker: "Observations", render: V.radarsat, live: true, feature: "radarsat", tip: "Rain, satellite and lightning feeds with loops" },
  { id: "storms", label: "Storms", title: "Storm Intelligence", kicker: "Cell detection & tracking", render: V.storms, live: true, feature: "storms", tip: "Tracked storm cells, motion and arrival times" },
  { id: "nowcast", label: "Nowcast", title: "Nowcasting Engine", kicker: "0–6 h hazard nowcast", render: V.nowcast, live: true, feature: "nowcast", tip: "National 0–6 h hazard nowcast (professional)" },
  { id: "impact", label: "Impact", title: "Impact Intelligence", kicker: "Exposure in storm paths", render: V.impact, live: true, feature: "impact", tip: "Population and places in storm paths (professional)" },
  { id: "alerts", label: "Alerts", title: "Alert Centre", kicker: "Screening alerts · official feeds", render: V.alerts, live: true, feature: "screening_alerts", tip: "INDRA screening alerts and official NDMA SACHET alerts, kept separate" },
  { id: "accuracy", label: "Accuracy", title: "Live Accuracy", kicker: "Checked against real weather stations", render: P.accuracy, feature: "accuracy_summary", tip: "How close INDRA was to real station measurements" },
  { id: "verify", label: "Verify", title: "Model Verification Centre", kicker: "POD · FAR · CSI", render: V.verify, feature: "verify", tip: "Storm forecast verification scores (professional)" },
  { id: "system", label: "System", title: "System & API", kicker: "Feeds · loops · audit", render: V.system, feature: "system", tip: "Feed health, engine loops, API, audit (professional)" },
  { id: "help", label: "Help", title: "Help & Guide", kicker: "How to use INDRA", render: P.help, feature: "help", tip: "Guide, label meanings, glossary, account types" },
  { id: "admin", label: "Admin", title: "Admin Console", kicker: "Accounts · approvals · access", render: adminView, adminOnly: true, tip: "Manage users, professional approvals, access code and email" },
];
const isAdmin = () => !!(AUTH.user?.is_admin && !AUTH.user?.needs_verification);
const modAllowed = (m) => (m.adminOnly ? isAdmin() : can(m.feature));
const MOD = Object.fromEntries(MODULES.map((m) => [m.id, m]));
let current = { mod: "home", args: [] };
const dash = () => (can("command") ? "desk" : "home");
const PAGE_T0 = Date.now() / 1000;

// ---------------- shell ----------------
function buildRail() {
  const r = document.getElementById("rail");
  r.innerHTML = MODULES.filter((m) => !m.adminOnly || isAdmin()).map((m, i) => { const lk = !modAllowed(m); return `${i === 2 || i === 9 || i === 12 ? '<div class="rail-sep"></div>' : ""}<button class="rail-btn ${lk ? "locked" : ""}" data-m="${m.id}" title="${esc(m.title + " — " + m.tip)}${lk ? " (locked)" : ""}"><svg viewBox="0 0 24 24">${ICONS[m.id]}</svg><span>${m.label}</span>${lk ? '<i class="rb-lock" aria-label="Locked">PRO</i>' : ""}${m.id === "alerts" ? '<b class="rb-count" id="rbAlerts" hidden>0</b>' : ""}</button>`; }).join("");
  r.onclick = (e) => { const b = e.target.closest("[data-m]"); if (b) location.hash = "#/" + b.dataset.m; };
}
function setActiveRail(id) { document.querySelectorAll(".rail-btn").forEach((b) => b.classList.toggle("active", b.dataset.m === id)); }
function setCrumbs(list) {
  const el = document.getElementById("crumbs");
  el.innerHTML = list.map(([h, t], i) => `${i ? '<span class="sep">/</span>' : ""}<button data-h="${esc(h)}">${esc(t)}</button>`).join("");
  el.querySelectorAll("button").forEach((b) => (b.onclick = () => (location.hash = b.dataset.h)));
}
on("crumbs", setCrumbs);

// ---------------- router ----------------
async function route() {
  const parts = (location.hash || "#/" + dash()).replace(/^#\/?/, "").split("/");
  const head = parts[0] || dash();
  let mod = head, args = parts.slice(1);
  if (head === "district" || head === "place") mod = "atlas";
  if (head === "loc") mod = "weather";
  if (head === "cell") mod = "storms";
  if (!MOD[mod] || (MOD[mod].adminOnly && !isAdmin())) { location.hash = "#/" + dash(); return; }
  document.getElementById("panel").classList.remove("wide"); document.body.classList.remove("panel-wide");
  const prevMod = current.mod;
  current = { mod, head, args };
  setActiveRail(mod);
  const m = MOD[mod];
  document.getElementById("panelTitle").textContent = m.title;
  document.getElementById("panelKicker").textContent = m.kicker;
  document.getElementById("panelActions").innerHTML = "";
  setCrumbs([[`#/${mod}`, m.title]]);
  const body = document.getElementById("panelBody");
  V.destroyCharts();
  if (mod !== "nowcast" && M.timeMode.mode === "nowcast") { M.timeMode.mode = "auto"; M.updateTimebar(); }
  if (head !== "cell") M.selectCellOnMap(null);
  if (!["atlas", "weather"].includes(mod) && prevMod !== mod) { S.selected = null; M.clearDistricts(); M.setSelMarker(null); }
  if (mod === "desk" && prevMod !== "desk") M.homeView();
  body.scrollTop = 0;
  if (innerWidth < 820) document.getElementById("panel").classList.remove("min");
  H.panelEnter();
  if (!modAllowed(m)) {
    const need = ["storms", "radarsat"].includes(m.feature) ? "public" : "professional";
    body.innerHTML = lockedCard(m.title, need, `${esc(m.tip)}. This module is part of a <b>${tierLabel(need)}</b> account.`) + `<div class="note box" style="margin-top:10px">Meanwhile, <a href="#/home">Home</a> shows your local weather in plain words and the map layers marked as unlocked keep working live.</div>`;
    M.restyleStates();
    return;
  }
  try {
    if (head === "district") await V.district(body, +args[0]);
    else if (head === "place") await V.place(body, +args[0]);
    else if (head === "loc") { const [la, lo, ...nm] = args.join("/").split(","); await V.location_(body, +la, +lo, decodeURIComponent(nm.join(","))); }
    else if (head === "cell") await V.cell(body, args[0]);
    else if (mod === "atlas" && args[0]) await V.atlasState(body, args[0]);
    else { if (mod === "atlas") { S.selected = null; M.homeView(); } await m.render(body, args); }
  } catch (e) {
    console.error(e);
    if (e.locked) { body.innerHTML = lockedCard(m.title + " — " + (e.body?.error || "locked"), e.body?.required_tier || "professional"); return; }
    body.innerHTML = `<div class="empty">This view could not load: ${esc(e.message || e)} ${stateBadge("UNAVAILABLE")}<br><button class="btn ghost sm" style="margin-top:8px" onclick="location.reload()">Retry</button></div>`;
  }
  M.restyleStates();
}
window.addEventListener("hashchange", route);

// re-render live module views without losing scroll (only list-style views)
const rerender = debounce(async () => {
  const { mod, head, args } = current;
  if (!MOD[mod]?.live || head === "district" || head === "place" || head === "cell" || (mod === "atlas" && args[0])) return;
  if (document.querySelector("#panelBody input:focus, #panelBody select:focus, #panelBody textarea:focus")) return;
  const body = document.getElementById("panelBody");
  const y = body.scrollTop;
  V.destroyCharts();
  await MOD[mod].render(body);
  body.scrollTop = y;
}, 400);

// ---------------- data refresh ----------------
async function refreshStatus() {
  try {
    S.status = await api("/api/status");
    S.sat = { ...(S.status.satellite || {}), wms: "https://view.eumetsat.int/geoserver/wms" };
    const nat = S.status.national_level || "UNKNOWN";
    document.getElementById("natChip").dataset.level = nat;
    document.getElementById("natLevel").textContent = nat;
    // satellite loop frames: only times already ingested (avoid not-yet-published frames)
    const ft = S.status.satellite?.frame_time;
    const times = (S.status.satellite?.times || []).map((iso) => ({ time: Date.parse(iso) / 1000, time_iso: iso })).filter((f) => !ft || f.time <= ft + 1);
    if (times.length) M.satLoop.setFrames(times.slice(-10));
    for (const f of S.status.feeds) {
      const map = { stations: ["stations"], radar: ["radar", "radarqc"], satellite: ["sat_ir108", "sat_convection", "sat_cth", "sat_wv062", "sat_vis006"], lightning: ["lightning"], models: ["hazard"], official: ["official"] }[f.id];
      (map || []).forEach((id) => { const el = document.getElementById("lst-" + id); if (el) el.innerHTML = stateBadge(f.state); });
    }
    M.updateTimebar();
  } catch (e) { console.warn("status", e); }
}
async function refreshNational() {
  try {
    const n = await api("/api/national");
    S.national = n;
    S.states = Object.fromEntries((n.states || []).map((s) => [s.slug, s]));
    M.restyleStates();
    document.getElementById("natChip").dataset.level = n.level || "UNKNOWN";
    document.getElementById("natLevel").textContent = n.level || "—";
    M.refreshOverlays();
  } catch (e) { console.warn("national", e); }
}
async function refreshCells() {
  try { const r = await api("/api/cells"); S.cells = r.cells; M.drawCells(S.cells); drawScope(); } catch (e) { console.warn("cells", e); }
}
async function refreshAlerts() {
  try {
    const r = await api("/api/alerts?status=active");
    S.alerts = r.alerts;
    const crit = r.alerts.filter((a) => a.status === "ACTIVE" && ["HIGH", "CRITICAL"].includes(a.level) && !a.acknowledged_at).length;
    const b = document.getElementById("rbAlerts"); b.hidden = !crit; b.textContent = crit > 99 ? "99+" : crit;
  } catch (e) { console.warn("alerts", e); }
}
async function refreshRadar() {
  try {
    const r = await api("/api/radar");
    S.radar = r;
    if (r.frames?.length) M.radarLoop.setFrames(r.frames);
    M.refreshHimawari();
    const hs = document.getElementById("lst-himawari"); if (hs) hs.innerHTML = stateBadge(r.himawari?.status || "UNAVAILABLE");
    M.updateTimebar();
  } catch (e) { console.warn("radar", e); }
}
async function refreshOfficial() {
  try {
    const r = await api("/api/official");
    S.official = r;
    M.drawOfficial(r.alerts);
    const b = document.getElementById("rbOfficial"); if (b) { b.hidden = !r.active; b.textContent = r.active > 99 ? "99+" : r.active; }
  } catch (e) { console.warn("official", e); }
}
async function refreshStations() {
  try { const r = await api("/api/stations"); S.stations = r.stations; M.drawStations(r.stations); } catch (e) { console.warn("stations", e); }
}
on("ev:accuracy", () => { refreshStations(); if (["home", "accuracy"].includes(current.mod)) rerenderAcc(); });
const rerenderAcc = debounce(() => { if (current.mod === "accuracy") route(); }, 1000);
async function refreshLightning() {
  try { const r = await api("/api/lightning?minutes=60"); S.lightning = r.strikes; M.drawLightning(S.lightning); drawScope(); } catch (e) { console.warn("lightning", e); }
}
on("alerts-updated", () => { refreshAlerts().then(rerender); });

// ---------------- scope (radar sweep HUD) ----------------
function drawScope() {
  const el = document.getElementById("blips"); if (!el) return;
  const [[s, w], [n, e]] = M.IND_BOUNDS;
  const pos = (la, lo) => { const x = (lo - w) / (e - w), y = (n - la) / (n - s); const dx = x - 0.5, dy = y - 0.5, d = Math.hypot(dx, dy); const k = d > 0.48 ? 0.48 / d : 1; return [50 + dx * k * 100, 50 + dy * k * 100]; };
  const now = Date.now() / 1000;
  const ltg = (S.lightning || []).filter((x) => now - x[0] < 900);
  el.innerHTML = S.cells.slice(0, 60).map((c) => { const [x, y] = pos(c.lat, c.lon); return `<i class="blip" data-l="${c.severity}" style="left:${x}%;top:${y}%"></i>`; }).join("") +
    ltg.slice(-80).map(([, la, lo]) => { const [x, y] = pos(la, lo); return `<i class="blip lt" style="left:${x}%;top:${y}%"></i>`; }).join("");
  document.getElementById("scopeCells").textContent = S.cells.length;
  document.getElementById("scopeStrikes").textContent = ltg.length;
}

// ---------------- live events ----------------
const tk = document.getElementById("tkTrack");
function tick(e) {
  if (e.type === "lightning") return;
  const div = document.createElement("div"); div.innerHTML = V.evLine(e);
  const src = div.firstElementChild;
  const span = document.createElement("span");
  span.className = "tk-item " + (src.className || "");
  span.innerHTML = src.innerHTML;
  tk.prepend(span);
  while (tk.children.length > 14) tk.lastChild.remove();
  const log = document.getElementById("deskLog");
  if (log) { log.insertAdjacentHTML("afterbegin", V.evLine(e)); while (log.children.length > 80) log.lastChild.remove(); }
}
on("event", tick);
on("ev:lightning", (e) => {
  const st = e.data.strikes || [];
  S.lightning = (S.lightning || []).concat(st).filter((x) => Date.now() / 1000 - x[0] < 3600).slice(-6000);
  M.flashStrikes(st);
  if (st.length && current.mod !== "alerts") chirp();
});
const fusionRefresh = debounce(async () => {
  await Promise.all([refreshNational(), refreshCells(), refreshAlerts(), refreshStatus()]);
  rerender();
  if (current.mod === "nowcast" && V.nowcast.reload) V.nowcast.reload();
}, 800);
on("ev:fusion", fusionRefresh);
on("ev:log", (e) => { if (e.data?.source === "radar") refreshRadar(); });
on("link", (s) => {
  const c = document.getElementById("liveChip");
  c.className = "live-chip " + (s === "LIVE" ? "on" : s === "POLLING" ? "poll" : s === "OFFLINE" ? "off" : "");
  document.getElementById("liveTxt").textContent = s;
});

// ---------------- alert popups ----------------
let popQueue = 0, popReset = null, modalOpen = false;
on("ev:alert", (e) => {
  const d = e.data;
  refreshAlerts();
  if (e.t < PAGE_T0 - 5) return; // replayed history, no popup
  if (!["ISSUED", "ESCALATED"].includes(d.event) || !["HIGH", "CRITICAL"].includes(d.level) || S.acked.has(d.id)) return;
  popQueue++;
  clearTimeout(popReset); popReset = setTimeout(() => { const lim = innerWidth < 820 ? 1 : 3; if (popQueue > lim) toast(`<div class="tb"><div class="tt">${popQueue - lim} more HIGH/CRITICAL alerts this cycle</div><div class="ts">Open the Alert Command Centre for the full list.</div></div><button class="btn sm" onclick="location.hash='#/alerts'">Open</button>`, "HIGH", 9000); popQueue = 0; }, 2500);
  if (popQueue > (innerWidth < 820 ? 1 : 3)) return;
  alarm(d.level);
  notify(`INDRA ${d.level}: ${HZ_LABEL[d.hazard] || d.hazard}`, `${d.title} — experimental screening alert, not an official IMD warning.`, d.id);
  if (d.level === "CRITICAL" && !modalOpen) {
    modalOpen = true;
    V.alertDetail(d.id).then(() => { const m = document.getElementById("modal"); const obs = new MutationObserver(() => { if (m.hidden) { modalOpen = false; obs.disconnect(); } }); obs.observe(m, { attributes: true }); });
    say(`Critical ${HZ_LABEL[d.hazard] || ""} alert for ${d.district || "a monitored area"}, ${d.state || ""}.`);
  } else {
    const el = toast(`<div class="tb"><div class="tt">${esc(d.event)} · ${esc(d.title)}</div><div class="ts">${esc(d.level)} · INDRA experimental screening alert · ${fmtTime(e.t)}</div></div><div style="display:flex;flex-direction:column;gap:4px">${can("ack") ? '<button class="btn sm" data-ack>Ack</button>' : ""}<button class="btn ghost sm" data-view>View</button></div>`, d.level, 14000);
    const ab = el.querySelector("[data-ack]"); if (ab) ab.onclick = () => { V.ackAlert(d.id); el.remove(); };
    el.querySelector("[data-view]").onclick = () => { V.alertDetail(d.id); el.remove(); };
  }
});
on("open-alert", (id) => V.alertDetail(id));
// Official NDMA SACHET alerts: separate stream, separate styling, never merged with INDRA screening alerts
on("ev:official", (e) => {
  refreshOfficial();
  if (e.t < PAGE_T0 - 5) return;
  for (const a of (e.data?.new || []).slice(0, innerWidth < 820 ? 1 : 3)) {
    const el = toast(`<div class="tb"><div class="tt"><span class="badge b-official">OFFICIAL</span> ${esc(a.level)} · ${esc(a.event)}</div><div class="ts">${esc(a.issuer)} via NDMA SACHET · ${esc((a.area_description || "").slice(0, 90))}</div></div><button class="btn ghost sm" data-view>View</button>`, "official", 15000);
    el.querySelector("[data-view]").onclick = () => { goOfficial(); el.remove(); };
    notify(`OFFICIAL ${a.level}: ${a.event}`, `${a.issuer} (NDMA SACHET) — ${a.area_description || ""}`, a.id);
  }
});
const goOfficial = () => { if (location.hash === "#/alerts/official") route(); else location.hash = "#/alerts/official"; };
on("select-official", goOfficial);

// ---------------- map interactions ----------------
const drillMods = () => ["desk", "atlas"].includes(current.mod);
let lastClick = null;
M.L_ && on("map-click", (ll) => { location.hash = `#/loc/${ll.lat.toFixed(4)},${ll.lng.toFixed(4)},`; });
on("select-state", (slug) => {
  if (drillMods()) location.hash = `#/atlas/${slug}`;
  else if (lastClick) location.hash = `#/loc/${lastClick.lat.toFixed(4)},${lastClick.lng.toFixed(4)},`;
});
on("select-district", (id) => {
  if (drillMods()) location.hash = `#/district/${id}`;
  else if (lastClick) location.hash = `#/loc/${lastClick.lat.toFixed(4)},${lastClick.lng.toFixed(4)},`;
});
on("select-cell", (id) => (location.hash = `#/cell/${id}`));
on("nowcast-lead", () => { if (current.mod === "nowcast") { const r = document.getElementById("ncLead"); if (r) r.value = M.hazardState.lead; V.nowcast.reload && V.nowcast.reload(); } });
on("loop-frame", () => M.updateTimebar());

// ---------------- search ----------------
const sIn = document.getElementById("search"), sOut = document.getElementById("searchResults");
let sItems = [], sIdx = -1;
const doSearch = debounce(async (q) => {
  if (q.trim().length < 2) { sOut.hidden = true; return; }
  try {
    const r = await api(`/api/search?q=${encodeURIComponent(q)}`);
    sItems = r.results; sIdx = -1;
    sOut.innerHTML = (sItems.length ? sItems.map((x, i) => `<button class="sr-item" data-i="${i}"><span class="sr-type">${esc(x.type === "place" ? x.tier || "place" : x.type)}</span><span><div class="sr-name">${esc(x.name)}</div><div class="sr-sub">${esc(x.label || [x.district, x.state].filter(Boolean).join(", "))}</div></span></button>`).join("") : `<div class="empty">No match for “${esc(q)}”.</div>`) + `<div class="meta" style="padding:4px 8px">${esc(r.source)}</div>`;
    sOut.hidden = false;
  } catch (_) { sOut.hidden = true; }
}, 220);
sIn.addEventListener("input", () => doSearch(sIn.value));
sIn.addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); sIdx = Math.max(0, Math.min(sItems.length - 1, sIdx + (e.key === "ArrowDown" ? 1 : -1))); sOut.querySelectorAll(".sr-item").forEach((b, i) => b.classList.toggle("active", i === sIdx)); }
  if (e.key === "Enter") { const x = sItems[Math.max(0, sIdx)]; if (x) openResult(x); }
  if (e.key === "Escape") { sOut.hidden = true; sIn.blur(); }
});
sOut.addEventListener("click", (e) => { const b = e.target.closest("[data-i]"); if (b) openResult(sItems[+b.dataset.i]); });
document.addEventListener("click", (e) => { if (!e.target.closest(".search-wrap")) sOut.hidden = true; });
export function openResult(x) {
  sOut.hidden = true; sIn.value = x.name; sIn.blur();
  if (x.type === "state") location.hash = `#/atlas/${x.slug}`;
  else if (x.type === "district") location.hash = `#/district/${x.id}`;
  else if (x.tier && x.tier !== "village" && x.id) location.hash = `#/loc/${x.lat},${x.lon},${encodeURIComponent(x.name)}`;
  else location.hash = `#/loc/${x.lat},${x.lon},${encodeURIComponent(x.name)}`;
}
async function searchAndOpen(q) {
  const r = await api(`/api/search?q=${encodeURIComponent(q)}`).catch(() => null);
  const x = r?.results?.[0];
  if (x) { openResult(x); return x; }
  toast(`<div class="tb"><div class="tt">No place found for “${esc(q)}”</div></div>`);
  return null;
}

// ---------------- command palette ----------------
const COMMANDS = [
  ...MODULES.map((m) => ({ t: `Open ${m.title}`, k: m.id + " " + m.title, run: () => (location.hash = "#/" + m.id), feature: m.feature })),
  { t: "Ground stations layer", k: "stations metar observed layer", run: () => M.setLayer("stations", !M.layerOn("stations")) },
  { t: "Take the guided tour", k: "tour help guide", run: () => startTour(true) },
  { t: "Play / pause loop", k: "play pause loop animate", run: () => document.getElementById("tbPlay").click() },
  { t: "Toggle radar layer", k: "radar layer", run: () => M.setLayer("radar", !M.layerOn("radar")) },
  { t: "Toggle satellite IR layer", k: "satellite ir infrared", run: () => M.setLayer("sat_ir108", !M.layerOn("sat_ir108")) },
  { t: "Toggle lightning layer", k: "lightning layer", run: () => M.setLayer("lightning", !M.layerOn("lightning")) },
  { t: "Toggle hazard nowcast overlay", k: "hazard overlay nowcast", run: () => M.setLayer("hazard", !M.layerOn("hazard")) },
  { t: "Spoken situation briefing", k: "briefing status summary voice speak", run: () => briefing() },
  { t: "Zoom to India", k: "home india reset zoom", run: () => M.homeView() },
];
const pal = document.getElementById("palette"), pIn = document.getElementById("paletteInput"), pList = document.getElementById("paletteList");
let pItems = [], pIdx = 0;
function openPalette() { pal.hidden = false; pIn.value = ""; renderPalette(""); setTimeout(() => pIn.focus(), 20); }
function closePalette() { pal.hidden = true; }
const renderPalette = debounce(async (q) => {
  const ql = q.toLowerCase();
  pItems = COMMANDS.filter((c) => !c.feature || can(c.feature)).filter((c) => !ql || c.k.toLowerCase().includes(ql) || c.t.toLowerCase().includes(ql)).slice(0, 8).map((c) => ({ ...c, type: "cmd" }));
  if (q.length >= 2) { const r = await api(`/api/search?q=${encodeURIComponent(q)}`).catch(() => null); (r?.results || []).slice(0, 8).forEach((x) => pItems.push({ t: x.name, sub: x.label, type: x.type === "place" ? x.tier : x.type, run: () => openResult(x) })); }
  pIdx = 0;
  pList.innerHTML = pItems.map((x, i) => `<button class="sr-item ${i === 0 ? "active" : ""}" data-i="${i}"><span class="sr-type">${esc(x.type)}</span><span><div class="sr-name">${esc(x.t)}</div>${x.sub ? `<div class="sr-sub">${esc(x.sub)}</div>` : ""}</span></button>`).join("") || '<div class="empty">No match</div>';
}, 120);
pIn.addEventListener("input", () => renderPalette(pIn.value));
pIn.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closePalette();
  if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); pIdx = Math.max(0, Math.min(pItems.length - 1, pIdx + (e.key === "ArrowDown" ? 1 : -1))); pList.querySelectorAll(".sr-item").forEach((b, i) => b.classList.toggle("active", i === pIdx)); }
  if (e.key === "Enter" && pItems[pIdx]) { closePalette(); pItems[pIdx].run(); }
});
pList.addEventListener("click", (e) => { const b = e.target.closest("[data-i]"); if (b) { closePalette(); pItems[+b.dataset.i].run(); } });
pal.addEventListener("click", (e) => { if (e.target === pal) closePalette(); });
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); pal.hidden ? openPalette() : closePalette(); }
  if (e.key === "Escape") { const m = document.getElementById("modal"); if (!m.hidden) { m.hidden = true; m.innerHTML = ""; } }
  if (e.key.toLowerCase() === "v" && !e.target.closest("input,textarea,select") && !e.ctrlKey && !e.metaKey) startVoice();
});

// ---------------- voice ----------------
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
function briefing() {
  const n = S.national;
  if (!n || n.status !== "OK") { say("The national scan is still initialising."); return; }
  const dl = n.district_levels || {};
  const top = (n.priority_districts || [])[0];
  const act = S.alerts.filter((a) => a.status === "ACTIVE").length;
  const msg = `National threat level ${n.level}. ${n.cells.total} convective cells tracked, ${n.cells.severe} severe. ${dl.CRITICAL || 0} districts critical and ${dl.HIGH || 0} high. ${n.lightning.last_15min} lightning strikes in the last fifteen minutes. ${act} active screening alerts.${top && top.score >= 40 ? ` Highest threat: ${top.name}, ${top.state}, ${HZ_LABEL[top.hazard]}.` : ""}`;
  say(msg);
  toast(`<div class="tb"><div class="tt">Situation briefing</div><div class="ts">${esc(msg)}</div></div>`, n.level, 12000);
}
async function handleVoice(text) {
  const t = text.toLowerCase().trim();
  document.getElementById("voiceText").textContent = `“${text}”`;
  const nav = [["home|my weather|ghar", "home"], ["help|guide|how to", "help"], ["accuracy|how accurate", "accuracy"], ["command|desk|dashboard", "desk"], ["atlas|states|india map|national map", "atlas"], ["radar|satellite", "radar"], ["storm|cells|tracking", "storms"], ["nowcast|forecast", "nowcast"], ["impact|affected", "impact"], ["alert|warning", "alerts"], ["verification|verify|model", "verify"], ["system|status|feeds|api", "system"]];
  let m;
  if ((m = t.match(/(?:weather|report|forecast|mausam|conditions)\s+(?:in|for|at|of)\s+(.+)/)) || (m = t.match(/(.+?)\s+(?:ka|ki|ke)\s+(?:mausam|weather|report)/))) { const x = await searchAndOpen(m[1]); if (x) say(`Opening weather report for ${x.name}.`); return; }
  if ((m = t.match(/(?:zoom|go|fly|show|open|navigate)\s+(?:to|me)?\s*(.+)/)) && !nav.some(([k]) => new RegExp(`^(${k})`).test(m[1]))) { const x = await searchAndOpen(m[1]); if (x) say(`Showing ${x.name}.`); return; }
  if (/brief|summary|situation|status report|what.?s happening/.test(t)) return briefing();
  if (/play|animate/.test(t)) { document.getElementById("tbPlay").click(); return say("Playing loop."); }
  if (/stop|pause/.test(t)) { M.radarLoop.stop(); M.satLoop.stop(); M.updateTimebar(); return say("Loop paused."); }
  if (/lightning/.test(t) && /(on|show|enable)/.test(t)) { M.setLayer("lightning", true); return say("Lightning layer on."); }
  if (/satellite/.test(t) && /(on|show|layer)/.test(t)) { M.setLayer("sat_ir108", true); location.hash = "#/radar"; return say("Satellite infrared layer on."); }
  for (const [k, id] of nav) if (new RegExp(k).test(t)) { location.hash = "#/" + id; say(`Opening ${MOD[id].title}.`); return; }
  const x = await searchAndOpen(t.replace(/^(show|open)\s+/, ""));
  if (x) say(`Opening ${x.name}.`); else say("Sorry, I did not catch a command.");
}
function startVoice() {
  unlockAudio();
  const hud = document.getElementById("voiceHud"), btn = document.getElementById("btnVoice");
  if (!SR) { toast(`<div class="tb"><div class="tt">Voice commands need Chrome or Edge</div><div class="ts">Use Ctrl+K for the command palette instead.</div></div>`); openPalette(); return; }
  if (rec) { rec.stop(); return; }
  rec = new SR(); rec.lang = "en-IN"; rec.interimResults = true; rec.maxAlternatives = 1;
  hud.hidden = false; btn.classList.add("listening"); document.getElementById("voiceText").textContent = "Listening… try “weather in Meerut”, “show alerts”, “briefing”";
  let final = "";
  rec.onresult = (e) => { let s = ""; for (const r of e.results) { s += r[0].transcript; if (r.isFinal) final = s; } document.getElementById("voiceText").textContent = s; };
  rec.onerror = (e) => { document.getElementById("voiceText").textContent = `Voice error: ${e.error}`; };
  rec.onend = async () => { btn.classList.remove("listening"); rec = null; if (final) await handleVoice(final); setTimeout(() => (hud.hidden = true), 1600); };
  rec.start();
}
document.getElementById("btnVoice").onclick = startVoice;

// ---------------- toggles ----------------
function syncToggles() {
  document.getElementById("btnSound").classList.toggle("active", S.prefs.sound);
  document.getElementById("btnNotify").classList.toggle("active", S.prefs.notify && "Notification" in window && Notification.permission === "granted");
}
document.getElementById("btnSound").onclick = () => { S.prefs.sound = !S.prefs.sound; savePrefs(); unlockAudio(); syncToggles(); if (S.prefs.sound) chirp(); };
document.getElementById("btnNotify").onclick = async () => { if (S.prefs.notify) { S.prefs.notify = false; savePrefs(); } else if (!(await enableNotify())) toast(`<div class="tb"><div class="tt">Notifications blocked</div><div class="ts">Allow notifications for this site in browser settings.</div></div>`); syncToggles(); };
on("prefs", syncToggles);
document.getElementById("logo").onclick = () => { location.hash = "#/" + dash(); M.homeView(); };
document.getElementById("panelGrip").onclick = () => { const p = document.getElementById("panel"); p.classList.toggle("min"); setTimeout(() => M.L_().invalidateSize(), 320); };
document.addEventListener("pointerdown", unlockAudio, { once: true });

// ---------------- clocks ----------------
function clocks() {
  const d = new Date();
  document.getElementById("clkIst").textContent = d.toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata", hour12: false });
  document.getElementById("clkUtc").textContent = d.toISOString().slice(11, 19);
}

// ---------------- boot ----------------
async function boot() {
  const log = document.getElementById("bootLog"), bootEl = document.getElementById("boot");
  const add = (a, b, cls) => log.insertAdjacentHTML("beforeend", `<li><span>${esc(a)}</span><span class="${cls}">${esc(b)}</span></li>`);
  const done = () => { bootEl.classList.add("done"); sessionStorage.setItem("indra.booted", "1"); setTimeout(() => M.L_().invalidateSize(), 100); };
  document.getElementById("bootSkip").onclick = done;
  if (sessionStorage.getItem("indra.booted")) { done(); return; }
  add("INDRA core", "ONLINE", "ok");
  await refreshStatus();
  const feeds = S.status?.feeds || [];
  for (const f of feeds) {
    await sleep(160);
    const st = f.state || "UNKNOWN";
    add(f.name, st, st === "LIVE" ? "ok" : st === "NOT CONNECTED" || st === "NOT CHECKED" ? "nc" : st === "UNAVAILABLE" ? "bad" : "mid");
  }
  await sleep(200);
  add("Fusion engine", S.status?.national_level ? `SCAN #${S.status.fusion_id}` : "INITIALISING", S.status?.national_level ? "ok" : "mid");
  await sleep(500);
  done();
}

// ---------------- start ----------------
(async function start() {
  M.initMap();
  M.initTimebar();
  M.updateLegend();
  syncToggles();
  clocks(); setInterval(clocks, 1000);
  M.L_().on("click", (e) => (lastClick = e.latlng));
  M.L_().on("mousedown touchstart", (e) => { if (e.latlng) lastClick = e.latlng; });
  // polygons swallow map clicks; record the click position on them too
  M.L_().on("preclick", (e) => (lastClick = e.latlng));
  // Accounts: a valid session (guest / public / professional) is required before any data is requested.
  if (!AUTH.token) document.getElementById("boot").classList.add("done");
  await ensureSession();
  if (!sessionStorage.getItem("indra.booted")) document.getElementById("boot").classList.remove("done");
  renderAccount();
  renderVerifyBanner();
  buildRail();
  H.init({ briefing, handleText: handleVoice, startVoice, MOD });
  M.buildLayerBox();
  const bootP = boot();
  await Promise.all([refreshNational(), refreshCells(), refreshAlerts(), refreshRadar(), refreshLightning(), refreshOfficial(), refreshStations()]);
  connectLive();
  await bootP;
  route();
  setTimeout(() => startTour(), 1200);
  setInterval(refreshStations, 600000);
  setInterval(refreshStatus, 30000);
  setInterval(() => { refreshNational(); refreshCells(); refreshAlerts(); }, 90000);
  setInterval(refreshRadar, 120000);
  setInterval(refreshOfficial, 120000);
  setInterval(() => { M.drawLightning(S.lightning || []); drawScope(); }, 20000);
  setInterval(() => { if (S.link !== "LIVE" && S.link !== "POLLING") { /* SSE auto-reconnects */ } }, 30000);
})();
