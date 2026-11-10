// INDRA map: one persistent Leaflet map shared by every module.
import { S, LV_COLOR, url, api, emit, esc, levelOf, fmtTime, hexA, HZ_LABEL, stateBadge, can, compass } from "./core.js";

export const IND_BOUNDS = [[6.0, 67.5], [37.5, 97.8]];
const GRID_BOUNDS = [[5.0, 66.0], [38.0, 99.0]];
let map, statesLayer, districtLayer, selMarker, cellLayer, corridorLayer, lightLayer, flashLayer, labelLayer;
let stationLayer = null;
let hazardOverlay = null, radarQC = null, himLayer = null, himKey = null, officialLayer;
const stateFeat = {};
export const L_ = () => map;

export const LAYERS = [
  { id: "threat", group: "Analysis", label: "State / district threat", on: true, help: "States and districts coloured by INDRA screening threat level." },
  { id: "hazard", group: "Analysis", label: "Hazard nowcast overlay", on: false, badge: "EXPERIMENTAL", feature: "hazard_overlay", help: "Colour = chance of severe weather in the next hours (INDRA model, experimental)." },
  { id: "cells", group: "Analysis", label: "Storm cells + tracks", on: true, help: "Rain/cloud clusters detected from satellite, with predicted path." },
  { id: "official", group: "Official", label: "NDMA SACHET official alerts", on: true, badge: "OFFICIAL", help: "Government-issued warnings (IMD, SDMA, CWC…) from NDMA SACHET." },
  { id: "radar", group: "Observations", label: "IMERG rain-rate loop (NASA GIBS)", on: true, help: "Where it is raining, estimated by NASA satellites (30-min, few hours delay)." },
  { id: "radarqc", group: "Observations", label: "IMERG analysis grid + QC", on: false, feature: "qc_layers" },
  { id: "lightning", group: "Observations", label: "Lightning strikes (60 min)", on: true, help: "Real strikes from the Blitzortung volunteer network. Bright = last 5 min." },
  { id: "stations", group: "Observations", label: "Ground stations (METAR)", on: true, feature: "stations", help: "Measured temperature/wind at airports — the ground truth INDRA is scored against." },
  { id: "sat_ir108", group: "Satellite", label: "IR 10.8 µm cloud tops", on: false, wms: "msg_iodc:ir108" },
  { id: "sat_convection", group: "Satellite", label: "Convection RGB", on: false, wms: "msg_iodc:rgb_convection", feature: "sat_products" },
  { id: "sat_cth", group: "Satellite", label: "Cloud-top height", on: false, wms: "msg_iodc:cth", feature: "sat_products" },
  { id: "sat_wv062", group: "Satellite", label: "Water vapour 6.2 µm", on: false, wms: "msg_iodc:wv062", feature: "sat_products" },
  { id: "sat_vis006", group: "Satellite", label: "Visible 0.6 µm (day)", on: false, wms: "msg_iodc:vis006", feature: "sat_products" },
  { id: "himawari", group: "Satellite", label: "Himawari-9 IR 10.4 µm (NASA GIBS)", on: false, feature: "himawari" },
  { id: "labels", group: "Base", label: "Place labels", on: true },
];
const LBY = Object.fromEntries(LAYERS.map((l) => [l.id, l]));

export function initMap() {
  map = L.map("map", { zoomControl: true, minZoom: innerWidth < 820 ? 3 : 4, maxZoom: 13, zoomSnap: 0.25, worldCopyJump: false, preferCanvas: false, attributionControl: true });
  map.zoomControl.setPosition("topright");
  map.createPane("sat").style.zIndex = 250;
  map.createPane("radar").style.zIndex = 300;
  map.createPane("hazard").style.zIndex = 330;
  map.createPane("polys").style.zIndex = 360;
  map.createPane("labels").style.zIndex = 420; map.getPane("labels").style.pointerEvents = "none";
  map.createPane("cells").style.zIndex = 460;
  map.createPane("ltg").style.zIndex = 470;
  const base = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}", {
    maxZoom: 16, maxNativeZoom: 16, attribution: 'Basemap © <a href="https://www.esri.com/">Esri</a>, HERE, Garmin, © OpenStreetMap contributors · Boundaries: india-maps-data',
  });
  // Fallback: if an Esri tile fails, retry once from OpenStreetMap (greyscaled to match the silver theme).
  base.on("tileerror", (e) => { const t = e.tile, c = e.coords; if (t.dataset.fb) return; t.dataset.fb = 1; t.classList.add("osm-fb");
    t.src = `https://tile.openstreetmap.org/${c.z}/${c.x}/${c.y}.png`; });
  base.addTo(map);
  labelLayer = new (L.TileLayer.extend({ _retainParent: () => false, _retainChildren: () => {} }))("https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}", { maxZoom: 16, maxNativeZoom: 16, pane: "labels", opacity: 0.85 }).addTo(map);
  { const mob = innerWidth < 820, ph = document.getElementById("panel")?.offsetHeight || 0;
    map.fitBounds(IND_BOUNDS, { paddingTopLeft: [10, mob ? 60 : 10], paddingBottomRight: [mob ? 10 : ph ? document.getElementById("panel").offsetWidth + 24 : 10, mob ? Math.max(ph, innerHeight * 0.52) + 20 : 40] }); }
  cellLayer = L.layerGroup([], { pane: "cells" }).addTo(map);
  corridorLayer = L.layerGroup([], { pane: "polys" }).addTo(map);
  lightLayer = L.layerGroup().addTo(map);
  officialLayer = L.layerGroup([], { pane: "polys" }).addTo(map);
  stationLayer = L.layerGroup([], { pane: "cells" });
  flashLayer = L.layerGroup().addTo(map);
  window.addEventListener("resize", () => map.invalidateSize());
  new ResizeObserver(() => map.invalidateSize({ pan: false })).observe(document.getElementById("map"));
  map.on("click", (e) => { if (!e.originalEvent._indraHandled) emit("map-click", e.latlng); });
  loadStates();
  buildLayerBox(true);
  return map;
}

// ---------------- layer box ----------------
export const layerAllowed = (l) => !l.feature || can(l.feature);
export function buildLayerBox(first = false) {
  const box = document.getElementById("layerList");
  let html = "", g = "";
  for (const l of LAYERS) {
    if (!layerAllowed(l) && l.on) { l.on = false; l._was = true; }
    else if (layerAllowed(l) && l._was) { l.on = true; delete l._was; }
    if (l.group !== g) { g = l.group; html += `<div class="layer-group">${g}</div>`; }
    const lk = !layerAllowed(l);
    html += `<label class="layer-row ${lk ? "locked" : ""}" ${l.help ? `title="${esc(l.help)}"` : lk ? 'title="Professional account feature"' : ""}><input type="checkbox" data-layer="${l.id}" ${l.on ? "checked" : ""} ${lk ? 'data-locked="1"' : ""}><span>${esc(l.label)}</span>${lk ? '<span class="lock-ico" aria-label="Locked">PRO</span>' : `<span class="st" id="lst-${l.id}"></span>`}</label>`;
  }
  box.innerHTML = html;
  if (!first) { applyLayers(); return; }
  box.addEventListener("change", (e) => {
    const id = e.target.dataset.layer; if (!id) return;
    if (e.target.dataset.locked) { e.target.checked = false; emit("locked", { feature: LBY[id].feature, what: LBY[id].label }); return; }
    setLayer(id, e.target.checked);
  });
  document.getElementById("layerToggle").onclick = () => {
    const b = document.getElementById("layerBox"); b.classList.toggle("collapsed");
    document.getElementById("layerToggle").textContent = b.classList.contains("collapsed") ? "+" : "–";
  };
  if (innerWidth < 820) { document.getElementById("layerBox").classList.add("collapsed"); document.getElementById("layerToggle").textContent = "+"; }
}
export function setLayer(id, on) {
  const l = LBY[id]; if (!l) return;
  if (on && !layerAllowed(l)) { emit("locked", { feature: l.feature, what: l.label }); return; }
  l.on = on;
  const cb = document.querySelector(`[data-layer="${id}"]`); if (cb) cb.checked = on;
  if (id.startsWith("sat_") && on) LAYERS.filter((x) => x.id.startsWith("sat_") && x.id !== id).forEach((x) => { x.on = false; const c = document.querySelector(`[data-layer="${x.id}"]`); if (c) c.checked = false; });
  applyLayers();
  emit("layers-changed", id);
}
export const layerOn = (id) => !!LBY[id]?.on;
export function layerStatus(id, st) { const el = document.getElementById("lst-" + id); if (el) el.outerHTML = `<span class="st" id="lst-${id}">${stateBadge(st).replace('class="badge', 'class="badge').replace("badge ", "badge ")}</span>`; }

export function applyLayers() {
  if (layerOn("labels")) labelLayer.addTo(map); else map.removeLayer(labelLayer);
  if (statesLayer) { if (layerOn("threat")) { statesLayer.addTo(map); districtLayer && districtLayer.addTo(map); } else { map.removeLayer(statesLayer); districtLayer && map.removeLayer(districtLayer); } }
  if (layerOn("cells")) { cellLayer.addTo(map); corridorLayer.addTo(map); } else { map.removeLayer(cellLayer); map.removeLayer(corridorLayer); }
  if (layerOn("lightning")) { lightLayer.addTo(map); flashLayer.addTo(map); } else { map.removeLayer(lightLayer); map.removeLayer(flashLayer); }
  if (layerOn("official")) officialLayer.addTo(map); else map.removeLayer(officialLayer);
  if (layerOn("stations")) stationLayer.addTo(map); else map.removeLayer(stationLayer);
  refreshHazard(); refreshRadarQC(); refreshHimawari();
  radarLoop.sync(); satLoop.sync();
  updateLegend();
  updateTimebar();
}

// ---------------- states & districts ----------------
async function loadStates() {
  const gj = await fetch(url("/static/geo/states.geojson")).then((r) => r.json());
  statesLayer = L.geoJSON(gj, {
    pane: "polys",
    style: (f) => stateStyle(f.properties.slug),
    onEachFeature: (f, layer) => {
      stateFeat[f.properties.slug] = layer;
      layer.on({
        click: (e) => { e.originalEvent._indraHandled = true; emit("select-state", f.properties.slug); },
        mouseover: () => layer.setStyle({ weight: 2.2, color: "#0098bd" }),
        mouseout: () => statesLayer.resetStyle(layer),
      });
      layer.bindTooltip(() => stateTip(f.properties), { sticky: true, className: "ix-tip", direction: "top", offset: [0, -6] });
    },
  });
  if (layerOn("threat")) statesLayer.addTo(map);
  emit("states-geo", gj);
}
function stateTip(p) {
  const s = S.states[p.slug];
  if (!s) return `<b>${esc(p.name)}</b><br><span class="meta">${p.districts} districts</span>`;
  return `<b>${esc(p.name)}</b> ${`<span class="lv lv-${s.level}">${s.level}</span>`}<br><span class="meta">Peak ${s.score} · ${esc(HZ_LABEL[s.primary_hazard] || "")} · ${s.districts} districts · ${s.cells} active cells · ${s.lightning_30min} strikes/30 min</span>`;
}
function stateStyle(slug) {
  const s = S.states[slug];
  const lv = s ? s.level : "UNKNOWN";
  const sel = S.selected?.state === slug;
  const dim = S.selected?.state && !sel && districtLayer;
  return {
    color: sel ? "#0098bd" : "rgba(60,95,120,.55)", weight: sel ? 2.4 : 0.9,
    fillColor: LV_COLOR[lv], fillOpacity: dim ? 0.04 : lv === "MINIMAL" || lv === "UNKNOWN" ? 0.06 : lv === "LOW" ? 0.16 : 0.26,
  };
}
export function restyleStates() { if (statesLayer) statesLayer.eachLayer((l) => l.setStyle(stateStyle(l.feature.properties.slug))); }

let districtSlug = null, districtLevels = {};
export async function showDistricts(slug, levels) {
  districtLevels = Object.fromEntries((levels || []).map((d) => [d.id, d]));
  if (districtSlug === slug && districtLayer) { districtLayer.setStyle(distStyle); return; }
  clearDistricts();
  districtSlug = slug;
  const gj = await fetch(url(`/static/geo/districts/${slug}.geojson`)).then((r) => r.json());
  if (districtSlug !== slug) return;
  districtLayer = L.geoJSON(gj, {
    pane: "polys", style: distStyle,
    onEachFeature: (f, layer) => {
      layer.on({
        click: (e) => { e.originalEvent._indraHandled = true; emit("select-district", f.properties.id); },
        mouseover: () => layer.setStyle({ weight: 2.4, color: "#0098bd" }),
        mouseout: () => districtLayer && districtLayer.resetStyle(layer),
      });
      layer.bindTooltip(() => {
        const d = districtLevels[f.properties.id];
        return `<b>${esc(f.properties.name)}</b> ${d ? `<span class="lv lv-${d.level}">${d.level}</span><br><span class="meta">Score ${d.score ?? "—"} · ${esc(HZ_LABEL[d.primary_hazard] || "")}</span>` : ""}`;
      }, { sticky: true, className: "ix-tip" });
    },
  });
  if (layerOn("threat")) districtLayer.addTo(map);
  restyleStates();
}
function distStyle(f) {
  const d = districtLevels[f.properties.id];
  const lv = d ? d.level : "UNKNOWN";
  const sel = S.selected?.district === f.properties.id;
  return { color: sel ? "#0098bd" : "rgba(40,80,105,.6)", weight: sel ? 2.6 : 0.8, fillColor: LV_COLOR[lv] || LV_COLOR.UNKNOWN,
    fillOpacity: lv === "MINIMAL" || lv === "UNKNOWN" ? 0.08 : lv === "LOW" ? 0.22 : 0.36 };
}
export function updateDistrictLevels(levels) { districtLevels = Object.fromEntries(levels.map((d) => [d.id, d])); districtLayer && districtLayer.setStyle(distStyle); }
export function clearDistricts() { if (districtLayer) map.removeLayer(districtLayer); districtLayer = null; districtSlug = null; restyleStates(); }
export function fitState(slug) {
  const l = stateFeat[slug]; if (!l) return;
  map.flyToBounds(l.getBounds(), { padding: padFor(), duration: 0.9, maxZoom: 8 });
}
export function fitBbox(b) { map.flyToBounds([[b[1], b[0]], [b[3], b[2]]], { padding: padFor(), duration: 0.9, maxZoom: 10 }); }
export function padFor() { return innerWidth < 820 ? [20, 20] : [40, 40]; }
export function flyTo(lat, lon, z = 10) {
  const pw = innerWidth >= 820 ? (document.getElementById("panel").offsetWidth + 24) : 0;
  const ph = innerWidth < 820 ? document.getElementById("panel").offsetHeight : 0;
  const target = map.project([lat, lon], z).add([pw / 2, ph / 2]);
  map.flyTo(map.unproject(target, z), z, { duration: 1.0 });
}
export function homeView() { clearDistricts(); setSelMarker(null); const pw = innerWidth >= 820 ? document.getElementById("panel").offsetWidth + 24 : 0; map.flyToBounds(IND_BOUNDS, { paddingTopLeft: [10, 10], paddingBottomRight: [pw, innerWidth < 820 ? (document.getElementById("panel").offsetHeight - 60 + 80) : 40], duration: 0.9 }); }
export function setSelMarker(ll, label) {
  if (selMarker) { map.removeLayer(selMarker); selMarker = null; }
  if (!ll) return;
  selMarker = L.marker(ll, { icon: L.divIcon({ className: "", html: '<div class="sel-pulse"></div>', iconSize: [22, 22], iconAnchor: [11, 11] }), interactive: false, zIndexOffset: 1000 }).addTo(map);
  if (label) selMarker.bindTooltip(esc(label), { permanent: true, direction: "right", offset: [12, 0], className: "ix-tip" });
}

// ---------------- storm cells ----------------
let selectedCell = null;
export function drawCells(cells) {
  cellLayer.clearLayers(); corridorLayer.clearLayers();
  for (const c of cells) {
    const col = LV_COLOR[c.severity] || LV_COLOR.LOW;
    const isSel = selectedCell === c.id;
    if (c.latent) { drawLatentCell(c, isSel); continue; }
    const showCorr = isSel || c.severity === "CRITICAL" || (c.severity === "HIGH" && c.source === "radar");
    if (showCorr && c.corridor?.length) L.polygon(c.corridor.map((p) => [p[0], p[1]]), { pane: "polys", color: col, weight: isSel ? 2 : 1, dashArray: "5 4", fillColor: col, fillOpacity: isSel ? 0.16 : 0.07, interactive: false }).addTo(corridorLayer);
    if (c.footprint?.length && (isSel || c.source === "radar")) L.polygon(c.footprint.map((p) => [p[0], p[1]]), { pane: "cells", color: col, weight: 1.2, fillColor: col, fillOpacity: 0.25, interactive: false }).addTo(cellLayer);
    if (c.forecast_path?.length && c.motion?.speed_kmh) {
      const pts = [[c.lat, c.lon], ...c.forecast_path.map((p) => [p.lat, p.lon])];
      L.polyline(pts, { pane: "cells", color: col, weight: isSel ? 3 : 2, opacity: 0.9, interactive: false }).addTo(cellLayer);
      const end = pts[pts.length - 1];
      L.circleMarker(end, { pane: "cells", radius: 3, color: col, fillColor: "#fff", fillOpacity: 1, weight: 2, interactive: false }).addTo(cellLayer);
    }
    const r = Math.max(5, Math.min(16, Math.sqrt(c.area_km2 || 50) / 3));
    const m = L.circleMarker([c.lat, c.lon], { pane: "cells", radius: r, color: "#fff", weight: 2, fillColor: col, fillOpacity: c.source === "radar" ? 0.95 : 0.6, dashArray: c.source === "satellite" ? "3 2" : null });
    m.bindTooltip(`<b>${esc(c.id)}</b> <span class="lv lv-${c.severity}">${c.severity}</span><br>${esc(HZ_LABEL[c.primary_hazard])} · ${c.source === "radar" ? `${c.intensity.max_rain_mmh ?? "—"} mm/h (IMERG)` : `${c.intensity.min_bt_est_k} K (est.)`}<br><span class="meta">${c.motion?.speed_kmh ? `${Math.round(c.motion.speed_kmh)} km/h → ${Math.round(c.motion.towards_deg)}°` : "Motion: not yet tracked"} · ${esc(c.trend?.state || "")}</span>`, { className: "ix-tip", direction: "top" });
    m.on("click", (e) => { e.originalEvent._indraHandled = true; L.DomEvent.stop(e); emit("select-cell", c.id); });
    m.addTo(cellLayer);
  }
}
// IMERG rain cells observed hours ago (NASA latency): grey ring, no track/corridor, explicit age in tooltip
function drawLatentCell(c, isSel) {
  const col = LV_COLOR[c.severity] || LV_COLOR.LOW;
  if (isSel && c.footprint?.length) L.polygon(c.footprint.map((p) => [p[0], p[1]]), { pane: "cells", color: "#6d7c8c", weight: 1, dashArray: "2 3", fillColor: col, fillOpacity: 0.15, interactive: false }).addTo(cellLayer);
  const r = Math.max(4, Math.min(11, Math.sqrt(c.area_km2 || 50) / 4));
  const m = L.circleMarker([c.lat, c.lon], { pane: "cells", radius: r, color: col, weight: 1.6, fillColor: "#e9eef3", fillOpacity: 0.55, dashArray: "2 2" });
  m.bindTooltip(`<b>${esc(c.id)}</b> ${stateBadge("DELAYED")}<br>Rain ${c.intensity.max_rain_mmh ?? "—"} mm/h · ${esc(c.status_label || "")}<br><span class="meta">Satellite precipitation history — not a current position. No ETA issued.</span>`, { className: "ix-tip", direction: "top" });
  m.on("click", (e) => { e.originalEvent._indraHandled = true; L.DomEvent.stop(e); emit("select-cell", c.id); });
  m.addTo(cellLayer);
}

// ---------------- official alerts (NDMA SACHET) ----------------
const OFF_COL = { WARNING: "#c62828", ALERT: "#e2621f", WATCH: "#c9a20c", ADVISORY: "#1d4f91" };
export function drawOfficial(alerts) {
  if (!officialLayer) return;
  officialLayer.clearLayers();
  for (const a of alerts || []) {
    if (a.status && a.status !== "ACTIVE") continue;
    if (a.lat == null) continue;
    const col = OFF_COL[a.level] || "#1d4f91";
    const tip = `<span class="badge b-official">OFFICIAL</span> <b>${esc(a.level)}</b> · ${esc(a.event)}<br>${esc(a.issuer)} · until ${fmtTime(a.effective_until)}<br><span class="meta">${esc(a.area_description).slice(0, 140)}</span>`;
    if (a.radius_km) L.circle([a.lat, a.lon], { radius: a.radius_km * 1000, pane: "polys", color: col, weight: 1.6, dashArray: "6 4", fillColor: col, fillOpacity: 0.07, interactive: false }).addTo(officialLayer);
    const mk = L.marker([a.lat, a.lon], { icon: L.divIcon({ className: "", html: `<div class="off-pin" style="--c:${col}">!</div>`, iconSize: [20, 20], iconAnchor: [10, 10] }), zIndexOffset: 500 });
    mk.bindTooltip(tip, { className: "ix-tip", direction: "top" });
    mk.on("click", (e) => { e.originalEvent._indraHandled = true; L.DomEvent.stop(e); emit("select-official", a.id); });
    mk.addTo(officialLayer);
  }
}

// ---------------- ground stations (METAR, observed) ----------------
export function drawStations(list) {
  if (!stationLayer) return;
  stationLayer.clearLayers();
  const now = Date.now() / 1000;
  for (const o of list || []) {
    if (o.lat == null || o.temp == null) continue;
    const mins = Math.round((now - o.t) / 60);
    const wet = o.ts ? "ts" : o.rain ? "rn" : "";
    const mk = L.marker([o.lat, o.lon], { icon: L.divIcon({ className: "", html: `<div class="stn-pin ${wet}">${Math.round(o.temp)}°</div>`, iconSize: [30, 18], iconAnchor: [15, 9] }), zIndexOffset: 300 });
    mk.bindTooltip(`<span class="badge b-live">OBSERVED</span> <b>${esc(o.name || o.icao)}</b> (${esc(o.icao)})<br>Temp ${o.temp} °C · dew point ${o.dewp ?? "—"} °C<br>Wind ${o.wspd_kmh ?? "—"} km/h ${compass(o.wdir)}${o.wgst_kmh ? ` · gust ${o.wgst_kmh}` : ""}<br>${o.wx ? "Weather: " + esc(o.wx) + " · " : ""}Visibility ${o.visib_km ?? "—"} km<br><span class="meta">METAR ${mins} min ago · aviationweather.gov</span>`, { className: "ix-tip", direction: "top" });
    mk.on("click", (e) => { e.originalEvent._indraHandled = true; L.DomEvent.stop(e); emit("map-click", L.latLng(o.lat, o.lon)); });
    mk.addTo(stationLayer);
  }
}

// ---------------- Himawari IR (NASA GIBS, latest frame) ----------------
export function refreshHimawari() {
  const fr = S.radar?.himawari?.frames || [];
  if (!layerOn("himawari") || !fr.length) { if (himLayer) { map.removeLayer(himLayer); himLayer = null; himKey = null; } return; }
  const f = fr[fr.length - 1];
  if (himKey === f.time && himLayer) return;
  const nl = L.tileLayer(f.tiles, { pane: "sat", opacity: 0.7, maxNativeZoom: 6, maxZoom: 13, bounds: GRID_BOUNDS, attribution: "Himawari-9 © JMA via NASA GIBS" }).addTo(map);
  const old = himLayer; himLayer = nl; himKey = f.time;
  if (old) nl.once("load", () => map.removeLayer(old));
}

export function selectCellOnMap(id) { selectedCell = id; drawCells(S.cells); }

// ---------------- lightning ----------------
const ltgRenderer = L.canvas({ padding: 0.3, pane: "ltg" });
export function drawLightning(strikes) {
  lightLayer.clearLayers();
  const now = Date.now() / 1000;
  for (const [t, la, lo] of strikes) {
    const a = (now - t) / 60;
    if (a > 60) continue;
    const col = a < 5 ? "#ffffff" : a < 15 ? "#b49cff" : a < 30 ? "#7a5cff" : "#5b4bb0";
    L.circleMarker([la, lo], { renderer: ltgRenderer, radius: a < 5 ? 3.2 : 2.4, color: a < 5 ? "#6b4fd8" : col, weight: a < 5 ? 1.5 : 0, fillColor: col, fillOpacity: a < 30 ? 0.95 : 0.6, interactive: false }).addTo(lightLayer);
  }
}
export function flashStrikes(strikes) {
  if (!layerOn("lightning") || !strikes.length) return;
  const b = map.getBounds().pad(0.1);
  let n = 0;
  for (const [, la, lo] of strikes) {
    if (!b.contains([la, lo]) || n++ > 60) continue;
    const m = L.circleMarker([la, lo], { pane: "ltg", radius: 2, color: "#7a5cff", weight: 2, fillColor: "#fff", fillOpacity: 1, interactive: false }).addTo(flashLayer);
    let k = 0;
    const iv = setInterval(() => { k++; m.setRadius(2 + k * 1.6); m.setStyle({ opacity: 1 - k / 12, fillOpacity: 1 - k / 10 }); if (k >= 12) { clearInterval(iv); flashLayer.removeLayer(m); } }, 45);
  }
}

// ---------------- hazard overlay ----------------
export const hazardState = { hazard: "all", lead: 0, stamp: 0 };
export function refreshHazard(force) {
  if (!layerOn("hazard")) { if (hazardOverlay) { map.removeLayer(hazardOverlay); hazardOverlay = null; } return; }
  const u = url(`/api/overlay/hazard.png?hazard=${hazardState.hazard}&lead=${hazardState.lead}&f=${S.national?.generated_at || 0}`);
  if (hazardOverlay && !force) hazardOverlay.setUrl(u);
  else { hazardOverlay && map.removeLayer(hazardOverlay); hazardOverlay = L.imageOverlay(u, GRID_BOUNDS, { pane: "hazard", opacity: 0.8, interactive: false }).addTo(map); }
}
function refreshRadarQC() {
  if (!layerOn("radarqc")) { if (radarQC) { map.removeLayer(radarQC); radarQC = null; } return; }
  const u = url(`/api/overlay/radar.png?f=${S.status?.radar?.frame_time || 0}`);
  if (radarQC) radarQC.setUrl(u); else radarQC = L.imageOverlay(u, GRID_BOUNDS, { pane: "radar", opacity: 0.85, interactive: false }).addTo(map);
}
export function refreshOverlays() { refreshHazard(); refreshRadarQC(); }

// ---------------- loops (radar tiles / satellite WMS) ----------------
class Loop {
  constructor(kind) { this.kind = kind; this.frames = []; this.layers = []; this.idx = -1; this.timer = null; this.playing = false; this.speed = 700; }
  setFrames(frames) {
    const sameLast = this.frames.length && frames.length && this.frames[this.frames.length - 1].time === frames[frames.length - 1].time && this.frames.length === frames.length && this.wmsKey === this.curWms();
    if (sameLast) return;
    const atEnd = this.idx === -1 || this.idx >= this.frames.length - 1;
    this.layers.forEach((l) => l && map.removeLayer(l));
    this.frames = frames; this.layers = frames.map(() => null);
    this.wmsKey = this.curWms();
    this.idx = atEnd ? frames.length - 1 : Math.min(this.idx, frames.length - 1);
    this.sync();
  }
  curWms() { const l = LAYERS.find((x) => x.wms && x.on); return l ? l.wms : null; }
  active() { return this.kind === "radar" ? layerOn("radar") : !!this.curWms(); }
  make(i) {
    const f = this.frames[i];
    if (this.kind === "radar") return L.tileLayer(f.tiles, { pane: "radar", opacity: 0, maxNativeZoom: 6, maxZoom: 13, tileSize: 256, attribution: "Precipitation: GPM IMERG via NASA GIBS", bounds: GRID_BOUNDS });
    const wms = this.curWms();
    // Web-Mercator image proxied + cached by the INDRA backend (aligned with the basemap, fast for every user)
    const q = new URLSearchParams({ layer: wms, time: f.time_iso });
    return L.imageOverlay(url(`/api/overlay/sat.png?${q}`), GRID_BOUNDS, { pane: "sat", opacity: 0, interactive: false, attribution: "Satellite © EUMETSAT" });
  }
  sync() {
    if (!map) return;
    if (this.kind === "sat" && this.wmsKey !== this.curWms() && this.frames.length) { this.layers.forEach((l) => l && map.removeLayer(l)); this.layers = this.frames.map(() => null); this.wmsKey = this.curWms(); }
    if (!this.active() || !this.frames.length) { this.layers.forEach((l) => l && map.removeLayer(l)); this.layers = this.frames.map(() => null); this.stop(true); return; }
    this.show(this.idx < 0 ? this.frames.length - 1 : this.idx);
  }
  show(i) {
    if (!this.frames.length) return;
    this.idx = (i + this.frames.length) % this.frames.length;
    const op = this.kind === "radar" ? 0.78 : 0.72;
    // preload next frame for smooth playback
    [this.idx, (this.idx + 1) % this.frames.length].forEach((k) => { if (!this.layers[k]) { this.layers[k] = this.make(k); this.layers[k].addTo(map); } });
    this.layers.forEach((l, k) => l && l.setOpacity(k === this.idx ? op : 0));
    emit("loop-frame", { kind: this.kind, idx: this.idx, frame: this.frames[this.idx], n: this.frames.length });
  }
  play() { if (this.playing) return; this.playing = true; this.timer = setInterval(() => this.show(this.idx + 1), this.speed); emit("loop-play", this.kind); }
  stop(silent) { this.playing = false; clearInterval(this.timer); if (!silent) emit("loop-play", this.kind); }
  toggle() { this.playing ? this.stop() : this.play(); }
}
export const radarLoop = new Loop("radar");
export const satLoop = new Loop("sat");

// ---------------- time bar ----------------
export const timeMode = { mode: "auto" }; // auto | radar | sat | nowcast
function activeLoop() {
  const m = timeMode.mode;
  if (m === "nowcast") return null;
  if (m === "sat" && satLoop.active()) return satLoop;
  if (m === "radar" && radarLoop.active()) return radarLoop;
  if (satLoop.active()) return satLoop;
  if (radarLoop.active()) return radarLoop;
  return null;
}
export function updateTimebar() {
  const tb = document.getElementById("timebar"), rg = document.getElementById("tbRange");
  if (timeMode.mode === "nowcast" || (layerOn("hazard") && !activeLoop())) {
    if (!layerOn("hazard")) setLayer("hazard", true);
    tb.hidden = false; tb.classList.toggle("playing", !!nowcastTimer);
    document.getElementById("tbTitle").textContent = `NOWCAST · ${HZ_LABEL[hazardState.hazard].toUpperCase()}`;
    rg.max = 6; rg.value = hazardState.lead;
    const base = S.national?.generated_at || Date.now() / 1000;
    document.getElementById("tbTime").textContent = `T+${hazardState.lead} h · valid ${fmtTime(base + hazardState.lead * 3600)}`;
    document.getElementById("tbBadge").outerHTML = `<span id="tbBadge">${stateBadge("EXPERIMENTAL")}</span>`;
    document.getElementById("tbTicks").innerHTML = [0, 1, 2, 3, 4, 5, 6].map((h) => `<span>+${h}h</span>`).join("");
    return;
  }
  const lp = activeLoop();
  if (!lp || !lp.frames.length) { tb.hidden = true; return; }
  tb.hidden = false; tb.classList.toggle("playing", lp.playing);
  rg.max = lp.frames.length - 1; rg.value = lp.idx;
  const f = lp.frames[lp.idx];
  document.getElementById("tbTitle").textContent = lp.kind === "radar" ? "RAIN LOOP · NASA GIBS IMERG" : `SATELLITE LOOP · ${LAYERS.find((x) => x.wms === lp.curWms())?.label.toUpperCase().replace("ΜM", "µm")}`;
  const age = Date.now() / 1000 - f.time;
  document.getElementById("tbTime").textContent = `${fmtTime(f.time)} · ${lp.idx + 1}/${lp.frames.length}`;
  document.getElementById("tbBadge").outerHTML = `<span id="tbBadge">${stateBadge(lp.idx === lp.frames.length - 1 ? (age < (lp.kind === "radar" ? 5400 : 1800) ? "LIVE" : lp.kind === "radar" ? "DELAYED" : "STALE") : "ARCHIVE")}</span>`;
  const first = lp.frames[0].time, last = lp.frames[lp.frames.length - 1].time;
  document.getElementById("tbTicks").innerHTML = `<span>${fmtTime(first, { noTz: true })}</span><span>${fmtTime((first + last) / 2, { noTz: true })}</span><span>${fmtTime(last, { noTz: true })}</span>`;
}
let nowcastTimer = null;
export function initTimebar() {
  const rg = document.getElementById("tbRange");
  rg.addEventListener("input", () => {
    const lp = activeLoop();
    if (timeMode.mode === "nowcast" || !lp) { hazardState.lead = +rg.value; refreshHazard(); emit("nowcast-lead", hazardState.lead); updateTimebar(); return; }
    lp.stop(true); lp.show(+rg.value);
  });
  document.getElementById("tbPlay").onclick = () => {
    const lp = activeLoop();
    if (timeMode.mode === "nowcast" || !lp) {
      if (nowcastTimer) { clearInterval(nowcastTimer); nowcastTimer = null; }
      else nowcastTimer = setInterval(() => { hazardState.lead = (hazardState.lead + 1) % 7; refreshHazard(); emit("nowcast-lead", hazardState.lead); updateTimebar(); }, 1400);
      updateTimebar(); return;
    }
    lp.toggle(); updateTimebar();
  };
}

// ---------------- legend ----------------
export function updateLegend() {
  const el = document.getElementById("legend");
  let h = `<div class="lg-title">Threat level</div>` + ["LOW", "MEDIUM", "HIGH", "CRITICAL"].map((l) => `<div class="lg-row"><span class="lg-sw" style="background:${LV_COLOR[l]}"></span>${l}<span class="meta" style="margin-left:auto">${{ LOW: "≥20", MEDIUM: "≥40", HIGH: "≥60", CRITICAL: "≥80" }[l]}</span></div>`).join("");
  if (layerOn("radar") || layerOn("radarqc")) h += `<div class="lg-title" style="margin-top:6px">IMERG rain rate mm/h</div><div class="lg-bar" style="background:linear-gradient(90deg,#00764e,#4ec300,#c3e400,#ffb006,#632ee5,#770bd1,#770792,#3f0336)"></div><div class="lg-row mono" style="justify-content:space-between;font-size:9.5px"><span>0.1</span><span>1</span><span>5</span><span>20</span><span>50+</span></div>`;
  if (layerOn("official")) h += `<div class="lg-title" style="margin-top:6px">Official (SACHET)</div><div class="lg-row">${["WARNING", "ALERT", "WATCH"].map((k) => `<span class="lg-sw" style="background:${OFF_COL[k]}"></span>${k[0] + k.slice(1).toLowerCase()}`).join(" ")}</div>`;
  if (layerOn("lightning")) h += `<div class="lg-title" style="margin-top:6px">Lightning age</div><div class="lg-row"><span class="lg-sw" style="background:#fff;border-color:#6b4fd8"></span>&lt;5<span class="lg-sw" style="background:#b49cff"></span>&lt;15<span class="lg-sw" style="background:#7a5cff"></span>&lt;30<span class="lg-sw" style="background:#5b4bb0"></span>&lt;60 min</div>`;
  el.innerHTML = h;
}
