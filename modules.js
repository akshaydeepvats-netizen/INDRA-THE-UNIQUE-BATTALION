// INDRA modules — each renders into the right-hand console panel. The map is shared.
import {
  S, api, url, esc, lvl, fmtTime, fmtDateTime, fmtAge, ago, n0, stateBadge, compass, scoreBar, hzColor, levelOf,
  LV_COLOR, HAZARDS, HZ_LABEL, LEVELS, toast, alarm, enableNotify, savePrefs, emit, can,
} from "./core.js";
import { plainBlock, savePlace, setHomePlace, info } from "./simple.js";
import { lockedCard } from "./account.js";
import * as M from "./map.js";

const slugify = (x) => String(x).toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const big = (n) => n == null ? "—" : n >= 1e7 ? (n / 1e7).toFixed(2) + " Cr" : n >= 1e5 ? (n / 1e5).toFixed(2) + " L" : Math.round(n).toLocaleString("en-IN");


const charts = new Set();
function chart(el, cfg) {
  if (!el || !window.Chart) return null;
  const c = new Chart(el, cfg); charts.add(c); return c;
}
export function destroyCharts() { charts.forEach((c) => c.destroy()); charts.clear(); }
Chart.defaults && Object.assign(Chart.defaults, { font: { family: "Geist, system-ui", size: 11 }, color: "#627a8b" });
const gridC = "rgba(110,150,178,.18)";
const baseOpts = (extra = {}) => ({
  responsive: true, maintainAspectRatio: false, animation: { duration: 500 },
  plugins: { legend: { display: false }, tooltip: { backgroundColor: "rgba(255,255,255,.96)", titleColor: "#0e2232", bodyColor: "#2f4757", borderColor: "rgba(110,150,178,.5)", borderWidth: 1 } },
  scales: { x: { grid: { color: gridC }, ticks: { maxRotation: 0 } }, y: { grid: { color: gridC }, beginAtZero: true } }, ...extra,
});

const sec = (title, body, extra = "") => `<div class="sec"><div class="sec-h">${title}${extra}</div>${body}</div>`;
const kpi = (k, v, s = "", attrs = "") => `<div class="kpi ${attrs ? "click" : ""}" ${attrs}><div class="k">${k}</div><div class="v">${v}</div>${s ? `<div class="s">${s}</div>` : ""}</div>`;
const skel = (n = 4) => Array.from({ length: n }, () => '<div class="skel"></div>').join("");
const srcTags = (arr) => (arr || []).map((s) => `<span class="src-tag">${esc(s)}</span>`).join("");
const go = (h) => `onclick="location.hash='${h}'"`;

function ring(score, level) {
  const c = 2 * Math.PI * 40, off = c * (1 - Math.min(100, score || 0) / 100);
  return `<div class="ring"><svg viewBox="0 0 92 92"><circle class="tr" cx="46" cy="46" r="40"/><circle class="vl" cx="46" cy="46" r="40" stroke="${LV_COLOR[level] || LV_COLOR.UNKNOWN}" stroke-dasharray="${c}" stroke-dashoffset="${off}"/></svg><div class="rt"><div><b>${score ?? "—"}</b><small>SCORE</small></div></div></div>`;
}
function hzGrid(rows, keys = HAZARDS, title = "") {
  // rows: [{lead_h, <hazard>: score}]
  let h = `<div class="hz-grid"><div class="h">${title}</div>${rows.map((r) => `<div class="h">+${r.lead_h}h</div>`).join("")}`;
  for (const k of keys) {
    h += `<div class="n">${esc(HZ_LABEL[k])}</div>` + rows.map((r) => { const v = typeof r[k] === "object" ? r[k]?.mean : r[k]; return `<div class="hz-cell" style="background:${hzColor(v)}" title="${esc(HZ_LABEL[k])} +${r.lead_h} h: ${v ?? "—"}">${v ?? "—"}</div>`; }).join("");
  }
  return h + "</div>";
}
function precList(list) { return `<ul class="prec">${(list || []).map((p) => `<li>${esc(p)}</li>`).join("")}</ul>`; }
function confBox(c) { return c ? `<div class="kv"><dt>Confidence</dt><dd>${esc(c.label)} (${n0(c.score * 100)}%)</dd><dt>Basis</dt><dd>${(c.basis || []).join(", ") || "—"}</dd></div>` : ""; }
const OFFICIAL = `<div class="officialbox"><b>Official warnings</b> are issued only by the India Meteorological Department. INDRA output is an <b>experimental screening product</b>. Check <a href="https://mausam.imd.gov.in/responsive/districtWiseNowcast.php" target="_blank" rel="noopener">IMD district nowcast</a> and your State/District Disaster Management Authority.</div>`;

// ---------------- official alerts (NDMA SACHET) — always rendered apart from INDRA screening alerts
function officialCard(a) {
  const ds = (a.districts || []).slice(0, 8).map((d) => `<a href="#/district/${d.id}">${esc(d.name)}</a>`).join(", ");
  return `<div class="card off-card" data-l="${esc(a.level)}"><div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start"><div><span class="badge b-official">OFFICIAL</span> <b>${esc(a.level)}</b> · <b>${esc(a.event)}</b></div><span class="meta mono" style="white-space:nowrap">until ${fmtTime(a.effective_until)}</span></div>
    <div style="margin:5px 0 4px;font-size:12.5px">${esc(a.message)}</div>
    <div class="meta">${esc(a.issuer)} · ${esc(a.certainty || "")} · ${esc(a.area_description)}${a.area_km2 ? ` · ${n0(a.area_km2)} km²` : ""}</div>
    ${ds ? `<div class="meta" style="margin-top:3px">Districts: ${ds}</div>` : ""}
    <div style="display:flex;gap:6px;margin-top:6px">${a.lat != null ? `<button class="btn ghost sm" onclick="window.__offZoom(${a.lat},${a.lon},${a.radius_km || 20})">Show on map</button>` : ""}<a class="btn ghost sm" href="https://sachet.ndma.gov.in/" target="_blank" rel="noopener">SACHET</a></div></div>`;
}
window.__offZoom = (la, lo, r) => { M.L_().fitBounds(L.latLng(la, lo).toBounds(Math.max(30, r * 2.4) * 1000)); };
function officialSection(list, title = "Official alerts · NDMA SACHET", emptyTxt = "No active official alert published on NDMA SACHET for this area.") {
  const st = S.official?.status || S.status?.feeds?.find((f) => f.id === "official")?.state;
  return sec(title, (list?.length ? list.map(officialCard).join("") : `<div class="empty">${st && st !== "LIVE" ? `Official feed ${stateBadge(st)} — absence of data here does not mean no warning.` : esc(emptyTxt)}</div>`)
    + `<div class="note" style="margin-top:4px">Issued by the named agency (IMD / SDMA / CWC / INCOIS…) via the CAP Integrated Alert System. Footprints on the map are approximate.</div>`, stateBadge("OFFICIAL"));
}

// ====================================================================== COMMAND DESK
export async function desk(body) {
  const n = S.national;
  if (!n || n.status !== "OK") { body.innerHTML = sec("National scan", `<div class="empty">Fusion engine is initialising — first scan completes within ~1–2 minutes of start-up.</div>${skel(6)}`) + feedsSection(); return; }
  const dl = n.district_levels || {};
  const active = S.alerts.filter((a) => a.status === "ACTIVE");
  const crit = active.filter((a) => a.level === "CRITICAL").length;
  const highUp = (dl.HIGH || 0) + (dl.CRITICAL || 0);
  body.innerHTML = `
    <div class="hero">${ring(n.score, n.level)}<div><div class="panel-kicker">National threat · next 6 h</div><div class="hero-l lvtxt-${n.level}">${n.level}</div>
      <div class="hero-s">${highUp} districts HIGH or above across ${n.states_at_high_or_above} states/UTs · scan #${S.status?.fusion_id ?? "—"} at ${fmtTime(n.generated_at, { sec: true })}</div></div></div>
    <div class="sec" style="margin-top:10px"><div class="grid4">
      ${kpi("Active cells", n0(n.cells.total), `${n.cells.radar} IMERG · ${n.cells.satellite} sat`, go("#/storms"))}
      ${kpi("Severe cells", `<span class="lvtxt-HIGH">${n0(n.cells.severe)}</span>`, "HIGH / CRITICAL", go("#/storms"))}
      ${kpi("Growing", n0(n.cells.intensifying), `${n.cells.initiation} new initiation`, go("#/storms"))}
      ${kpi("Lightning", n0(n.lightning.last_15min), `/15 min · ${n0(n.lightning.last_60min)}/h`, go("#/radar"))}
      ${kpi("INDRA alerts", n0(active.length), `${crit} critical · screening`, go("#/alerts"))}
      ${kpi("Official alerts", n0(S.official?.active), "NDMA SACHET", go("#/alerts/official"))}
      ${kpi("Critical dist.", `<span class="lvtxt-CRITICAL">${n0(dl.CRITICAL)}</span>`, `${n0(dl.HIGH)} high`, go("#/atlas"))}
      ${kpi("Medium dist.", n0(dl.MEDIUM), `${n0(dl.LOW)} low`, go("#/atlas"))}
      ${kpi("Fusion", `${(n.fusion_ms / 1000).toFixed(1)}<small style="font-size:11px">s</small>`, "per national scan", go("#/system"))}
    </div></div>
    ${sec("Forecast timeline · 0–6 h", `<div class="chart-box sm"><canvas id="cNat"></canvas></div><div class="note">Bars: districts at HIGH+ by lead. Line: national peak score. 0–2 h extrapolates observed cells; 2–6 h blends to NWP.</div>`, stateBadge("EXPERIMENTAL"))}
    ${sec("Priority districts", `<div class="list">${(n.priority_districts || []).filter((d) => d.score >= 20).slice(0, 10).map(distRow).join("") || '<div class="empty">No district above LOW right now.</div>'}</div>`)}
    ${officialSection((S.official?.alerts || []).slice(0, 4), `Official alerts · NDMA SACHET <span class="meta">(${n0(S.official?.active)} active)</span>`, "No active official alerts on NDMA SACHET right now.")}
    ${sec("Developing cells", `<div class="list">${[...S.cells].sort((a, b) => (a.latent ? 1 : 0) - (b.latent ? 1 : 0)).slice(0, 6).map(cellRow).join("") || '<div class="empty">No convective cells detected in the current scan.</div>'}</div>`)}
    ${feedsSection()}
    ${sec("Threat history · 24 h", `<div class="chart-box sm"><canvas id="cHist"></canvas></div>`)}
    ${sec("Live event log", `<div class="evlog" id="deskLog">${S.events.slice(-60).reverse().map(evLine).join("")}</div>`)}
    ${OFFICIAL}`;
  const tl = n.timeline || [];
  chart(document.getElementById("cNat"), {
    data: { labels: tl.map((_, i) => `+${i}h`), datasets: [
      { type: "bar", label: "Districts HIGH+", data: (n.districts_at_level_by_lead || []).map((x) => x.HIGH), backgroundColor: "rgba(226,98,31,.35)", borderRadius: 4, yAxisID: "y1" },
      { type: "line", label: "Peak score", data: tl, borderColor: "#0098bd", backgroundColor: "rgba(25,191,224,.15)", fill: true, tension: 0.35, pointRadius: 3 },
    ] },
    options: baseOpts({ scales: { x: { grid: { color: gridC } }, y: { max: 100, grid: { color: gridC }, beginAtZero: true }, y1: { position: "right", grid: { display: false }, beginAtZero: true } } }),
  });
  api("/api/history?hours=24").then((h) => {
    const th = h.threat || [];
    if (!th.length) { const el = document.getElementById("cHist"); if (el) el.parentElement.outerHTML = '<div class="empty">History accumulates every 5 minutes while this instance runs.</div>'; return; }
    chart(document.getElementById("cHist"), { type: "line", data: { labels: th.map((x) => fmtTime(x.at, { noTz: true })), datasets: [
      { label: "National score", data: th.map((x) => x.score), borderColor: "#0098bd", tension: 0.3, pointRadius: 0, fill: true, backgroundColor: "rgba(25,191,224,.12)" },
      { label: "Cells", data: th.map((x) => x.cells?.total), borderColor: "#e2621f", tension: 0.3, pointRadius: 0, yAxisID: "y1" }] },
      options: baseOpts({ plugins: { legend: { display: true, labels: { boxWidth: 10 } } }, scales: { x: { ticks: { maxTicksLimit: 6 }, grid: { color: gridC } }, y: { max: 100, beginAtZero: true, grid: { color: gridC } }, y1: { position: "right", beginAtZero: true, grid: { display: false } } } }) });
  }).catch(() => {});
}
export function evLine(e) {
  const d = e.data || {};
  const msg = e.type === "log" ? d.msg : e.type === "alert" ? `ALERT ${d.event}: ${d.title} [${d.level}]` : e.type === "lightning" ? `⚡ ${d.n} strike(s) received` : e.type === "fusion" ? `National scan #${d.id} · ${d.level} · ${d.cells?.total ?? 0} cells · ${d.ms} ms` : e.type === "district_escalation" ? `ESCALATION ${d.name}, ${d.state}: ${d.from} → ${d.to}` : e.type === "ack" ? `Alert ${d.id} acknowledged by ${d.operator}` : e.type;
  return `<div class="${e.level === "alert" ? "alert" : e.level === "warn" ? "warn" : ""}"><time>${fmtTime(e.t, { sec: true, noTz: true })}</time>${esc(msg)}</div>`;
}
function feedsSection() {
  const f = S.status?.feeds || [];
  return sec("Data feeds · freshness", f.length ? f.map((x) => `<div class="feed-row"><div class="fn">${esc(x.name)}</div><div>${stateBadge(x.state)}</div><div class="fp">${esc(x.provider)}${x.data_time ? ` · data ${fmtTime(x.data_time)} (${fmtAge(Date.now() / 1000 - x.data_time)} old)` : ""}${x.detail ? ` · ${esc(x.detail)}` : ""}${x.note ? `<br>${esc(x.note)}` : ""}</div></div>`).join("") : skel(5));
}
function distRow(d) {
  const eta = d.eta ? ` · ETA ${d.eta.first_min} min` : "";
  return `<div class="row" onclick="location.hash='#/district/${d.id}'"><div class="main"><div class="t">${esc(d.name)}</div><div class="d">${esc(d.state)} · ${esc(HZ_LABEL[d.hazard || d.primary_hazard] || "")}${d.peak_lead_h != null ? ` · peak +${d.peak_lead_h} h` : ""}${eta}</div></div><div class="r"><div class="score lvtxt-${d.level}">${d.score}</div>${lvl(d.level)}</div></div>`;
}
function cellRow(c) {
  const nd = c.impact?.now?.districts?.[0] || c.impact?.forecast?.districts?.[0];
  const mv = c.motion?.speed_kmh ? `${Math.round(c.motion.speed_kmh)} km/h ${compass(c.motion.towards_deg)}` : "motion pending";
  const it = c.source === "radar" ? `${c.intensity.max_rain_mmh ?? "—"} mm/h IMERG${c.latent ? ` · ${stateBadge("DELAYED")}` : ""}` : `${c.intensity.min_bt_est_k} K est.`;
  return `<div class="row" onclick="location.hash='#/cell/${c.id}'"><div class="main"><div class="t">${esc(c.id)} · ${esc(HZ_LABEL[c.primary_hazard])}</div><div class="d">${nd ? esc(nd.name + ", " + nd.state) : "Offshore / border"} · ${it} · ${mv} · ${esc(c.trend?.state || "")}</div></div><div class="r">${lvl(c.severity)}<div class="meta">${c.corroboration === "MULTI-SOURCE" ? "multi-source" : "single-source"}</div></div></div>`;
}

// ====================================================================== NATIONAL ATLAS
let atlasFilter = "all";
export async function atlas(body) {
  M.clearDistricts();
  const states = Object.values(S.states).sort((a, b) => b.score - a.score);
  const list = atlasFilter === "high" ? states.filter((s) => ["HIGH", "CRITICAL"].includes(s.level)) : atlasFilter === "medium" ? states.filter((s) => s.score >= 40) : states;
  const cnt = (l) => states.filter((s) => s.level === l).length;
  body.innerHTML = `
    <div class="grid4">${["CRITICAL", "HIGH", "MEDIUM", "LOW"].map((l) => kpi(l, `<span class="lvtxt-${l}">${cnt(l)}</span>`, "states/UTs")).join("")}</div>
    <div class="sec" style="margin-top:10px"><div class="chips">${[["all", "All 36"], ["medium", "Medium+"], ["high", "High+"]].map(([k, t]) => `<button class="chip ${atlasFilter === k ? "active" : ""}" data-f="${k}">${t}</button>`).join("")}</div></div>
    ${sec(`States &amp; Union Territories <span class="meta">(${list.length})</span>`, states.length ? `<div class="list">${list.map((s) => `
      <div class="row" onclick="location.hash='#/atlas/${s.slug}'"><div class="main"><div class="t">${esc(s.name)}</div><div class="d">${s.districts} districts · ${s.counts.HIGH + s.counts.CRITICAL} high+ · ${s.cells} cells · ${s.lightning_30min} strikes/30m</div>${scoreBar(s.score)}</div><div class="r"><div class="score lvtxt-${s.level}">${s.score}</div>${lvl(s.level)}</div></div>`).join("")}</div>` : skel(8))}
    <div class="note">Boundaries: 28 states + 8 UTs, 737 districts (india-maps-data, official GoI depiction). Click a state on the map or in the list to drill down: state → district → city/town → village.</div>`;
  body.querySelectorAll("[data-f]").forEach((b) => (b.onclick = () => { atlasFilter = b.dataset.f; atlas(body); }));
  M.restyleStates();
}
export async function atlasState(body, slug) {
  body.innerHTML = skel(10);
  const r = await api(`/api/states/${slug}/districts`);
  S.selected = { state: slug };
  await M.showDistricts(slug, r.districts);
  M.fitState(slug);
  const st = r.state_threat || {};
  emit("crumbs", [["#/atlas", "India"], [`#/atlas/${slug}`, r.state]]);
  document.getElementById("panelTitle").textContent = r.state;
  body.innerHTML = `
    <div class="hero">${ring(st.score, st.level)}<div><div class="panel-kicker">State threat · 0–6 h</div><div class="hero-l lvtxt-${st.level}">${st.level || "—"}</div><div class="hero-s">${esc(HZ_LABEL[st.primary_hazard] || "")} · ${st.cells ?? 0} active cells · ${st.lightning_30min ?? 0} strikes/30 min · updated ${fmtTime(r.generated_at)}</div></div></div>
    <div class="sec" style="margin-top:10px"><div class="grid4">${["CRITICAL", "HIGH", "MEDIUM", "LOW"].map((l) => kpi(l, `<span class="lvtxt-${l}">${st.counts?.[l] ?? 0}</span>`, "districts")).join("")}</div></div>
    ${sec(`Districts <span class="meta">(${r.districts.length})</span>`, `<input class="field-in" id="dFilter" placeholder="Filter districts" style="width:100%;margin-bottom:8px;border:1px solid var(--line2);border-radius:9px;padding:7px 9px"><div class="list" id="dList">${r.districts.map(distRow2).join("")}</div>`)}`;
  const inp = document.getElementById("dFilter");
  inp.oninput = () => { const q = inp.value.toLowerCase(); document.getElementById("dList").innerHTML = r.districts.filter((d) => d.name.toLowerCase().includes(q)).map(distRow2).join(""); };
}
function distRow2(d) { return `<div class="row" onclick="location.hash='#/district/${d.id}'"><div class="main"><div class="t">${esc(d.name)}</div><div class="d">${esc(HZ_LABEL[d.primary_hazard] || "")}${d.eta ? ` · cell ETA ${d.eta.first_min} min` : ""} · ${(d.sources || []).join(", ") || "no signal"}</div>${scoreBar(d.score)}</div><div class="r"><div class="score lvtxt-${d.level}">${d.score ?? "—"}</div>${lvl(d.level)}</div></div>`; }

export async function district(body, id) {
  body.innerHTML = skel(10);
  const r = await api(`/api/district/${id}`);
  const d = r.district, t = r.threat || {};
  S.selected = { state: d.state_slug, district: d.id };
  const sr = await api(`/api/states/${d.state_slug}/districts`).catch(() => null);
  await M.showDistricts(d.state_slug, sr?.districts || []);
  M.fitBbox(d.bbox);
  M.setSelMarker(null);
  emit("crumbs", [["#/atlas", "India"], [`#/atlas/${d.state_slug}`, d.state], [`#/district/${d.id}`, d.name]]);
  document.getElementById("panelTitle").textContent = `${d.name}`;
  document.getElementById("panelKicker").textContent = `DISTRICT REPORT · ${d.state}`;
  const tl = (t.timeline || []).map((v, i) => ({ lead_h: i, score: v }));
  body.innerHTML = `
    <div class="hero">${ring(t.score, t.level)}<div><div class="panel-kicker">District threat · 0–6 h</div><div class="hero-l lvtxt-${t.level}">${t.level || "—"}</div><div class="hero-s">${esc(HZ_LABEL[t.primary_hazard] || "")} · peak +${t.peak_lead_h ?? 0} h · ${n0(d.area_km2)} km² · sources: ${srcTags(t.sources) || "none"}</div></div></div>
    ${t.eta ? `<div class="warnbox" style="margin-top:10px"><b>Approaching cell ${esc(t.eta.cell)}</b> (${esc(t.eta.severity)} · ${esc(HZ_LABEL[t.eta.hazard])}) — expected arrival in <b>${t.eta.first_min} min</b>${t.eta.last_min ? `, passing by ~${t.eta.last_min} min` : ""}. Arrival window is an EXPERIMENTAL extrapolation.</div>` : ""}
    ${sec("Hazards by lead time", `<div class="hz-grid">${hazardRowsFromDistrict(t)}</div><div class="note" style="margin-top:6px">Peak per hazard over 0–6 h: ${HAZARDS.map((k) => `${HZ_LABEL[k]} ${t.hazards?.[k] ?? 0}`).join(" · ")}</div>`, stateBadge("EXPERIMENTAL"))}
    ${sec("Storm cells affecting district", r.cells.length ? `<div class="list">${r.cells.map((c) => `<div class="row" onclick="location.hash='#/cell/${c.id}'"><div class="main"><div class="t">${esc(c.id)} · ${esc(HZ_LABEL[c.primary_hazard])}</div><div class="d">${c.eta?.first_min != null ? `ETA ${c.eta.first_min} min` : "over district now"} · ${c.motion?.speed_kmh ? `${Math.round(c.motion.speed_kmh)} km/h ${compass(c.motion.towards_deg)}` : "motion pending"}</div></div><div class="r">${lvl(c.severity)}</div></div>`).join("")}</div>` : '<div class="empty">No tracked cell over or heading into this district.</div>')}
    ${officialSection(r.official_alerts)}
    ${sec("INDRA screening alerts", r.alerts.length ? r.alerts.map((a) => `<div class="card alert-card" data-l="${a.level}"><b>${esc(a.title)}</b> ${lvl(a.level)}<div class="meta">${a.status} · issued ${fmtDateTime(a.created_at)} · updated ${ago(a.updated_at)}</div></div>`).join("") : '<div class="empty">No INDRA screening alerts for this district.</div>')}
    ${sec(`Cities &amp; towns <span class="meta">(${r.towns.length} · ${n0(r.village_count)} villages)</span>`, `<input id="tFilter" placeholder="Filter towns / cities" style="width:100%;margin-bottom:8px;border:1px solid var(--line2);border-radius:9px;padding:7px 9px"><div class="list" id="tList">${townRows(r.towns.slice(0, 60))}</div>`)}
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin:6px 0 14px"><button class="btn" id="dWx">Full weather report</button><a class="btn ghost" href="${url(`/api/district/${d.id}`)}" target="_blank" rel="noopener">JSON</a></div>
    ${sec("Safety precautions", precList(r.precautions))}
    <div class="note">${esc(r.hierarchy_note)}</div>${OFFICIAL}`;
  const inp = document.getElementById("tFilter");
  inp.oninput = () => { const q = inp.value.toLowerCase(); document.getElementById("tList").innerHTML = townRows(r.towns.filter((x) => x.name.toLowerCase().includes(q)).slice(0, 80)); };
  document.getElementById("dWx").onclick = () => (location.hash = `#/loc/${d.lat},${d.lon},${encodeURIComponent(d.name + " district")}`);
}
function hazardRowsFromDistrict(t) {
  const h = `<div class="h"></div>${[0, 1, 2, 3, 4, 5, 6].map((i) => `<div class="h">+${i}h</div>`).join("")}<div class="n">Peak threat</div>` + (t.timeline || []).map((v) => `<div class="hz-cell" style="background:${hzColor(v)}">${v}</div>`).join("");
  return h;
}
function townRows(towns) {
  if (!towns.length) return '<div class="empty">No towns match.</div>';
  return towns.map((x) => `<div class="row" onclick="location.hash='#/place/${x.id}'"><div class="main"><div class="t">${esc(x.name)}</div><div class="d">${esc(x.tier)}${x.population ? ` · pop. ${n0(x.population)}` : ""}${x.villages != null ? ` · ${n0(x.villages)} villages` : ""}</div></div><div class="r"><span class="meta mono">${x.lat.toFixed(2)}, ${x.lon.toFixed(2)}</span></div></div>`).join("");
}
export async function place(body, id) {
  body.innerHTML = skel(8);
  const r = await api(`/api/place/${id}/villages`);
  const p = r.place;
  emit("crumbs", [["#/atlas", "India"], ...(p.state ? [[`#/atlas/${slugify(p.state)}`, p.state]] : []), [`#/district/${p.district_id}`, p.district || "District"], [`#/place/${p.id}`, p.name]]);
  document.getElementById("panelTitle").textContent = p.name;
  document.getElementById("panelKicker").textContent = `${(p.tier || "PLACE").toUpperCase()} · ${p.district || ""}, ${p.state || ""}`;
  M.flyTo(p.lat, p.lon, 11); M.setSelMarker([p.lat, p.lon], p.name);
  body.innerHTML = `
    <div style="display:flex;gap:8px;margin-bottom:10px"><button class="btn" id="pWx">Weather &amp; hazard report</button></div>
    ${sec(`Villages grouped under ${esc(p.name)} <span class="meta">(${r.villages.length})</span>`, r.villages.length ? `<input id="vFilter" placeholder="Filter villages" style="width:100%;margin-bottom:8px;border:1px solid var(--line2);border-radius:9px;padding:7px 9px"><div class="list" id="vList">${villRows(r.villages.slice(0, 120))}</div>` : '<div class="empty">No villages in the gazetteer are assigned to this place.</div>')}
    <div class="note">Village coordinates: GeoNames (CC-BY 4.0). Each village is attached to its nearest city/town in the same district.</div>`;
  document.getElementById("pWx").onclick = () => (location.hash = `#/loc/${p.lat},${p.lon},${encodeURIComponent(p.name)}`);
  const inp = document.getElementById("vFilter");
  if (inp) inp.oninput = () => { const q = inp.value.toLowerCase(); document.getElementById("vList").innerHTML = villRows(r.villages.filter((x) => x.name.toLowerCase().includes(q)).slice(0, 200)); };
}
function villRows(vs) { return vs.map((v) => `<div class="row" onclick="location.hash='#/loc/${v.lat},${v.lon},${encodeURIComponent(v.name)}'"><div class="main"><div class="t">${esc(v.name)}</div><div class="d">village · ${v.lat.toFixed(3)}, ${v.lon.toFixed(3)}</div></div><div class="r"><span class="meta">report ›</span></div></div>`).join("") || '<div class="empty">No match.</div>'; }

// ====================================================================== LOCATION REPORT / WEATHER DESK
let modelVar = "precipitation";
export async function location_(body, lat, lon, name) {
  body.innerHTML = `<div class="note">Fetching ECMWF, GFS, ICON, UKMO and AIFS independently…</div>${skel(12)}`;
  M.setSelMarker([lat, lon], name || null);
  M.flyTo(lat, lon, Math.max(M.L_().getZoom(), 9));
  let r;
  try { r = await api(`/api/location?lat=${lat}&lon=${lon}&name=${encodeURIComponent(name || "")}`, { timeout: 45000 }); }
  catch (e) { body.innerHTML = `<div class="empty">Report unavailable: ${esc(e.message)}. ${stateBadge("UNAVAILABLE")}</div>`; return; }
  S.selected = { lat, lon, name: r.location.name, district: r.location.district?.id };
  S.lastLocation = { lat, lon, name: r.location.name };
  const loc = r.location;
  const st = loc.district?.state || r.district_threat?.state;
  emit("crumbs", [["#/atlas", "India"], ...(st ? [[`#/atlas/${slugify(st)}`, st]] : []), ...(loc.district ? [[`#/district/${loc.district.id}`, loc.district.name]] : []), [location.hash, loc.name]]);
  document.getElementById("panelTitle").textContent = loc.name;
  document.getElementById("panelKicker").textContent = loc.district ? `LOCATION REPORT · ${loc.district.name}, ${loc.district.state}` : "LOCATION REPORT";
  const th = r.threat;
  const runs = Object.fromEntries((S.status?.model_runs || []).map((x) => [x.id, x]));
  const mods = r.models.models || [];
  const cur = r.current || {};
  const vars = [["temperature_2m", "Temp °C", 1], ["relative_humidity_2m", "RH %", 0], ["precipitation", "Rain mm/h", 1], ["precipitation_probability", "PoP %", 0], ["wind_speed_10m", "Wind km/h", 0], ["wind_direction_10m", "Dir", 0], ["wind_gusts_10m", "Gust km/h", 0], ["cape", "CAPE J/kg", 0], ["cloud_cover", "Cloud %", 0]];
  const modelsHtml = () => `
    ${sec("Current conditions by model", `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Model</th>${vars.map((v) => `<th>${v[1]}</th>`).join("")}</tr></thead><tbody>${mods.map((m) => {
      const c = cur[m.id];
      return `<tr><td title="${esc(m.centre || "")}">${esc(m.name)}</td>${c ? vars.map(([k, , d]) => `<td>${k === "wind_direction_10m" ? (c[k] == null ? "—" : compass(c[k])) : n0(c[k], d)}</td>`).join("") : `<td colspan="${vars.length}" style="text-align:left">${stateBadge("UNAVAILABLE")} no data for this point</td>`}</tr>`; }).join("")}</tbody></table></div>
      <div class="note" style="margin-top:6px">${mods.map((m) => { const run = runs[m.id]; return `<b>${esc(m.name)}</b>: ${m.status === "NO_DATA" ? "no data" : `run ${run?.run_init ? fmtDateTime(run.run_init) : "n/a"}${run?.available_at ? `, available ${ago(run.available_at)}` : ""}`}`; }).join(" · ")}. Source: Open-Meteo, each model fetched independently. NCMRWF NCUM and IMD WRF: not connected (no public feed).</div>`, stateBadge("LIVE"))}
    ${sec("Model comparison · next 12 h", `<div class="tabs" id="mvTabs">${[["precipitation", "Rain"], ["precipitation_probability", "PoP"], ["cape", "CAPE"], ["wind_gusts_10m", "Gusts"], ["temperature_2m", "Temp"]].map(([k, t]) => `<button class="tab ${modelVar === k ? "active" : ""}" data-v="${k}">${t}</button>`).join("")}</div><div class="chart-box"><canvas id="cModel"></canvas></div><div class="note" id="mvSpread"></div>`)}
`;
  const acts = document.getElementById("panelActions");
  acts.innerHTML = `<button class="btn ghost sm" id="locSave" title="Save to your places">Save</button><button class="btn ghost sm" id="locHome" title="Show this place on Home">Set as Home</button>`;
  document.getElementById("locSave").onclick = () => savePlace({ lat, lon, name: loc.name });
  document.getElementById("locHome").onclick = () => { setHomePlace({ lat, lon, name: loc.name }); toast(`<div class="tb"><div class="tt">${esc(loc.name)} is now your Home place</div></div>`); };
  body.innerHTML = `
    <div class="hero">${ring(th.score, th.level)}<div><div class="panel-kicker">Point threat · next 6 h</div><div class="hero-l lvtxt-${th.level}">${th.level}</div><div class="hero-s">${th.primary_hazard ? esc(HZ_LABEL[th.primary_hazard]) + ` · peak +${th.peak_lead_h} h · ` : ""}${lat.toFixed(3)}°N ${lon.toFixed(3)}°E · ${fmtTime(r.generated_at)}</div></div></div>
    ${plainBlock(r)}
    <div class="sec" style="margin-top:10px"><div class="grid4">
      ${kpi(`Lightning 25 km ${info("Real lightning strikes detected within 25 km of this point (Blitzortung network).")}`, n0(r.lightning.within_25km_15min), `/15 min · ${r.lightning.within_25km_60min}/h`)}
      ${kpi("Nearby cells", n0(r.nearby_cells.length), "within 250 km")}
      ${kpi("Next arrival", r.nearby_cells.find((c) => c.eta_min != null)?.eta_min != null ? r.nearby_cells.find((c) => c.eta_min != null).eta_min + "<small style='font-size:11px'> min</small>" : "—", "tracked cell ETA")}
      ${kpi(`Confidence ${info("How many independent sources (satellite rain, satellite cloud, lightning, models) agree, and how far ahead the peak is.")}`, esc(r.confidence?.label || "—"), (r.confidence?.basis || []).join(", "))}
    </div></div>
    ${sec("Hazard nowcast · 0–6 h", hzGrid(r.nowcast) + `<div class="note" style="margin-top:6px">Each cell: max of observed-cell extrapolation (radar/satellite/lightning) and multi-model mean diagnostic. Model-only signal is capped at HIGH.</div>`, stateBadge("EXPERIMENTAL"))}
    ${can("model_raw") ? modelsHtml() : sec("Model-by-model data", lockedCard("Per-model data from ECMWF, GFS, ICON, UKMO and AIFS, with comparison charts", "professional", "INDRA already blends these models into the best estimate above. The raw model-by-model numbers and charts are for professional users."))}
    ${sec("Nearby storm cells", r.nearby_cells.length ? `<div class="list">${r.nearby_cells.map((c) => `<div class="row" onclick="location.hash='#/cell/${c.id}'"><div class="main"><div class="t">${esc(c.id)} · ${esc(HZ_LABEL[c.primary_hazard])}</div><div class="d">${c.distance_km} km away · ${c.latent ? `observed ${fmtAge(Date.now() / 1000 - c.obs_time)} ago (IMERG) · no ETA` : c.eta_min != null ? `<b>ETA ${c.eta_min} min</b>` : "not heading here"} · ${c.motion?.speed_kmh ? `${Math.round(c.motion.speed_kmh)} km/h ${compass(c.motion.towards_deg)}` : "motion pending"}</div></div><div class="r">${lvl(c.severity)}</div></div>`).join("")}</div>` : '<div class="empty">No precipitation or satellite convective cell within 250 km.</div>')}
    ${officialSection(r.official_alerts?.alerts)}
    ${sec("Safety precautions", precList(r.precautions))}
    ${OFFICIAL}
    ${sec("Report observed weather", can("feedback") ? feedbackForm(loc.name) : lockedCard("Report what you see (hail, storm, flooding)", "public", "Ground-truth reports help score INDRA. Reporting needs a free public account."))}`;
  const draw = () => {
    if (!can("model_raw") || !document.getElementById("cModel")) return;
    destroyCharts();
    const times = (r.models.times || []).slice(0, 13).map((t) => t.slice(11, 16));
    const pal = ["#0098bd", "#e2621f", "#6b4fd8", "#23a597", "#cc1f55"];
    chart(document.getElementById("cModel"), { type: "line", data: { labels: times, datasets: mods.filter((m) => m.status !== "NO_DATA").map((m, i) => ({ label: m.name, data: (m.hourly[modelVar] || []).slice(0, 13), borderColor: pal[i % 5], backgroundColor: pal[i % 5], tension: 0.3, pointRadius: 1.5, borderWidth: 2, spanGaps: true })) },
      options: baseOpts({ plugins: { legend: { display: true, labels: { boxWidth: 10, font: { size: 10 } } } } }) });
    const e = r.ensemble?.[0]?.[modelVar];
    document.getElementById("mvSpread").textContent = e ? `Now: mean ${n0(e.mean, 1)}, spread ${n0(e.spread, 1)} across ${e.n} models (${e.spread > Math.abs(e.mean) * 0.6 ? "low" : "reasonable"} agreement). Times in UTC.` : "Times in UTC.";
  };
  draw();
  body.querySelectorAll("#mvTabs .tab").forEach((b) => (b.onclick = () => { modelVar = b.dataset.v; body.querySelectorAll("#mvTabs .tab").forEach((x) => x.classList.toggle("active", x === b)); draw(); }));
  bindFeedback(body, loc.name);
}
const CITIES = [["New Delhi", 28.6139, 77.209], ["Mumbai", 19.076, 72.8777], ["Kolkata", 22.5726, 88.3639], ["Chennai", 13.0827, 80.2707], ["Bengaluru", 12.9716, 77.5946], ["Hyderabad", 17.385, 78.4867], ["Guwahati", 26.1445, 91.7362], ["Bhubaneswar", 20.2961, 85.8245], ["Patna", 25.5941, 85.1376], ["Lucknow", 26.8467, 80.9462], ["Meerut", 28.9845, 77.7064], ["Jaipur", 26.9124, 75.7873], ["Ahmedabad", 23.0225, 72.5714], ["Thiruvananthapuram", 8.5241, 76.9366], ["Srinagar", 34.0837, 74.7973], ["Dehradun", 30.3165, 78.0322]];
export async function weather(body) {
  if (S.lastLocation) { location.hash = `#/loc/${S.lastLocation.lat},${S.lastLocation.lon},${encodeURIComponent(S.lastLocation.name)}`; return; }
  body.innerHTML = `
    ${sec("Pick a location", `<div class="note" style="margin-bottom:8px">Search any state, district, city, town or village above, click anywhere on the map, or choose:</div><div class="chips">${CITIES.map(([n, la, lo]) => `<button class="chip" onclick="location.hash='#/loc/${la},${lo},${encodeURIComponent(n)}'">${n}</button>`).join("")}</div>`)}
    <button class="btn" id="geoBtn">Use my location</button>
    ${sec("What you get", `<ul class="prec"><li>Independent current conditions from ECMWF IFS, NCEP GFS, DWD ICON, UK Met Office and ECMWF AIFS</li><li>Hazard nowcast 0–6 h for thunderstorm, lightning, hail, cloudburst, downburst and heavy rain</li><li>Nearby tracked storm cells with arrival time</li><li>Live lightning count within 25 km</li><li>Precautions and official IMD links</li></ul>`)}`;
  document.getElementById("geoBtn").onclick = () => {
    if (!navigator.geolocation) return toast("Geolocation not supported by this browser.");
    navigator.geolocation.getCurrentPosition((p) => (location.hash = `#/loc/${p.coords.latitude.toFixed(4)},${p.coords.longitude.toFixed(4)},${encodeURIComponent("My location")}`), () => toast("Location permission denied."));
  };
}
function feedbackForm(name) {
  return `<form id="fbForm" class="card" style="display:grid;gap:8px"><div class="grid2"><label class="field">Event<select name="event_type">${["THUNDERSTORM", "HAIL", "CLOUDBURST", "HEAVY_RAIN", "LIGHTNING", "DOWNBURST", "FLASH_FLOOD", "OTHER"].map((x) => `<option>${x}</option>`).join("")}</select></label><label class="field">Outcome<select name="outcome"><option>OBSERVED</option><option>NOT_OBSERVED</option><option>UNKNOWN</option></select></label></div><label class="field">Location<input name="location" value="${esc(name || "")}"></label><label class="field">Notes<textarea name="notes" rows="2" placeholder="e.g. hail 1 cm at 16:40 IST"></textarea></label><button class="btn sm" type="submit">Submit ground truth</button><div class="note">Stored in the verification archive for POD/FAR/CSI evaluation.</div></form>`;
}
function bindFeedback(root) {
  const f = root.querySelector("#fbForm"); if (!f) return;
  f.onsubmit = async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(f));
    try { await api("/api/feedback", { method: "POST", body: JSON.stringify(d) }); toast("<div class='tb'><div class='tt'>Ground-truth report saved</div><div class='ts'>Added to the verification archive.</div></div>"); f.reset(); }
    catch (err) { toast(`<div class='tb'><div class='tt'>Could not save</div><div class='ts'>${esc(err.message)}</div></div>`); }
  };
}

// ====================================================================== RADAR & SATELLITE
export async function radarsat(body) {
  const st = S.status || {};
  const feeds = Object.fromEntries((st.feeds || []).map((f) => [f.id, f]));
  const r = st.radar || {}, s = st.satellite || {}, lg = st.lightning || {};
  const satOn = M.LAYERS.find((l) => l.wms && l.on);
  body.innerHTML = `
    ${sec("View presets", `<div class="chips">
      <button class="chip" data-p="radar">IMERG rain loop</button><button class="chip" data-p="satir">Satellite IR loop</button><button class="chip" data-p="combo">IR + rain + lightning</button><button class="chip" data-p="him">Himawari IR (GIBS)</button><button class="chip" data-p="conv">Convection RGB + lightning</button><button class="chip" data-p="cth">Cloud-top height</button><button class="chip" data-p="qc">Rain QC grid + cells</button></div>`)}
    ${sec("Loop playback", `<div class="grid2"><button class="btn ghost" id="lpPlay">${M.radarLoop.playing || M.satLoop.playing ? "Pause loop" : "Play loop"}</button><label class="field">Speed<select id="lpSpeed"><option value="1100">Slow</option><option value="700" selected>Normal</option><option value="350">Fast</option></select></label></div><div class="note" style="margin-top:6px">Use the time bar on the map to scrub frames. The newest frame is labelled LIVE; older frames ARCHIVE.</div>`)}
    ${sec("Precipitation · NASA GIBS IMERG", `<div class="card"><div class="kv"><dt>Status</dt><dd>${stateBadge(feeds.radar?.state)}</dd><dt>Product</dt><dd>GPM IMERG Early · 30-min rain rate · 0.1°</dd><dt>Latest frame</dt><dd>${fmtTime(r.frame_time)} (${fmtAge(feeds.radar?.age_s)} old)</dd><dt>Frames in loop</dt><dd>${S.radar?.frames?.length ?? 0}</dd><dt>Rain cells ≥5.6 mm/h</dt><dd>${r.cells ?? "—"}</dd><dt>Rain area ≥0.65 mm/h</dt><dd>${n0(r.echo_area_km2)} km²</dd><dt>Himawari-9 IR (GIBS)</dt><dd>${stateBadge(S.radar?.himawari?.status)} ${S.radar?.himawari?.frames?.length ? fmtTime(S.radar.himawari.frames.at(-1).time) : ""}</dd></div><div class="note" style="margin-top:6px">${esc(S.radar?.notice || "")} Colours are decoded to mm/h using the official GIBS colour map; equivalent reflectivity (dBZe, Z = 200R<sup>1.6</sup>) is ${stateBadge("ESTIMATED")}. IMD Doppler radar: ${stateBadge("NOT CONNECTED")}.</div></div>`)}

    ${sec("Geostationary satellite", `<div class="card"><div class="kv"><dt>Status</dt><dd>${stateBadge(feeds.satellite?.state)}</dd><dt>Latest processed</dt><dd>${fmtTime(s.frame_time)} (${fmtAge(feeds.satellite?.age_s)} old)</dd><dt>Cold-cloud objects ≤235 K</dt><dd>${s.objects ?? "—"}</dd><dt>Initiation / rapid cooling</dt><dd>${s.convective_initiation ?? "—"}</dd><dt>Cold-cloud area</dt><dd>${n0(s.cold_cloud_area_km2)} km²</dd><dt>Showing</dt><dd>${satOn ? esc(satOn.label) : "off"}</dd></div><div class="note" style="margin-top:6px">EUMETSAT Meteosat IODC (SEVIRI) every 15 min. Brightness temperature is ${stateBadge("ESTIMATED")} from rendered imagery. INSAT-3DR/3DS: ${stateBadge("NOT CONNECTED")} (MOSDAC registration required).</div></div>`)}
    ${sec("Lightning", `<div class="card"><div class="kv"><dt>Status</dt><dd>${stateBadge(feeds.lightning?.state)}</dd><dt>Uplink</dt><dd>${esc(lg.host || "—")} · since ${fmtTime(lg.since)}</dd><dt>Strikes over India 15 / 60 min</dt><dd>${n0(S.national?.lightning?.last_15min)} / ${n0(S.national?.lightning?.last_60min)}</dd><dt>Global packets received</dt><dd>${n0(lg.global_rx)}</dd><dt>Last India strike</dt><dd>${lg.last_strike ? ago(lg.last_strike) : "none yet"}</dd></div><div class="chart-box sm" style="margin-top:8px"><canvas id="cLtg"></canvas></div><div class="note">Blitzortung.org volunteer network — live detections, non-authoritative; detection efficiency over India varies. IMD/IITM lightning network: ${stateBadge("NOT CONNECTED")}.</div></div>`)}
    ${sec("Hotspots · 30 min", '<div id="ltgHot" class="list"><div class="skel"></div></div>')}`;
  const preset = (p) => {
    const set = (ids) => M.LAYERS.forEach((l) => { if (["radar", "radarqc", "lightning", "cells", "himawari"].includes(l.id) || l.wms) M.setLayer(l.id, ids.includes(l.id)); });
    ({ radar: () => { set(["radar", "lightning", "cells"]); M.timeMode.mode = "radar"; }, satir: () => { set(["sat_ir108"]); M.timeMode.mode = "sat"; }, combo: () => { set(["sat_ir108", "radar", "lightning", "cells"]); M.timeMode.mode = "radar"; }, conv: () => { set(["sat_convection", "lightning", "cells"]); M.timeMode.mode = "sat"; }, cth: () => { set(["sat_cth", "cells"]); M.timeMode.mode = "sat"; }, him: () => { set(["himawari", "radar", "cells"]); M.timeMode.mode = "radar"; }, qc: () => { set(["radarqc", "cells"]); M.timeMode.mode = "auto"; } })[p]();
    M.updateTimebar(); radarsat(body);
  };
  body.querySelectorAll("[data-p]").forEach((b) => (b.onclick = () => preset(b.dataset.p)));
  document.getElementById("lpPlay").onclick = () => { document.getElementById("tbPlay").click(); setTimeout(() => radarsat(body), 50); };
  document.getElementById("lpSpeed").onchange = (e) => { [M.radarLoop, M.satLoop].forEach((l) => { l.speed = +e.target.value; if (l.playing) { l.stop(true); l.play(); } }); };
  api("/api/lightning?minutes=30").then((d) => {
    const tr = d.trend || { counts: [] }, bm = tr.bin_minutes || 5, nb = tr.counts.length;
    chart(document.getElementById("cLtg"), { type: "bar", data: { labels: tr.counts.map((_, i) => fmtTime(tr.end - (nb - 1 - i) * bm * 60, { noTz: true })), datasets: [{ label: "Strikes / 5 min", data: tr.counts, backgroundColor: "rgba(122,92,255,.55)", borderRadius: 2 }] }, options: baseOpts({ scales: { x: { ticks: { maxTicksLimit: 6 }, grid: { display: false } }, y: { beginAtZero: true, grid: { color: gridC } } } }) });
    const hot = (d.density?.cells || []).slice(0, 8);
    const el = document.getElementById("ltgHot");
    if (el) el.innerHTML = hot.length ? hot.map((h) => `<div class="row" onclick="location.hash='#/loc/${h.lat},${h.lon},${encodeURIComponent((h.district || "Lightning hotspot"))}'"><div class="main"><div class="t">${esc(h.district || `${h.lat.toFixed(2)}, ${h.lon.toFixed(2)}`)}</div><div class="d">${esc(h.state || "")} · ${h.lat.toFixed(2)}°N ${h.lon.toFixed(2)}°E</div></div><div class="r"><div class="score">${h.count}</div><div class="meta">strikes</div></div></div>`).join("") : '<div class="empty">No lightning detected over India in the last 30 minutes.</div>';
  }).catch(() => {});
}

// ====================================================================== STORM INTELLIGENCE
let stormFilter = "all";
export async function storms(body) {
  M.selectCellOnMap(null);
  const all = S.cells;
  const list = stormFilter === "radar" ? all.filter((c) => c.source === "radar") : stormFilter === "satellite" ? all.filter((c) => c.source === "satellite") : stormFilter === "severe" ? all.filter((c) => ["HIGH", "CRITICAL"].includes(c.severity)) : stormFilter === "moving" ? all.filter((c) => c.motion?.speed_kmh) : all;
  body.innerHTML = `
    <div class="grid4">${kpi("Cells", all.length, "tracked")}${kpi("IMERG rain", all.filter((c) => c.source === "radar").length, "≥5.6 mm/h")}${kpi("Satellite", all.filter((c) => c.source === "satellite").length, "cold tops")}${kpi("Growing", all.filter((c) => /INTENSIFYING/.test(c.trend?.state)).length, "growth")}</div>
    <div class="sec" style="margin-top:10px"><div class="chips">${[["all", "All"], ["severe", "High+"], ["radar", "IMERG rain"], ["satellite", "Satellite"], ["moving", "Tracked motion"]].map(([k, t]) => `<button class="chip ${stormFilter === k ? "active" : ""}" data-f="${k}">${t}</button>`).join("")}</div></div>
    ${sec(`Active cells <span class="meta">(${list.length})</span>`, list.length ? `<div class="list">${list.map(cellRow).join("")}</div>` : '<div class="empty">No cells match this filter.</div>')}
    ${sec("Observed replay · last 24 h", `<div class="card"><div class="note">Replays IMERG rain cells archived by this instance (real observations).</div><input type="range" id="rpRange" min="0" max="0" value="0" style="margin-top:8px"><div class="meta mono" id="rpTime">loading…</div><div style="display:flex;gap:6px;margin-top:6px"><button class="btn ghost sm" id="rpPlay">Play</button><button class="btn ghost sm" id="rpClear">Clear</button><button class="btn ghost sm" id="rpDemo">Training simulation</button></div></div>`, stateBadge("ARCHIVE"))}
    <div class="note box">Detection: NASA GIBS IMERG rain ≥5.6 mm/h connected regions (0.1° product on INDRA's 0.025° grid) — IMERG arrives ~4–6 h late, so these cells are history, not current positions; satellite IR ≤235 K objects. Tracking: overlap-weighted matching across frames. Corridor: linear extrapolation with uncertainty growing ~0.3 km/min. ${stateBadge("EXPERIMENTAL")}</div>`;
  body.querySelectorAll("[data-f]").forEach((b) => (b.onclick = () => { stormFilter = b.dataset.f; storms(body); }));
  setupReplay();
}
let replayLayer = null, replayTimer = null;
async function setupReplay() {
  const h = await api("/api/history?hours=24").catch(() => null);
  const snaps = (h?.cells || []).filter((x) => x.source === "radar");
  const rg = document.getElementById("rpRange"), tm = document.getElementById("rpTime");
  if (!rg) return;
  const map = M.L_();
  const clear = () => { if (replayLayer) map.removeLayer(replayLayer); replayLayer = null; clearInterval(replayTimer); replayTimer = null; };
  if (!snaps.length) { tm.textContent = "No archived frames yet — the archive grows every IMERG cycle (30 min)."; }
  rg.max = Math.max(0, snaps.length - 1); rg.value = rg.max;
  const show = (i) => {
    const s = snaps[i]; if (!s) return;
    if (!replayLayer) replayLayer = L.layerGroup().addTo(map);
    replayLayer.clearLayers();
    s.cells.forEach((c) => L.circleMarker([c.lat, c.lon], { radius: Math.max(4, Math.min(12, (c.dbz - 30) / 2.5)), color: "#fff", weight: 1.5, fillColor: c.dbz >= 55 ? LV_COLOR.CRITICAL : c.dbz >= 48 ? LV_COLOR.HIGH : c.dbz >= 42 ? LV_COLOR.MEDIUM : LV_COLOR.LOW, fillOpacity: 0.85, pane: "cells" }).bindTooltip(`${esc(c.id)} · ${c.dbz} dBZ`, { className: "ix-tip" }).addTo(replayLayer));
    tm.textContent = `${fmtDateTime(s.at)} · ${s.cells.length} cells · frame ${i + 1}/${snaps.length} (OBSERVED)`;
  };
  rg.oninput = () => show(+rg.value);
  document.getElementById("rpPlay").onclick = () => { if (!snaps.length) return; if (replayTimer) { clearInterval(replayTimer); replayTimer = null; return; } replayTimer = setInterval(() => { rg.value = (+rg.value + 1) % snaps.length; show(+rg.value); }, 500); };
  document.getElementById("rpClear").onclick = clear;
  document.getElementById("rpDemo").onclick = async () => {
    if (!can("replay")) { emit("locked", { feature: "replay", what: "Storm replay", required_tier: "professional" }); return; }
    clear();
    const d = await api("/api/replay/demo");
    replayLayer = L.layerGroup().addTo(map);
    L.polyline(d.track.map((p) => [p.lat, p.lon]), { color: "#6b4fd8", dashArray: "4 4" }).addTo(replayLayer);
    let k = 0; const mk = L.circleMarker([d.track[0].lat, d.track[0].lon], { radius: 8, color: "#fff", fillColor: "#6b4fd8", fillOpacity: 0.9 }).addTo(replayLayer).bindTooltip("SIMULATION", { permanent: true, className: "ix-tip" });
    map.flyTo([d.track[0].lat, d.track[0].lon], 8);
    tm.innerHTML = `${stateBadge("SIMULATION")} ${esc(d.notice)}`;
    replayTimer = setInterval(() => { k = (k + 1) % d.track.length; const p = d.track[k]; mk.setLatLng([p.lat, p.lon]); mk.setRadius(p.radius_km / 2); }, 400);
  };
}
export async function cell(body, id) {
  let c = S.cells.find((x) => x.id === id);
  if (!c) { try { c = await api(`/api/cells/${id}`); } catch (_) { body.innerHTML = `<div class="empty">Cell ${esc(id)} is no longer active (dissipated or merged). ${stateBadge("EXPIRED")}</div>`; return; } }
  M.selectCellOnMap(id);
  M.flyTo(c.lat, c.lon, 8);
  document.getElementById("panelTitle").textContent = `${c.id} · ${HZ_LABEL[c.primary_hazard]}`;
  document.getElementById("panelKicker").textContent = `STORM CELL · ${c.source.toUpperCase()} · ${c.corroboration}`;
  emit("crumbs", [["#/storms", "Storm intelligence"], [`#/cell/${id}`, id]]);
  const it = c.intensity, mv = c.motion, im = c.impact;
  body.innerHTML = `
    <div class="hero">${ring(c.severity_score, c.severity)}<div><div class="panel-kicker">${esc(c.status_label)}</div><div class="hero-l lvtxt-${c.severity}">${c.severity}</div><div class="hero-s">${esc(c.trend?.state || "")} · age ${c.age_min} min · ${srcTags(c.sources)}</div></div></div>
    ${sec("Intensity &amp; motion", `<div class="card"><div class="kv">${c.source === "radar" ? `<dt>Observed</dt><dd>${fmtTime(c.obs_time)} ${c.latent ? stateBadge("DELAYED") : ""} <span class="meta">${esc(c.status_label || "")}</span></dd><dt>Max rain rate</dt><dd>${it.max_rain_mmh ?? "—"} mm/h (IMERG)</dd><dt>90th pct rain rate</dt><dd>${it.p90_rain_mmh ?? "—"} mm/h</dd><dt>Equivalent reflectivity</dt><dd>${it.max_dbz} dBZe ${stateBadge("ESTIMATED")}</dd>` : ""}${it.min_bt_est_k ? `<dt>Min cloud-top BT</dt><dd>${it.min_bt_est_k} K ${stateBadge("ESTIMATED")}</dd>` : ""}${it.cooling_k_15min != null ? `<dt>Cloud-top cooling</dt><dd>${it.cooling_k_15min} K/15 min</dd>` : ""}<dt>Area</dt><dd>${n0(c.area_km2)} km²</dd><dt>Centroid</dt><dd>${c.lat.toFixed(3)}°N ${c.lon.toFixed(3)}°E</dd><dt>Movement</dt><dd>${mv?.speed_kmh ? `${n0(mv.speed_kmh)} km/h towards ${compass(mv.towards_deg)} (${n0(mv.towards_deg)}°)` : "not yet tracked (needs 2+ frames)"}</dd><dt>Motion method</dt><dd>${esc(mv?.method || "—")}${mv?.samples ? ` · ${mv.samples} frames` : ""}</dd><dt>Trend</dt><dd>${esc(c.trend?.state)}${c.trend?.intensity_change_h != null ? ` (${c.trend.intensity_change_h > 0 ? "+" : ""}${n0(c.trend.intensity_change_h)}/h)` : ""}</dd><dt>Lightning in cell</dt><dd>${c.lightning_15min} / 15 min</dd></div></div>`)}
    ${sec("Intensity history", `<div class="chart-box sm"><canvas id="cCell"></canvas></div>`)}
    ${sec("Hazard scores", `<div class="list">${HAZARDS.map((k) => `<div style="display:grid;grid-template-columns:120px 1fr 34px;gap:8px;align-items:center;font-size:12.5px"><span>${HZ_LABEL[k]}</span>${scoreBar(c.hazards[k])}<span class="mono" style="text-align:right">${c.hazards[k]}</span></div>`).join("")}</div>${c.corroboration === "SINGLE-SOURCE" ? `<div class="note" style="margin-top:6px">Single observing system only — scores capped (radar ≤65, satellite ≤55) until lightning or a second sensor confirms.</div>` : ""}`)}
    ${sec("Impact · now", `<div class="grid3">${kpi("Area", n0(im.now.area_km2), "km²")}${kpi("Towns", n0(im.now.towns))}${kpi("Villages", n0(im.now.villages))}</div><div class="note" style="margin-top:6px">${im.now.districts.map((d) => `<a href="#/district/${d.id}">${esc(d.name)}</a>`).join(", ") || "Offshore / outside India"}</div>`)}
    ${sec(`Forecast corridor · next ${c.forecast_path.at(-1)?.lead_min ?? 0} min`, `<div class="grid3">${kpi("Corridor", n0(im.forecast.area_km2), "km²")}${kpi("Towns", n0(im.forecast.towns), `pop. ${n0(im.forecast.town_population)}`)}${kpi("Villages", n0(im.forecast.villages))}</div>
      <div class="sec" style="margin-top:8px"><table class="tbl"><thead><tr><th>District in path</th><th>Arrival</th><th>Clears</th></tr></thead><tbody>${im.forecast.districts.slice(0, 12).map((d) => `<tr onclick="location.hash='#/district/${d.id}'" style="cursor:pointer"><td>${esc(d.name)}, <span class="meta">${esc(d.state)}</span></td><td>${d.first_min != null ? `+${d.first_min} min` : "now"}</td><td>${d.last_min != null ? `+${d.last_min} min` : "—"}</td></tr>`).join("") || '<tr><td colspan="3">No districts in corridor</td></tr>'}</tbody></table></div>
      ${im.forecast.top_settlements?.length ? `<div class="note"><b>Largest settlements in path:</b> ${im.forecast.top_settlements.map((s) => `<a href="#/loc/${s.lat},${s.lon},${encodeURIComponent(s.name)}">${esc(s.name)}</a>${s.eta_min != null ? ` (+${s.eta_min} min)` : ""}`).join(", ")}</div>` : ""}
      <div class="note">${esc(c.forecast_label)}. Uncertainty radius grows from ${c.forecast_path[0]?.radius_km ?? "—"} km to ${c.forecast_path.at(-1)?.radius_km ?? "—"} km.</div>`, stateBadge("EXPERIMENTAL"))}
    ${sec("Confidence", confBox(c.confidence))}
    ${sec("Environment (model)", c.environment ? `<div class="kv">${Object.entries(c.environment).map(([k, v]) => `<dt>${esc(k.replace(/_/g, " "))}</dt><dd>${n0(v, 1)}</dd>`).join("")}</div>` : '<div class="empty">Model environment unavailable.</div>')}
    ${sec("Precautions", precList(c.precautions))}${OFFICIAL}`;
  const hist = c.history || [];
  chart(document.getElementById("cCell"), { type: "line", data: { labels: hist.map((h) => fmtTime(h.t, { noTz: true })), datasets: [{ label: c.source === "radar" ? "Max dBZe (IMERG)" : "Min BT (K, est.)", data: hist.map((h) => h.v), borderColor: "#0098bd", backgroundColor: "rgba(25,191,224,.15)", fill: true, tension: 0.3 }, { label: "Area km²", data: hist.map((h) => h.area), borderColor: "#e2621f", yAxisID: "y1", tension: 0.3, pointRadius: 2 }] }, options: baseOpts({ plugins: { legend: { display: true, labels: { boxWidth: 10 } } }, scales: { x: { grid: { color: gridC } }, y: { beginAtZero: false, grid: { color: gridC }, reverse: c.source !== "radar" }, y1: { position: "right", grid: { display: false } } } }) });
}

// ====================================================================== NOWCASTING ENGINE
export async function nowcast(body) {
  M.timeMode.mode = "nowcast";
  if (!M.layerOn("hazard")) M.setLayer("hazard", true);
  M.updateTimebar();
  const hz = M.hazardState.hazard, lead = M.hazardState.lead;
  body.innerHTML = `
    <div class="warnbox">INDRA nowcasts are ${stateBadge("EXPERIMENTAL")} and not validated against an independent archive. They screen for risk; they are not official forecasts.</div>
    ${sec("Hazard", `<div class="chips">${["all", ...HAZARDS].map((k) => `<button class="chip ${hz === k ? "active" : ""}" data-h="${k}">${HZ_LABEL[k]}</button>`).join("")}</div>`)}
    ${sec("Lead time", `<input type="range" id="ncLead" min="0" max="6" value="${lead}"><div class="tb-ticks mono">${[0, 1, 2, 3, 4, 5, 6].map((h) => `<span>+${h}h</span>`).join("")}</div>`)}
    <div id="ncBody">${skel(8)}</div>`;
  body.querySelectorAll("[data-h]").forEach((b) => (b.onclick = () => { M.hazardState.hazard = b.dataset.h; M.refreshHazard(); M.updateTimebar(); nowcast(body); }));
  document.getElementById("ncLead").oninput = (e) => { M.hazardState.lead = +e.target.value; M.refreshHazard(); M.updateTimebar(); loadNc(); };
  const loadNc = async () => {
    const r = await api(`/api/nowcast?hazard=${M.hazardState.hazard}&lead=${M.hazardState.lead}`).catch(() => null);
    const el = document.getElementById("ncBody"); if (!el || !r) return;
    if (r.status !== "OK") { el.innerHTML = '<div class="empty">Nowcast engine initialising.</div>'; return; }
    destroyCharts();
    el.innerHTML = `
      <div class="grid4">${["CRITICAL", "HIGH", "MEDIUM", "LOW"].map((l) => kpi(l, `<span class="lvtxt-${l}">${r.counts[l]}</span>`, `districts ≥ at +${r.lead_h} h`)).join("")}</div>
      ${sec("National peak by hazard · 0–6 h", `<div class="chart-box"><canvas id="cNc"></canvas></div>`)}
      ${sec(`Top districts · ${esc(HZ_LABEL[r.hazard])} · +${r.lead_h} h`, r.districts.length ? `<div class="list">${r.districts.slice(0, 20).map((d) => `<div class="row" onclick="location.hash='#/district/${d.id}'"><div class="main"><div class="t">${esc(d.name)}</div><div class="d">${esc(d.state)} · ${srcTags(d.sources)}</div>${scoreBar(d.score)}</div><div class="r"><div class="score lvtxt-${d.level}">${d.score}</div>${lvl(d.level)}</div></div>`).join("")}</div>` : '<div class="empty">No district above LOW for this hazard and lead.</div>')}
      ${sec("Method", `<div class="kv">${Object.entries(r.method).map(([k, v]) => `<dt>${esc(k)}</dt><dd style="text-align:left;font-family:var(--f-body)">${esc(v)}</dd>`).join("")}</div>`)}`;
    const pal = { thunderstorm: "#0098bd", lightning: "#6b4fd8", hail: "#23a597", cloudburst: "#cc1f55", downburst: "#e2621f", heavy_rain: "#2f6fb5" };
    chart(document.getElementById("cNc"), { type: "line", data: { labels: [0, 1, 2, 3, 4, 5, 6].map((h) => `+${h}h`), datasets: HAZARDS.map((k) => ({ label: HZ_LABEL[k], data: r.by_hazard?.[k] || [], borderColor: pal[k], backgroundColor: pal[k], tension: 0.3, borderWidth: k === r.hazard ? 3 : 1.5, pointRadius: 2 })) }, options: baseOpts({ plugins: { legend: { display: true, labels: { boxWidth: 10, font: { size: 10 } } } }, scales: { x: { grid: { color: gridC } }, y: { max: 100, beginAtZero: true, grid: { color: gridC } } } }) });
  };
  loadNc();
  nowcast.reload = loadNc;
}

// ====================================================================== IMPACT INTELLIGENCE
export async function impact(body) {
  const cells = S.cells.filter((c) => HZ_LABEL[c.primary_hazard] && c.severity !== "MINIMAL");
  const dist = new Map(); const sets = new Map(); const states = new Map();
  let areaNow = 0, areaFc = 0, townsFc = 0, villFc = 0, popFc = 0, villNow = 0;
  for (const c of cells) {
    areaNow += c.impact.now.area_km2 || 0; areaFc += c.impact.forecast.area_km2 || 0;
    townsFc += c.impact.forecast.towns || 0; villFc += c.impact.forecast.villages || 0; popFc += c.impact.forecast.town_population || 0; villNow += c.impact.now.villages || 0;
    for (const d of [...c.impact.now.districts.map((x) => ({ ...x, first_min: 0 })), ...c.impact.forecast.districts]) {
      const k = d.id, prev = dist.get(k);
      const eta = d.first_min ?? 0;
      if (!prev || eta < prev.eta || LEVELS.indexOf(c.severity) > LEVELS.indexOf(prev.level)) dist.set(k, { id: d.id, name: d.name, state: d.state, eta: prev ? Math.min(prev.eta, eta) : eta, level: prev && LEVELS.indexOf(prev.level) > LEVELS.indexOf(c.severity) ? prev.level : c.severity, cells: (prev?.cells || 0) + 1, hazard: c.primary_hazard });
      states.set(d.state, (states.get(d.state) || 0) + 1);
    }
    for (const s of c.impact.forecast.top_settlements || []) { const p = sets.get(s.name + s.lat); if (!p || (s.eta_min ?? 999) < (p.eta_min ?? 999)) sets.set(s.name + s.lat, { ...s, level: c.severity, cell: c.id }); }
  }
  const dl = [...dist.values()].sort((a, b) => LEVELS.indexOf(b.level) - LEVELS.indexOf(a.level) || a.eta - b.eta);
  const sl = [...sets.values()].sort((a, b) => (b.population || 0) - (a.population || 0));
  body.innerHTML = `
    <div class="grid3">${kpi("Districts affected", dl.length, "now + 2–3 h corridor")}${kpi("Area under cells", big(areaNow), "km² now")}${kpi("Corridor area", big(areaFc), "km² forecast")}${kpi("Villages in path", big(villFc), `${n0(villNow)} under cells now`)}${kpi("Towns in path", big(townsFc))}${kpi("Town population", big(popFc), "GeoNames, indicative")}</div>
    ${sec("Districts by severity &amp; arrival", dl.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>District</th><th>Level</th><th>Arrival</th><th>Cells</th></tr></thead><tbody>${dl.slice(0, 40).map((d) => `<tr style="cursor:pointer" onclick="location.hash='#/district/${d.id}'"><td>${esc(d.name)} <span class="meta">${esc(d.state)}</span></td><td>${lvl(d.level)}</td><td>${d.eta ? `+${d.eta} min` : "now"}</td><td>${d.cells}</td></tr>`).join("")}</tbody></table></div>` : '<div class="empty">No populated area is under or in the path of a tracked cell.</div>')}
    ${sec("Largest settlements in storm paths", sl.length ? `<div class="list">${sl.slice(0, 15).map((s) => `<div class="row" onclick="location.hash='#/loc/${s.lat},${s.lon},${encodeURIComponent(s.name)}'"><div class="main"><div class="t">${esc(s.name)}</div><div class="d">${s.population ? `pop. ${n0(s.population)} · ` : ""}cell ${esc(s.cell)}${s.eta_min != null ? ` · ETA +${s.eta_min} min` : ""}</div></div><div class="r">${lvl(s.level)}</div></div>`).join("")}</div>` : '<div class="empty">No towns in current corridors.</div>')}
    ${sec("States with exposure", [...states.entries()].sort((a, b) => b[1] - a[1]).map(([s, n]) => `<span class="chip" style="display:inline-block;margin:2px">${esc(s)} · ${n}</span>`).join("") || '<div class="empty">None</div>')}
    <div class="note box">Impact = settlements (GeoNames) and district polygons intersecting the observed cell footprint and the extrapolated corridor. Population is the town census figure in GeoNames, not exposure-weighted. ${stateBadge("ESTIMATED")}</div>`;
}

// ====================================================================== ALERT COMMAND CENTRE
let alertTab = "active", alertLevel = "all";
export async function alerts(body, args) {
  if (args?.[0] && ["active", "log", "official", "settings"].includes(args[0])) alertTab = args[0];
  const act = S.alerts;
  const counts = Object.fromEntries(LEVELS.map((l) => [l, act.filter((a) => a.level === l && a.status === "ACTIVE").length]));
  body.innerHTML = `
    <div class="tabs">${[["active", `Active (${act.filter((a) => a.status === "ACTIVE").length})`], ["log", "History log"], ["official", `Official (${S.official?.active ?? 0})`], ["settings", "Settings"]].map(([k, t]) => `<button class="tab ${alertTab === k ? "active" : ""}" data-t="${k}">${t}</button>`).join("")}</div>
    <div id="alBody"></div>`;
  body.querySelectorAll("[data-t]").forEach((b) => (b.onclick = () => { alertTab = b.dataset.t; alerts(body); }));
  const el = document.getElementById("alBody");
  if (alertTab === "active") {
    const list = act.filter((a) => alertLevel === "all" || a.level === alertLevel);
    el.innerHTML = `
      <div class="grid4">${["CRITICAL", "HIGH", "MEDIUM", "LOW"].map((l) => kpi(l, `<span class="lvtxt-${l}">${counts[l]}</span>`, "active", `onclick="window.__alLevel('${l}')"`)).join("")}</div>
      <div class="sec" style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap"><button class="chip ${alertLevel === "all" ? "active" : ""}" onclick="window.__alLevel('all')">All</button>${["CRITICAL", "HIGH", "MEDIUM"].map((l) => `<button class="chip ${alertLevel === l ? "active" : ""}" onclick="window.__alLevel('${l}')">${l}</button>`).join("")}<a class="btn ghost sm" style="margin-left:auto" href="${url("/api/export/alerts.csv")}">Export CSV</a></div>
      <div class="warnbox" style="margin-bottom:8px">All alerts below are <b>INDRA EXPERIMENTAL SCREENING ALERTS</b> generated automatically from observations and models. They are <b>not</b> official IMD warnings.</div>
      ${list.length ? list.slice(0, 120).map(alertCard).join("") : '<div class="empty">No active alerts at this level.</div>'}`;
    el.querySelectorAll("[data-ack]").forEach((b) => (b.onclick = (e) => { e.stopPropagation(); ackAlert(b.dataset.ack).then(() => alerts(body)); }));
    el.querySelectorAll("[data-more]").forEach((b) => (b.onclick = () => alertDetail(b.dataset.more)));
  } else if (alertTab === "log" && !can("command")) {
    el.innerHTML = lockedCard("Full alert history log (issued, escalated, acknowledged, expired)", "professional");
  } else if (alertTab === "log") {
    el.innerHTML = skel(8);
    const r = await api("/api/alerts/log");
    el.innerHTML = `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Time</th><th>Event</th><th>Level</th><th>Alert</th></tr></thead><tbody>${r.events.map((e) => `<tr style="cursor:pointer" onclick="window.__alDetail('${esc(e.alert_id)}')"><td>${fmtTime(e.at, { noTz: true })}</td><td style="text-align:left">${esc(e.event)}</td><td>${e.level ? lvl(e.level) : "—"}</td><td style="text-align:left;white-space:normal;font-family:var(--f-body)">${esc(e.title || e.alert_id)}${e.note && e.event !== "ISSUED" ? ` <span class="meta">${esc(e.note)}</span>` : ""}</td></tr>`).join("") || '<tr><td colspan="4">No events yet</td></tr>'}</tbody></table></div>`;
  } else if (alertTab === "official") {
    el.innerHTML = skel(5);
    const r = await api("/api/imd", { timeout: 40000 }).catch((e) => ({ error: e.message }));
    const blk = (t, x) => `<div class="card"><div style="display:flex;justify-content:space-between"><b>${t}</b>${stateBadge(x?.status || "UNAVAILABLE")}</div>${x?.records?.length ? `<div class="note">${x.records.length} records · ${esc(x.endpoint)}</div>` : `<div class="note">${esc(x?.message || "")}</div>${(x?.errors || []).map((e) => `<div class="meta mono" style="white-space:normal;word-break:break-all">${esc(e)}</div>`).join("")}`}</div>`;
    const sa = r.sachet || {};
    const sl = (sa.alerts || []).filter((a) => a.status === "ACTIVE");
    el.innerHTML = `<div class="officialbox" style="margin-bottom:8px">This tab shows only <b>official</b> products — NDMA SACHET (CAP alerts from IMD, SDMAs, CWC, INCOIS…) and IMD APIs. They are never mixed with INDRA screening alerts.</div>
    <div class="card"><div style="display:flex;justify-content:space-between"><b>NDMA SACHET · CAP Integrated Alert System</b>${stateBadge(sa.status || "UNAVAILABLE")}</div><div class="note">${n0(sa.active)} active · ${["WARNING", "ALERT", "WATCH"].map((k) => `${k} ${sa.by_level?.[k] ?? 0}`).join(" · ")} · fetched ${sa.fetched_at ? ago(sa.fetched_at) : "—"}</div></div>
    ${sl.length ? sl.map(officialCard).join("") : '<div class="empty">No active official alert on NDMA SACHET.</div>'}
    ${blk("IMD district nowcast", r.district_nowcast)}${blk("IMD district warnings", r.district_warnings)}<div class="note" style="margin-top:8px">Open <a href="https://mausam.imd.gov.in/responsive/districtWiseNowcast.php" target="_blank" rel="noopener">IMD district-wise nowcast</a> · <a href="https://mausam.imd.gov.in/responsive/districtWiseWarningGIS.php" target="_blank" rel="noopener">IMD district warnings</a> · <a href="https://sachet.ndma.gov.in/" target="_blank" rel="noopener">NDMA SACHET</a></div>`;
  } else {
    el.innerHTML = `<div class="card"><div class="kv"><dt>Audible alarm</dt><dd><button class="btn sm ${S.prefs.sound ? "" : "ghost"}" id="stSound">${S.prefs.sound ? "On" : "Off"}</button></dd><dt>Browser notifications</dt><dd><button class="btn sm ${S.prefs.notify ? "" : "ghost"}" id="stNotify">${S.prefs.notify ? "On" : "Off"}</button></dd><dt>Voice read-out</dt><dd><button class="btn sm ${S.prefs.voice ? "" : "ghost"}" id="stVoice">${S.prefs.voice ? "On" : "Off"}</button></dd><dt>Popup threshold</dt><dd>HIGH &amp; CRITICAL</dd></div><div style="display:flex;gap:6px;margin-top:10px"><button class="btn ghost sm" id="tstHigh">Test HIGH alarm</button><button class="btn danger sm" id="tstCrit">Test CRITICAL alarm</button></div></div><div class="note" style="margin-top:8px">Browsers require one click on the page before sound can play. Notifications need permission.</div>`;
    document.getElementById("stSound").onclick = () => { S.prefs.sound = !S.prefs.sound; savePrefs(); emit("prefs"); alerts(body); };
    document.getElementById("stNotify").onclick = async () => { if (S.prefs.notify) { S.prefs.notify = false; savePrefs(); } else await enableNotify(); emit("prefs"); alerts(body); };
    document.getElementById("stVoice").onclick = () => { S.prefs.voice = !S.prefs.voice; savePrefs(); alerts(body); };
    document.getElementById("tstHigh").onclick = () => alarm("HIGH");
    document.getElementById("tstCrit").onclick = () => alarm("CRITICAL");
  }
  window.__alLevel = (l) => { alertLevel = l; alertTab = "active"; alerts(body); };
  window.__alDetail = alertDetail;
}
function alertCard(a) {
  const p = a.payload || {};
  const acked = !!a.acknowledged_at;
  const aff = p.affected_forecast?.districts?.length ? p.affected_forecast.districts.slice(0, 5).map((d) => `${d.name}${d.eta_min ? ` +${d.eta_min}m` : ""}`).join(", ") : (p.affected_now?.districts || []).join(", ");
  return `<div class="card alert-card ${acked ? "acked" : ""}" data-l="${a.level}" style="margin-bottom:8px">
    <div style="display:flex;gap:8px;align-items:flex-start"><div style="flex:1;min-width:0"><div style="font-weight:600">${esc(a.title)}</div><div class="meta">${a.kind === "storm_cell" ? "Storm cell" : "District"} · ${esc(HZ_LABEL[a.hazard] || a.hazard)} · ${a.status}${a.peak_level !== a.level ? ` · peak ${a.peak_level}` : ""}</div></div>${lvl(a.level)}</div>
    <div class="meta" style="margin-top:4px">Issued ${fmtTime(a.created_at)} · updated ${ago(a.updated_at)} · expires ${fmtTime(a.expires_at)}${p.window ? ` · window 0–${p.window.to_min} min` : ""}</div>
    ${aff ? `<div class="meta">Affected: ${esc(aff)}${p.affected_forecast?.villages ? ` · ${n0(p.affected_forecast.villages)} villages in path` : p.affected_now?.villages ? ` · ${n0(p.affected_now.villages)} villages` : ""}</div>` : ""}
    <div class="meta">Sources: ${srcTags(p.sources)} · <span class="badge b-exp">INDRA EXPERIMENTAL</span></div>
    <div style="display:flex;gap:6px;margin-top:6px">${acked ? `<span class="badge b-nc">ACK ${fmtTime(a.acknowledged_at, { noTz: true })} · ${esc(a.acknowledged_by)}</span>` : can("ack") ? `<button class="btn sm" data-ack="${esc(a.id)}">Acknowledge</button>` : ""}<button class="btn ghost sm" data-more="${esc(a.id)}">Details</button><button class="btn ghost sm" onclick="window.__flyAlert(${a.lat},${a.lon},'${esc(a.district || "")}')">Map</button></div></div>`;
}
window.__flyAlert = (lat, lon, n) => { M.flyTo(lat, lon, 9); M.setSelMarker([lat, lon], n); };
export async function ackAlert(id) {
  if (!can("ack")) { emit("locked", { feature: "ack", what: "Alert acknowledgement", required_tier: "professional" }); return; }
  const op = localStorage.getItem("indra.operator") || "operator";
  await api(`/api/alerts/${encodeURIComponent(id)}/ack`, { method: "POST", body: JSON.stringify({ operator: op }) });
  S.acked.add(id); localStorage.setItem("indra.acked", JSON.stringify([...S.acked].slice(-500)));
  const a = S.alerts.find((x) => x.id === id); if (a) { a.acknowledged_at = Date.now() / 1000; a.acknowledged_by = op; }
  emit("alerts-updated");
}
export async function alertDetail(id) {
  const a = S.alerts.find((x) => x.id === id);
  const h = await api(`/api/alerts/${encodeURIComponent(id)}/history`).catch(() => ({ events: [] }));
  const p = a?.payload || {};
  const m = document.getElementById("modal");
  m.hidden = false;
  m.innerHTML = `<div class="modal-box" data-l="${a?.level || ""}"><div style="display:flex;justify-content:space-between;gap:10px"><div><div class="panel-kicker">INDRA EXPERIMENTAL SCREENING ALERT · not an official IMD warning</div><h2 style="margin:4px 0;font:600 20px var(--f-display)">${esc(a?.title || id)}</h2></div>${a ? lvl(a.level) : ""}</div>
    ${a ? `<div class="kv" style="margin:8px 0"><dt>Hazard</dt><dd>${esc(HZ_LABEL[a.hazard])}</dd><dt>Status</dt><dd>${a.status}</dd><dt>Issued</dt><dd>${fmtDateTime(a.created_at)}</dd><dt>Updated</dt><dd>${fmtDateTime(a.updated_at)}</dd><dt>Expires</dt><dd>${fmtDateTime(a.expires_at)}</dd><dt>Location</dt><dd>${esc(a.district || "")}, ${esc(a.state || "")}</dd>${p.motion?.speed_kmh ? `<dt>Movement</dt><dd>${n0(p.motion.speed_kmh)} km/h ${compass(p.motion.towards_deg)}</dd>` : ""}${p.confidence ? `<dt>Confidence</dt><dd>${esc(p.confidence.label)}</dd>` : ""}</div>` : ""}
    ${p.affected_forecast?.districts?.length ? `<div class="sec-h">Affected in next hours</div><div class="note">${p.affected_forecast.districts.map((d) => `${esc(d.name)} (${esc(d.state)})${d.eta_min ? ` +${d.eta_min} min` : ""}`).join(", ")}${p.affected_forecast.top_settlements?.length ? `<br>Settlements: ${p.affected_forecast.top_settlements.map((s) => esc(s.name)).join(", ")}` : ""}</div>` : ""}
    ${p.hazards ? `<div class="sec-h" style="margin-top:8px">Hazard scores</div><div class="note">${HAZARDS.map((k) => `${HZ_LABEL[k]} ${p.hazards[k] ?? 0}`).join(" · ")}</div>` : ""}
    <div class="sec-h" style="margin-top:8px">Precautions</div>${precList(p.precautions)}
    <div class="sec-h" style="margin-top:8px">Lifecycle</div><div class="evlog">${h.events.map((e) => `<div><time>${fmtDateTime(e.at)}</time>${esc(e.event)} ${e.level ? `[${e.level}]` : ""} ${esc(e.note || "")}</div>`).join("") || "—"}</div>
    <div style="display:flex;gap:8px;margin-top:12px;justify-content:flex-end">${a && !a.acknowledged_at ? `<button class="btn" id="mAck">Acknowledge</button>` : ""}<button class="btn ghost" id="mClose">Close</button></div></div>`;
  const close = () => { m.hidden = true; m.innerHTML = ""; };
  document.getElementById("mClose").onclick = close;
  m.onclick = (e) => { if (e.target === m) close(); };
  const ab = document.getElementById("mAck"); if (ab) ab.onclick = async () => { await ackAlert(id); close(); };
}

// ====================================================================== MODEL VERIFICATION CENTRE
export async function verify(body) {
  body.innerHTML = skel(10);
  const [v, st] = await Promise.all([api("/api/verification?hours=24"), Promise.resolve(S.status)]);
  const ex = v.scores.filter((x) => x.method === "extrapolation"), pe = v.scores.filter((x) => x.method === "persistence"), ml = v.scores.filter((x) => x.method === "model_thunder_vs_lightning");
  const runs = st?.model_runs || [];
  const sc = (x) => (x == null ? "—" : (x * 100).toFixed(0) + "%");
  body.innerHTML = `
    <div class="${v.target.status.startsWith("MET") ? "officialbox" : "warnbox"}"><b>Target:</b> ${esc(v.target.metric)} — <b>${esc(v.target.status)}</b><br><span class="note">${esc(v.target.note)}</span></div>
    ${sec("Scores · last 24 h", v.scores.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Method</th><th>Lead</th><th>N</th><th>POD</th><th>FAR</th><th>CSI</th><th>Bias</th></tr></thead><tbody>${v.scores.map((x) => `<tr><td>${esc(x.method.replace(/_/g, " "))}</td><td>${x.lead_min}m</td><td>${x.samples}</td><td>${sc(x.pod)}</td><td>${sc(x.far)}</td><td>${sc(x.csi)}</td><td>${x.bias ?? "—"}</td></tr>`).join("")}</tbody></table></div>` : `<div class="empty">Verification starts automatically: each radar forecast is scored when its valid time arrives (first scores ~30 min after start-up). ${v.pending_forecasts} forecasts pending.</div>`, stateBadge("LIVE"))}
    ${ex.length ? sec("Skill vs persistence baseline", `<div class="chart-box"><canvas id="cVer"></canvas></div><div class="note">Extrapolation should beat persistence (no-motion) to show tracking adds skill.</div>`) : ""}
    ${sec("Model run status", `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Model</th><th>Run init (UTC)</th><th>Available</th><th>Every</th><th>Status</th></tr></thead><tbody>${runs.map((r) => `<tr><td title="${esc(r.reason || r.centre || "")}">${esc(r.name)}</td><td>${r.run_init ? new Date(r.run_init * 1000).toISOString().slice(5, 16).replace("T", " ") : "—"}</td><td>${r.available_at ? ago(r.available_at) : "—"}</td><td>${r.update_interval_h ? r.update_interval_h + " h" : "—"}</td><td>${stateBadge(r.status === "AVAILABLE" ? "LIVE" : r.status)}</td></tr>`).join("") || '<tr><td colspan="4">Model metadata loading</td></tr>'}</tbody></table></div><div class="note">Run times from Open-Meteo model metadata. NCMRWF / IMD WRF rows show UNAVAILABLE because no public gridded API exists.</div>`)}
    ${sec("Ground-truth reports", `<div class="note" style="margin-bottom:6px">${v.event_labels} operator reports stored.</div>${feedbackForm("")}`)}
    ${sec("Exports", `<div style="display:flex;gap:6px;flex-wrap:wrap"><a class="btn ghost sm" href="${url("/api/export/verification.csv")}">Verification CSV</a><a class="btn ghost sm" href="${url("/api/export/feedback.csv")}">Reports CSV</a><a class="btn ghost sm" href="${url("/api/export/alerts.csv")}">Alerts CSV</a><a class="btn ghost sm" href="${url("/api/export/audit.csv")}">Audit CSV</a></div>`)}
    ${sec("Methods", `<div class="kv">${Object.entries(v.methods).map(([k, t]) => `<dt>${esc(k.replace(/_/g, " "))}</dt><dd style="text-align:left;font-family:var(--f-body)">${esc(t)}</dd>`).join("")}</div>`)}`;
  bindFeedback(body);
  if (ex.length) {
    const leads = [...new Set(v.scores.filter((x) => x.method !== "model_thunder_vs_lightning").map((x) => x.lead_min))].sort((a, b) => a - b);
    const g = (arr, k) => leads.map((l) => { const x = arr.find((y) => y.lead_min === l); return x && x[k] != null ? +(x[k] * 100).toFixed(1) : null; });
    chart(document.getElementById("cVer"), { type: "bar", data: { labels: leads.map((l) => `${l} min`), datasets: [{ label: "CSI extrapolation", data: g(ex, "csi"), backgroundColor: "#0098bd" }, { label: "CSI persistence", data: g(pe, "csi"), backgroundColor: "rgba(110,150,178,.5)" }, { label: "POD extrapolation", data: g(ex, "pod"), backgroundColor: "rgba(35,165,151,.7)" }] }, options: baseOpts({ plugins: { legend: { display: true, labels: { boxWidth: 10 } } }, scales: { x: { grid: { display: false } }, y: { max: 100, beginAtZero: true, grid: { color: gridC } } } }) });
  }
}

// ====================================================================== SYSTEM
export async function system(body) {
  const st = S.status || {};
  const [docs, audit] = await Promise.all([api("/api/docs").catch(() => null), api("/api/audit").catch(() => ({ events: [] }))]);
  body.innerHTML = `
    <div class="grid3">${kpi("Version", esc(st.version || "—"))}${kpi("Uptime", fmtAge(st.uptime_s))}${kpi("Link", esc(S.link))}</div>
    ${feedsSection()}
    ${sec("Engine loops", `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Loop</th><th>Last OK</th><th>Duration</th><th>Next</th></tr></thead><tbody>${Object.entries(st.loops || {}).map(([k, l]) => `<tr><td>${esc(k)}</td><td>${l.last_ok ? ago(l.last_ok) : l.running ? "running" : "—"}</td><td>${l.duration_s ?? "—"} s</td><td>${l.next_at ? fmtTime(l.next_at, { noTz: true }) : "—"}</td></tr>${l.last_error ? `<tr><td colspan="4" class="meta" style="text-align:left;white-space:normal">${esc(l.last_error)}</td></tr>` : ""}`).join("")}</tbody></table></div>`)}
    ${sec("HTTP feed health", `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Feed</th><th>OK</th><th>Fail</th><th>Last OK</th></tr></thead><tbody>${Object.entries(st.http || {}).map(([k, f]) => `<tr><td>${esc(k)}</td><td>${f.ok ?? 0}</td><td>${f.fail ?? 0}</td><td>${f.last_ok ? ago(f.last_ok) : "never"}</td></tr>`).join("")}</tbody></table></div>`)}
    ${sec("Public API", docs ? `<div class="list">${Object.entries(docs.endpoints).map(([k, d]) => { const p = k.split(" ")[1]; const link = k.startsWith("GET") && !p.includes("<") ? url(p.replace("?lat=&lon=", "?lat=28.61&lon=77.21").replace(/=$/, "=delhi").replace("?minutes=", "?minutes=30").replace("?hazard=&lead=", "?hazard=all&lead=0").replace("?status=", "?status=active").replace("?q=", "?q=delhi")) : null; return `<div class="card" style="padding:7px 9px">${link ? `<a class="mono" href="${link}" target="_blank" rel="noopener" style="font-size:11.5px">${esc(k)}</a>` : `<span class="mono" style="font-size:11.5px">${esc(k)}</span>`}<div class="meta">${esc(d)}</div></div>`; }).join("")}</div>` : skel(4))}
    ${sec("Audit log", audit.events.length ? `<div class="evlog">${audit.events.map((e) => `<div><time>${fmtDateTime(e.at)}</time>${esc(e.actor)} · ${esc(e.action)} · ${esc(e.target || "")}</div>`).join("")}</div>` : '<div class="empty">No operator actions yet.</div>')}
    ${sec("Operator", `<label class="field">Operator name (for acknowledgements and audit)<input id="opName" value="${esc(localStorage.getItem("indra.operator") || "")}" placeholder="e.g. Duty officer – Delhi"></label>`)}
    ${sec("Attribution", `<div class="note">Precipitation: NASA GIBS / GPM IMERG (NASA, JAXA) · Himawari-9 IR: JMA via NASA GIBS · Official alerts: NDMA SACHET (CAP) · Satellite: EUMETSAT (Meteosat IODC) · Lightning: Blitzortung.org contributors · Models: Open-Meteo (ECMWF, NOAA NCEP, DWD, UK Met Office) · Places: GeoNames (CC-BY 4.0) · Boundaries: india-maps-data · Basemap: © Esri, HERE, Garmin, © OpenStreetMap contributors.</div>`)}`;
  document.getElementById("opName").onchange = (e) => localStorage.setItem("indra.operator", e.target.value.trim().slice(0, 60));
}

export { ring, hzGrid, precList, officialSection, OFFICIAL, sec, kpi, skel, chart, baseOpts };
