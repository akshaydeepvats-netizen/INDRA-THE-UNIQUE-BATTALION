// INDRA plain-language views: Home, Accuracy, Help, and the "in plain words" block used in every location report.
import { S, AUTH, api, esc, fmtTime, ago, n0, stateBadge, compass, can, toast, HZ_LABEL, LV_COLOR } from "./core.js";
import * as M from "./map.js";
import { ring, precList, officialSection, OFFICIAL, sec, kpi, skel } from "./modules.js";
import { lockedCard, tierTableHtml, tierLabel, startTour, upgradeDialog } from "./account.js";

// ---------------------------------------------------------------- info tooltips (floating, never clipped)
export const info = (t) => `<button type="button" class="info" data-tip="${esc(t)}" aria-label="${esc(t)}">i</button>`;
const tipEl = document.createElement("div");
tipEl.className = "ftip"; tipEl.hidden = true; tipEl.setAttribute("role", "tooltip");
document.body.appendChild(tipEl);
function showTip(t) {
  const el = t.closest("[data-tip]"); if (!el) return;
  tipEl.textContent = el.dataset.tip; tipEl.hidden = false;
  const r = el.getBoundingClientRect(), w = Math.min(280, innerWidth - 16);
  tipEl.style.width = w + "px";
  const x = Math.max(8, Math.min(innerWidth - w - 8, r.left + r.width / 2 - w / 2));
  const h = tipEl.offsetHeight;
  tipEl.style.left = x + "px"; tipEl.style.top = (r.top - h - 8 < 8 ? r.bottom + 8 : r.top - h - 8) + "px";
}
document.addEventListener("mouseover", (e) => { if (e.target.closest?.("[data-tip]")) showTip(e.target); });
document.addEventListener("mouseout", (e) => { if (e.target.closest?.("[data-tip]")) tipEl.hidden = true; });
document.addEventListener("focusin", (e) => { if (e.target.closest?.("[data-tip]")) showTip(e.target); });
document.addEventListener("focusout", () => (tipEl.hidden = true));
document.addEventListener("click", (e) => { const b = e.target.closest?.(".info"); if (b) { e.stopPropagation(); showTip(b); setTimeout(() => (tipEl.hidden = true), 4000); } }, true);

// ---------------------------------------------------------------- weather words + icons (single-colour line icons)
const IC = {
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  part: '<path d="M8 4v1M3.5 6.5l.7.7M2 11h1"/><path d="M5.5 11a3 3 0 0 1 5.4-1.8"/><path d="M8 19a3.5 3.5 0 0 1-.4-7A5 5 0 0 1 17 11a3.5 3.5 0 0 1 0 8z"/>',
  cloud: '<path d="M7 18a4 4 0 0 1-.6-8A6 6 0 0 1 18 9a4.5 4.5 0 0 1-.5 9z"/>',
  rain: '<path d="M7 14a4 4 0 0 1-.6-8A6 6 0 0 1 18 5a4.5 4.5 0 0 1-.5 9z"/><path d="M8 17l-1 3M12 17l-1 3M16 17l-1 3"/>',
  storm: '<path d="M7 14a4 4 0 0 1-.6-8A6 6 0 0 1 18 5a4.5 4.5 0 0 1-.5 9"/><path d="m13 11-3 5h4l-3 5"/>',
};
const icon = (k, cls = "") => `<svg class="wx-ic ${cls}" viewBox="0 0 24 24" aria-hidden="true">${IC[k]}</svg>`;
function condition(be, i, stormy) {
  const rp = be.rain_prob[i] ?? 0, mm = be.rain_mm[i] ?? 0, cl = be.cloud[i] ?? 0;
  if (stormy) return ["storm", "Thunderstorm risk"];
  if (rp >= 60 && mm >= 2.5) return ["rain", "Heavy rain likely"];
  if (rp >= 50) return ["rain", "Rain likely"];
  if (rp >= 25) return ["rain", "Chance of showers"];
  if (cl >= 70) return ["cloud", "Cloudy"];
  if (cl >= 25) return ["part", "Partly cloudy"];
  return ["sun", "Clear"];
}
const istHour = (t) => new Date(Date.parse(t + (t.endsWith("Z") ? "" : "Z"))).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" });

const LEVEL_WORDS = { MINIMAL: "very low", LOW: "low", MEDIUM: "moderate", HIGH: "high", CRITICAL: "very high" };
export function plainSentence(r) {
  const be = r.best_estimate, th = r.threat || {};
  const parts = [];
  if (be?.temp?.length) {
    const [, w] = condition(be, 0, false);
    parts.push(`${w} now, about ${n0(be.temp[0])} °C${be.wind[0] != null ? ` with ${be.wind[0] < 8 ? "light" : be.wind[0] < 25 ? "moderate" : "strong"} wind` : ""}.`);
    const wetH = be.rain_prob.slice(1, 13).findIndex((p) => p >= 50);
    parts.push(wetH >= 0 ? `Rain is likely from around ${istHour(be.times[wetH + 1])} IST.` : "No rain expected in the next 12 hours.");
  }
  const lv = th.level || "UNKNOWN";
  if (lv === "MINIMAL" || lv === "LOW") parts.push("No severe storm expected in the next 6 hours.");
  else if (lv === "MEDIUM") parts.push(`Some chance of ${HZ_LABEL[th.primary_hazard]?.toLowerCase() || "a storm"} in the next ${Math.max(1, th.peak_lead_h || 1)}–6 hours — keep an eye on updates.`);
  else if (lv === "HIGH" || lv === "CRITICAL") parts.push(`${lv === "CRITICAL" ? "Very high" : "High"} risk of ${HZ_LABEL[th.primary_hazard]?.toLowerCase() || "severe weather"} around ${th.peak_lead_h ? "+" + th.peak_lead_h + " h" : "now"}. Follow the safety tips below.`);
  const off = r.official_alerts?.alerts?.length || 0;
  parts.push(off ? `${off} official government alert${off > 1 ? "s are" : " is"} active for this area.` : "No official government alert for this area right now.");
  return parts.join(" ");
}

function nowCard(r) {
  const be = r.best_estimate;
  if (!be?.temp?.length) return `<div class="empty">Forecast models are unavailable for this point right now. ${stateBadge("UNAVAILABLE")}</div>`;
  const stormy = ["HIGH", "CRITICAL"].includes(r.nowcast?.[0]?.level);
  const [ic, words] = condition(be, 0, stormy);
  const acc = r.accuracy || {};
  const accTxt = acc.status === "LIVE" ? `In the last ${acc.test_window_h} h this estimate was within 2 °C of real station readings ${n0(acc.temp_within_2c_pct)}% of the time (${acc.stations} stations).` : "Accuracy scoring is still collecting station data.";
  return `<div class="now-card">
    <div class="nc-l">${icon(ic, "big")}<div><div class="nc-t">${n0(be.temp[0])}<small>°C</small></div><div class="nc-w">${esc(words)}</div></div></div>
    <div class="nc-r">
      <div><span>Rain chance</span><b>${n0(be.rain_prob[0])}%</b></div>
      <div><span>Wind</span><b>${n0(be.wind[0])} km/h</b></div>
      <div><span>Gusts</span><b>${n0(be.gust[0])} km/h</b></div>
      <div><span>Humidity</span><b>${n0(be.rh[0])}%</b></div>
    </div>
  </div>
  <div class="note" style="margin-top:6px">${stateBadge("ESTIMATED")} INDRA best estimate — ${esc(be.method_temp)} for temperature, ${esc(be.method_wind)} for wind, chosen live by scoring against ground stations. ${info(accTxt + " Models used: " + (be.models_used || []).join(", ") + ".")}</div>`;
}

function hourStrip(r) {
  const be = r.best_estimate;
  if (!be?.times?.length) return "";
  const nc = Object.fromEntries((r.nowcast || []).map((x) => [x.lead_h, x.level]));
  return `<div class="hour-strip" role="list">${be.times.slice(0, 13).map((t, i) => {
    const stormy = ["HIGH", "CRITICAL"].includes(nc[i]);
    const [ic, w] = condition(be, i, stormy);
    return `<div class="hs-c" role="listitem" title="${esc(w)}"><div class="hs-t mono">${i === 0 ? "Now" : istHour(t)}</div>${icon(ic)}<div class="hs-v">${n0(be.temp[i])}°</div><div class="hs-p" style="--p:${be.rain_prob[i] || 0}%"><i></i><span>${n0(be.rain_prob[i])}%</span></div><div class="hs-w mono">${n0(be.wind[i])}<small>km/h</small></div></div>`;
  }).join("")}</div><div class="note">Hourly, IST. Bar = chance of rain. ${stateBadge("ESTIMATED")}</div>`;
}

function obsBlock(r) {
  const o = r.nearest_obs || [];
  if (!o.length) return `<div class="empty">No airport weather station reported within 150 km in the last 3 h — values above are model estimates only.</div>`;
  const be = r.best_estimate, s = o[0];
  const diff = be?.temp?.[0] != null && s.temp != null ? be.temp[0] - s.temp : null;
  return `<div class="list">${o.map((x) => `<div class="row"><div class="main"><div class="t">${esc(x.name || x.icao)} <span class="meta mono">${esc(x.icao)}</span></div><div class="d">${x.distance_km} km away · measured ${x.age_min} min ago${x.wx ? " · " + esc(x.wx) : ""}</div></div><div class="r obs-r"><b>${n0(x.temp, 0)} °C</b><span>${n0(x.wspd_kmh)} km/h ${compass(x.wdir)}</span></div></div>`).join("")}</div>
    <div class="note" style="margin-top:6px">${stateBadge("LIVE")} OBSERVED by airport weather stations (METAR via aviationweather.gov).${diff != null && s.distance_km < 60 ? ` INDRA's estimate is ${Math.abs(diff) < 0.5 ? "matching" : `${Math.abs(diff).toFixed(1)} °C ${diff > 0 ? "warmer" : "cooler"} than`} the nearest station.` : ""} ${info("Stations measure the real air at 2 m height. Differences of 1–2 °C between a city point and an airport a few km away are normal.")}</div>`;
}

function stormStrip(r) {
  const rows = r.nowcast || [];
  return `<div class="risk-strip">${rows.map((x) => `<div class="rs-c" title="+${x.lead_h} h: ${x.level} (${x.score})"><div class="rs-b" style="background:${LV_COLOR[x.level]}"></div><div class="rs-t mono">${x.lead_h === 0 ? "Now" : "+" + x.lead_h + "h"}</div><div class="rs-l">${esc(LEVEL_WORDS[x.level] || "—")}</div></div>`).join("")}</div>
  <div class="note">Chance of severe weather (thunderstorm, lightning, hail, cloudburst, squall, heavy rain) by hour. ${stateBadge("EXPERIMENTAL")} ${info("INDRA screening nowcast: combines satellite rain, lightning, storm tracks and models. It is not an official IMD warning and has not been formally validated.")}</div>`;
}

// Used at the top of every location report and on Home.
export function plainBlock(r) {
  return `${sec("In plain words", `<div class="plain">${esc(plainSentence(r))}</div>`)}
    ${sec("Right now", nowCard(r))}
    ${sec("Next 12 hours", hourStrip(r))}
    ${sec(`Measured nearby ${info("Real observations from the closest airport weather stations — the ground truth INDRA checks itself against.")}`, obsBlock(r), stateBadge("OBSERVED"))}`;
}

// ---------------------------------------------------------------- saved places / home place
export function homePlace() {
  try { const h = JSON.parse(localStorage.getItem("indra.home") || "null"); if (h?.lat != null) return h; } catch (_) {}
  return { lat: 28.6139, lon: 77.209, name: "New Delhi" };
}
export function setHomePlace(p) { localStorage.setItem("indra.home", JSON.stringify({ lat: +p.lat, lon: +p.lon, name: p.name })); }
export async function loadPlaces() {
  if (!can("saved_places")) return (S.places = []);
  try { S.places = (await api("/api/places")).places; } catch (_) { S.places = []; }
  return S.places;
}
export async function savePlace(p) {
  if (!can("saved_places")) { upgradeDialog("public"); return; }
  try {
    const r = await api("/api/places", { method: "POST", body: JSON.stringify(p) });
    S.places = r.places;
    toast(`<div class="tb"><div class="tt">Saved ${esc(p.name)}</div><div class="ts">Find it on Home. Alerts near saved places appear there.</div></div>`);
  } catch (e) { toast(`<div class="tb"><div class="tt">${esc(e.body?.error || e.message)}</div></div>`); }
}
export async function removePlace(id) {
  try { S.places = (await api(`/api/places/${id}`, { method: "DELETE" })).places; } catch (_) {}
}

// ---------------------------------------------------------------- HOME
const POPULAR = [["New Delhi", 28.6139, 77.209], ["Mumbai", 19.076, 72.8777], ["Kolkata", 22.5726, 88.3639], ["Chennai", 13.0827, 80.2707], ["Bengaluru", 12.9716, 77.5946], ["Meerut", 28.9845, 77.7064], ["Guwahati", 26.1445, 91.7362], ["Bhubaneswar", 20.2961, 85.8245]];
export async function home(body) {
  const u = AUTH.user || {};
  const hp = homePlace();
  await loadPlaces();
  const places = S.places || [];
  const hr = new Date().toLocaleString("en-GB", { hour: "numeric", hour12: false, timeZone: "Asia/Kolkata" });
  const greet = +hr < 12 ? "Good morning" : +hr < 17 ? "Good afternoon" : "Good evening";
  body.innerHTML = `
    <div class="home-hello"><div><div class="hh-g">${greet}${u.tier !== "guest" && u.name ? ", " + esc(u.name.split(" ")[0]) : ""}</div><div class="hh-s">Showing weather for <b>${esc(hp.name)}</b></div></div><span class="tier-pill t-${u.tier}">${tierLabel(u.tier).toUpperCase()}</span></div>
    <div class="place-bar">
      ${places.map((p) => `<button class="chip ${Math.abs(p.lat - hp.lat) < 0.005 && Math.abs(p.lon - hp.lon) < 0.005 ? "active" : ""}" data-p="${p.lat},${p.lon}" data-n="${esc(p.name)}">${esc(p.name)}</button>`).join("")}
      ${places.length ? "" : POPULAR.map(([n, la, lo]) => `<button class="chip ${Math.abs(la - hp.lat) < 0.005 ? "active" : ""}" data-p="${la},${lo}" data-n="${n}">${n}</button>`).join("")}
    </div>
    <div class="place-acts"><button class="btn sm" id="hGeo">Use my location</button><button class="btn ghost sm" id="hFind">Find a place</button><button class="btn ghost sm" id="hSave">${can("saved_places") ? "Save this place" : "Save place (account)"}</button><button class="btn ghost sm" id="hFull">Full report</button></div>
    <div id="homeBody">${skel(8)}</div>`;
  body.querySelectorAll("[data-p]").forEach((b) => (b.onclick = () => { const [la, lo] = b.dataset.p.split(",").map(Number); setHomePlace({ lat: la, lon: lo, name: b.dataset.n }); home(body); }));
  document.getElementById("hGeo").onclick = () => {
    if (!navigator.geolocation) return toast("Location is not supported by this browser.");
    navigator.geolocation.getCurrentPosition((p) => { setHomePlace({ lat: p.coords.latitude.toFixed(4), lon: p.coords.longitude.toFixed(4), name: "My location" }); home(body); }, () => toast(`<div class="tb"><div class="tt">Location permission denied</div><div class="ts">Search for your town instead.</div></div>`), { timeout: 10000 });
  };
  document.getElementById("hFind").onclick = () => { const s = document.getElementById("search"); s.focus(); s.select(); };
  document.getElementById("hSave").onclick = () => savePlace(hp);
  document.getElementById("hFull").onclick = () => (location.hash = `#/loc/${hp.lat},${hp.lon},${encodeURIComponent(hp.name)}`);
  M.setSelMarker([+hp.lat, +hp.lon], hp.name);
  M.flyTo(+hp.lat, +hp.lon, Math.max(6, Math.min(8, M.L_().getZoom() + 1)));
  let r;
  try { r = await api(`/api/location?lat=${hp.lat}&lon=${hp.lon}&name=${encodeURIComponent(hp.name)}`, { timeout: 45000 }); }
  catch (e) { const hb = document.getElementById("homeBody"); if (hb) hb.innerHTML = `<div class="empty">Weather for ${esc(hp.name)} is unavailable: ${esc(e.message)} ${stateBadge("UNAVAILABLE")}</div>`; return; }
  const hb = document.getElementById("homeBody"); if (!hb) return;
  const near = (S.alerts || []).filter((a) => a.status === "ACTIVE" && a.lat != null && Math.hypot(a.lat - hp.lat, (a.lon - hp.lon) * Math.cos(hp.lat * Math.PI / 180)) < 1.2);
  const n = S.national;
  const acc = r.accuracy || {};
  hb.innerHTML = `
    ${plainBlock(r)}
    ${sec("Storm risk · next 6 hours", stormStrip(r), stateBadge("EXPERIMENTAL"))}
    ${officialSection(r.official_alerts?.alerts, "Official alerts for this area", "No official alert from IMD / SDMA on NDMA SACHET for this area.")}
    ${sec(`INDRA screening alerts nearby ${info("Automatic alerts generated by INDRA's model when storms are detected. Useful early heads-up, but NOT official warnings.")}`, near.length ? `<div class="list">${near.slice(0, 5).map((a) => `<div class="row" onclick="location.hash='#/alerts'"><div class="main"><div class="t">${esc(a.title)}</div><div class="d">${esc(HZ_LABEL[a.hazard] || a.hazard)} · ${esc(a.district || "")} · until ${fmtTime(a.expires_at)}</div></div><div class="r"><span class="lv lv-${esc(a.level)}">${esc(a.level)}</span></div></div>`).join("")}</div>` : '<div class="empty">No INDRA screening alert within ~120 km.</div>', stateBadge("EXPERIMENTAL"))}
    ${sec("Stay safe", precList((r.precautions || []).slice(0, 5)))}
    ${sec("Across India", `<div class="plain sm">${n && n.status === "OK" ? `National storm level is <b>${esc(LEVEL_WORDS[n.level] || n.level)}</b>: ${n0(n.cells?.total)} storm cells tracked, ${n0(n.lightning?.last_15min)} lightning strikes in the last 15 minutes, ${n0(S.official?.active)} official alerts active.` : "The national scan is starting up."}</div><button class="btn ghost sm" style="margin-top:8px" onclick="location.hash='#/atlas'">Open India map</button>`)}
    ${sec(`How accurate is this? ${info("INDRA checks its forecasts every hour against real airport weather stations and shows the score honestly.")}`, acc.status === "LIVE" ? `<div class="grid3">${kpi("Temperature", n0(acc.temp_within_2c_pct, 0) + "<small>%</small>", "within ±2 °C")}${kpi("Wind", n0(acc.wind_within_10kmh_pct, 0) + "<small>%</small>", "within ±10 km/h")}${kpi("Rain yes/no", n0(acc.rain_yes_no_pct, 0) + "<small>%</small>", "hours correct")}</div><div class="note" style="margin-top:6px">Checked against ${acc.stations} stations over the last ${acc.test_window_h} h · updated ${ago(acc.computed_at)}. <a href="#/accuracy">See details</a></div>` : `<div class="empty">Collecting station observations — scores appear within the first hour. ${stateBadge(acc.status || "INITIALISING")}</div>`)}
    ${OFFICIAL}`;
}

// ---------------------------------------------------------------- ACCURACY
const pct = (v) => (v == null ? "—" : n0(v, 0) + "%");
export async function accuracy(body) {
  body.innerHTML = skel(8);
  const r = await api("/api/accuracy");
  const s = r.summary || {}, d = r.detail;
  if (s.status !== "LIVE") {
    body.innerHTML = sec("Live accuracy", `<div class="empty">${esc(s.note || "Collecting ground-station observations. The first scores appear after INDRA has at least a few hours of METAR reports.")} ${stateBadge(s.status || "INITIALISING")}</div>`) + whyNot99();
    return;
  }
  const pod = s.rain_pod;
  body.innerHTML = `
    <div class="note box" style="margin-bottom:10px">INDRA does not claim a fixed accuracy. Every hour it compares what it predicted with what <b>real weather stations measured</b>, on hours it did not learn from, and shows the result here.</div>
    <div class="grid3">
      ${kpi(`Temperature ${info("Share of station-hours where INDRA's temperature was within 2 °C of the measured value.")}`, pct(s.temp_within_2c_pct), `within ±2 °C · avg error ${n0(s.temp_mae, 1)} °C`)}
      ${kpi(`Wind ${info("Share of station-hours where wind speed was within 10 km/h of the measured value.")}`, pct(s.wind_within_10kmh_pct), `within ±10 km/h · avg error ${n0(s.wind_mae, 1)}`)}
      ${kpi(`Rain yes/no ${info("Share of hours where INDRA correctly said rain or no rain. In dry weather this is high even if a few rain hours are missed — see POD below.")}`, pct(s.rain_yes_no_pct), "hours correct")}
    </div>
    <div class="grid3" style="margin-top:6px">
      ${kpi(`Rain detection ${info("POD = probability of detection: of the hours when it actually rained at a station, how many INDRA predicted. 1.0 is perfect.")}`, pod == null ? "—" : n0(pod, 2), pod == null ? "no rain observed" : "POD (1 = perfect)")}
      ${kpi(`False alarms ${info("FAR = false alarm ratio: of the hours INDRA predicted rain, how many stayed dry. 0 is perfect.")}`, s.rain_far == null ? "—" : n0(s.rain_far, 2), "FAR (0 = perfect)")}
      ${kpi("Stations", n0(s.stations), `${n0(s.observations)} hourly reports`)}
    </div>
    ${pod != null && pod < 0.5 ? `<div class="note box warn" style="margin-top:8px">Honest note: rain detection is weak right now (POD ${n0(pod, 2)}). Rain was rare in the scoring window, so a few missed showers pull this down. Treat rain timing as uncertain and rely on the live rain map and official alerts.</div>` : ""}
    <div class="note" style="margin-top:8px">Window: last ${s.test_window_h} h, out-of-sample · best single model: ${esc(s.best_single_model || "—")} · updated ${ago(s.computed_at)} ${stateBadge("LIVE")}</div>
    ${d ? proAccuracy(d) : sec("Model-by-model scores and station table", lockedCard("Per-model scores, blend methods and the full station table", "professional"))}
    ${whyNot99(s.limits)}`;
}
function proAccuracy(d) {
  const ms = d.models || [];
  const meth = d.method_scores || {};
  const lab = { mean: "Equal mean", weighted: "Skill-weighted", weighted_bias: "Weighted + station bias", weighted_recent_bias: "Weighted + recent bias", best_model: "Best single model" };
  const sel = d.selected_method || {};
  return sec("Models vs stations", `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Model</th><th>Temp MAE</th><th>±2 °C</th><th>Wind MAE</th><th>Rain acc.</th><th>POD</th><th>Weight</th></tr></thead><tbody>
      <tr class="hl"><td><b>INDRA best estimate</b></td><td>${n0(d.blend?.temp?.mae, 2)}</td><td>${pct(d.blend?.temp?.within_2c_pct)}</td><td>${n0(d.blend?.wind?.mae, 1)}</td><td>${pct(d.blend?.rain?.accuracy_pct)}</td><td>${n0(d.blend?.rain?.pod, 2)}</td><td>—</td></tr>
      <tr><td>Plain average</td><td>${n0(d.simple_mean?.temp?.mae, 2)}</td><td>${pct(d.simple_mean?.temp?.within_2c_pct)}</td><td>${n0(d.simple_mean?.wind?.mae, 1)}</td><td>${pct(d.simple_mean?.rain?.accuracy_pct)}</td><td>${n0(d.simple_mean?.rain?.pod, 2)}</td><td>—</td></tr>
      ${ms.map((m) => `<tr><td>${esc(m.name)}</td><td>${n0(m.temp?.mae, 2)}</td><td>${pct(m.temp?.within_2c_pct)}</td><td>${n0(m.wind?.mae, 1)}</td><td>${pct(m.rain?.accuracy_pct)}</td><td>${n0(m.rain?.pod, 2)}</td><td>${m.weight_temp != null ? n0(m.weight_temp * 100, 0) + "%" : "—"}</td></tr>`).join("")}
    </tbody></table></div><div class="note" style="margin-top:6px">Model rows: full 26 h window. INDRA rows: only the last ${d.test_window_h} h (not used for fitting).</div>`, stateBadge("LIVE"))
    + sec("Blend methods tried (test-window MAE)", `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Method</th><th>Temp MAE</th><th>Wind MAE</th></tr></thead><tbody>${Object.entries(meth).map(([k, v]) => `<tr ${sel.t === k || sel.w === k ? 'class="hl"' : ""}><td>${esc(lab[k] || k)}${sel.t === k ? " · used for temp" : ""}${sel.w === k ? " · used for wind" : ""}</td><td>${n0(v.t, 2)}</td><td>${n0(v.w, 2)}</td></tr>`).join("")}</tbody></table></div><div class="note" style="margin-top:6px">${esc(d.method || "")}</div>`)
    + sec(`Stations (${(d.station_table || []).length})`, `<div class="tbl-wrap" style="max-height:260px"><table class="tbl"><thead><tr><th>ICAO</th><th>Station</th><th>Hours</th><th>Last °C</th></tr></thead><tbody>${(d.station_table || []).map((s) => `<tr><td class="mono">${esc(s.icao)}</td><td>${esc(s.name)}</td><td>${s.hours}</td><td>${n0(s.last_temp, 0)}</td></tr>`).join("")}</tbody></table></div>`);
}
function whyNot99(limits) {
  return sec("Why not “99% accurate”?", `<ul class="prec">
    <li>No weather service in the world can promise 99% for storms, hail or cloudbursts — these are small and fast. IMD itself reports nowcast skill well below that.</li>
    <li>INDRA is close to that level for some things (e.g. wind speed within 10 km/h), less for others (exact temperature, rain timing). The numbers above are the real, live scores.</li>
    <li>To be as accurate as possible INDRA tests five ways of combining five global models every hour and automatically uses the one that matched the stations best.</li>
    ${limits ? `<li>${esc(limits)}</li>` : ""}
  </ul>`);
}

// ---------------------------------------------------------------- HELP
export async function help(body) {
  const t = AUTH.user?.tier;
  body.innerHTML = `
    ${sec("Getting started", `<ol class="steps">
      <li><b>Find your place.</b> Type a city, town or village in the search bar at the top, tap the map, or use <i>Use my location</i> on Home.</li>
      <li><b>Read “In plain words”.</b> Every report starts with a one-paragraph summary, then the next 12 hours, then what nearby stations actually measured.</li>
      <li><b>Check alerts.</b> Blue <span class="badge b-official">OFFICIAL</span> cards come from the government (IMD / SDMA via NDMA SACHET). INDRA's own alerts are early screening, never official.</li>
      <li><b>Use the map layers</b> (top-left) to see rain, lightning, satellite cloud and ground stations. Hover a layer name to learn what it shows.</li>
      <li><b>Get alerted.</b> Turn on the bell (browser notifications) and speaker (alarm sound) in the top bar. INDRA keeps running live in the background.</li>
    </ol><button class="btn sm" id="hTour">Take the 30-second tour</button>`)}
    ${sec("What the labels mean", `<div class="kv lbl-kv">
      <dt>${stateBadge("LIVE")}</dt><dd>Fresh data from a real feed, updated in the last few minutes.</dd>
      <dt>${stateBadge("OBSERVED")}</dt><dd>Measured by an instrument (weather station, satellite, lightning sensor).</dd>
      <dt>${stateBadge("ESTIMATED")}</dt><dd>Calculated by INDRA from models — not directly measured.</dd>
      <dt>${stateBadge("EXPERIMENTAL")}</dt><dd>INDRA forecast/nowcast that is not formally validated. Use as a heads-up only.</dd>
      <dt>${stateBadge("OFFICIAL")}</dt><dd>Issued by a government agency. Always follow official instructions first.</dd>
      <dt>${stateBadge("STALE")}</dt><dd>Feed is delayed — the last good data is shown with its age.</dd>
      <dt>${stateBadge("UNAVAILABLE")}</dt><dd>Feed is down or not connected. INDRA never fills the gap with fake data.</dd></div>`)}
    ${sec("Threat levels", `<div class="kv lbl-kv">${["MINIMAL", "LOW", "MEDIUM", "HIGH", "CRITICAL"].map((l) => `<dt><span class="lv lv-${l}">${l}</span></dt><dd>${{ MINIMAL: "Nothing significant expected.", LOW: "Small chance of a storm — normal activities.", MEDIUM: "Storms possible — stay updated, plan outdoor work carefully.", HIGH: "Severe storm likely nearby — avoid open areas, secure loose items.", CRITICAL: "Dangerous storm imminent or ongoing — take shelter, follow official advice." }[l]}</dd>`).join("")}</div>`)}
    ${sec("Glossary", `<div class="kv gl-kv">
      <dt>dBZ / rain rate</dt><dd>How hard it is raining. INDRA uses NASA GPM IMERG satellite rain estimates (mm/h), updated every 30 min with a few hours' delay.</dd>
      <dt>IR cloud tops</dt><dd>Satellite infrared picture. Very cold (bright) cloud tops mean tall storm clouds.</dd>
      <dt>Storm cell</dt><dd>A cluster of heavy rain or cold cloud that INDRA tracks and projects forward.</dd>
      <dt>Nowcast</dt><dd>A very short forecast, 0–6 hours, mostly by following current storms.</dd>
      <dt>CAPE</dt><dd>Energy available for thunderstorms (J/kg). Above ~1000 favours strong storms.</dd>
      <dt>METAR</dt><dd>Standard hourly weather report from airports — INDRA's ground truth.</dd>
      <dt>POD / FAR / CSI</dt><dd>Forecast scores: share of events caught, share of false alarms, and the combined success index.</dd>
      <dt>CAP / SACHET</dt><dd>Common Alerting Protocol — the format of official alerts published on NDMA's SACHET system.</dd>
      <dt>Ensemble spread</dt><dd>How much the five models disagree. Big spread = less certain forecast.</dd></div>`)}
    ${sec("Shortcuts", `<div class="kv"><dt><kbd class="kbd">Ctrl K</kbd></dt><dd>Command palette — jump to any place or module</dd><dt><kbd class="kbd">V</kbd></dt><dd>Voice command, e.g. “weather in Meerut”, “show alerts”, “briefing”</dd><dt><kbd class="kbd">Esc</kbd></dt><dd>Close dialogs</dd><dt>INDRA logo</dt><dd>Return to your dashboard</dd></div>`)}
    ${sec(`Account types · you are ${tierLabel(t)}`, tierTableHtml() + (t !== "professional" ? `<button class="btn sm" style="margin-top:8px" onclick="window.__indraUpgrade('${t === "guest" ? "public" : "professional"}')">${t === "guest" ? "Create an account" : "Upgrade to Professional"}</button>` : ""))}
    ${OFFICIAL}`;
  document.getElementById("hTour").onclick = () => startTour(true);
}
