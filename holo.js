// INDRA holographic layer: INDRA Core assistant, HUD frame with live coordinate rulers,
// target lock, map pings, panel materialise + text decode, system vitals.
// Everything here reads real app state (map bounds, feed states, alerts, accuracy) — nothing is decorative-only data.
import { S, AUTH, on, esc, say, savePrefs, LV_COLOR, HZ_LABEL } from "./core.js";
import * as M from "./map.js";

const RM = matchMedia("(prefers-reduced-motion: reduce)").matches;
let opts = {};
const $ = (id) => document.getElementById(id);

export function init(o) {
  opts = o;
  document.body.classList.add("holo");
  injectFx();
  hudFrame();
  core();
  vitals();
  ripples();
  on("map-click", (ll) => ping(ll));
  on("ev:fusion", () => pulseFrame());
}

// ------------------------------------------------------------ ambient FX (non-interactive)
function injectFx() {
  const st = document.querySelector(".stage");
  st.insertAdjacentHTML("afterbegin", `<div class="hfx" aria-hidden="true"><div class="hfx-scan"></div><div class="hfx-lines"></div><div class="hfx-vig"></div></div>`);
}

// ------------------------------------------------------------ HUD frame over the map
const fmtLat = (v) => `${Math.abs(v).toFixed(2)}°${v >= 0 ? "N" : "S"}`;
const fmtLon = (v) => `${Math.abs(v).toFixed(2)}°${v >= 0 ? "E" : "W"}`;
function niceStep(span) {
  const raw = span / 6, p = Math.pow(10, Math.floor(Math.log10(raw)));
  return [1, 2, 2.5, 5, 10].map((k) => k * p).find((s) => s >= raw) || raw;
}
function hudFrame() {
  const st = document.querySelector(".stage");
  st.insertAdjacentHTML("beforeend", `<div class="hframe" id="hframe" aria-hidden="true">
    <i class="hf-c tl"></i><i class="hf-c tr"></i><i class="hf-c bl"></i><i class="hf-c br"></i>
    <div class="hf-ruler top" id="hfTop"></div><div class="hf-ruler left" id="hfLeft"></div>
    <div class="hf-read mono" id="hfRead"><span>CURSOR</span><b id="hfCur">—</b><span>ZOOM</span><b id="hfZoom">—</b><span>SCALE</span><b id="hfScale">—</b></div>
    <div class="hf-lock" id="hfLock" hidden><svg viewBox="0 0 120 120"><circle cx="60" cy="60" r="44" class="lk-r1"/><circle cx="60" cy="60" r="30" class="lk-r2"/><path d="M60 4v18M60 98v18M4 60h18M98 60h18" class="lk-t"/><path d="M22 22h12M22 22v12M98 22H86M98 22v12M22 98h12M22 98V86M98 98H86M98 98V86" class="lk-b"/></svg><span class="lk-l mono" id="hfLockL">TARGET</span></div>
  </div>`);
  const map = M.L_();
  const draw = () => {
    const b = map.getBounds(), sz = map.getSize();
    const top = $("hfTop"), left = $("hfLeft");
    const w = b.getWest(), e = b.getEast(), n = b.getNorth(), s = b.getSouth();
    const sx = niceStep(e - w), sy = niceStep(n - s);
    let th = "", lh = "";
    for (let x = Math.ceil(w / sx) * sx; x <= e; x += sx) {
      const px = map.latLngToContainerPoint([n, x]).x;
      if (px > 30 && px < sz.x - 30) th += `<span style="left:${px}px">${fmtLon(x)}</span>`;
    }
    for (let y = Math.ceil(s / sy) * sy; y <= n; y += sy) {
      const py = map.latLngToContainerPoint([y, w]).y;
      if (py > 70 && py < sz.y - 50) lh += `<span style="top:${py}px">${fmtLat(y)}</span>`;
    }
    top.innerHTML = th; left.innerHTML = lh;
    $("hfZoom").textContent = "Z" + map.getZoom().toFixed(1);
    // metres per 100 px at map centre
    const c = map.getCenter(), p = map.latLngToContainerPoint(c);
    const km = map.containerPointToLatLng([p.x + 100, p.y]).distanceTo(c) / 1000;
    $("hfScale").textContent = (km >= 10 ? Math.round(km) : km.toFixed(1)) + " km/100px";
    placeLock();
  };
  map.on("move zoom resize", draw);
  map.on("mousemove", (e) => { $("hfCur").textContent = `${fmtLat(e.latlng.lat)} ${fmtLon(e.latlng.lng)}`; });
  map.on("mouseout", () => { $("hfCur").textContent = "—"; });
  draw();
  addEventListener("hashchange", lockFromHash);
  lockFromHash();
}
let lockLL = null;
function lockFromHash() {
  const h = location.hash.replace(/^#\/?/, "");
  if (h.startsWith("loc/")) {
    const [la, lo, ...nm] = h.slice(4).split(",");
    lockLL = [+la, +lo];
    $("hfLockL").textContent = "TARGET · " + (decodeURIComponent(nm.join(",")) || `${fmtLat(+la)} ${fmtLon(+lo)}`).toUpperCase().slice(0, 28);
    const el = $("hfLock");
    el.hidden = false; el.classList.remove("acq"); void el.offsetWidth; el.classList.add("acq");
  } else { lockLL = null; $("hfLock").hidden = true; }
  placeLock();
}
function placeLock() {
  if (!lockLL) return;
  const p = M.L_().latLngToContainerPoint(lockLL);
  Object.assign($("hfLock").style, { left: p.x + "px", top: p.y + "px" });
}
function ping(ll) {
  if (RM || !ll) return;
  const p = M.L_().latLngToContainerPoint(ll);
  const el = document.createElement("div");
  el.className = "hping"; el.style.left = p.x + "px"; el.style.top = p.y + "px";
  el.innerHTML = `<i></i><i></i><span class="mono">${fmtLat(ll.lat)} ${fmtLon(ll.lng)}</span>`;
  $("hframe").appendChild(el);
  setTimeout(() => el.remove(), 1600);
}
function pulseFrame() { const f = $("hframe"); if (!f || RM) return; f.classList.remove("pulse"); void f.offsetWidth; f.classList.add("pulse"); }

// ------------------------------------------------------------ panel materialise + decode title
const GLYPHS = "▚▞▟▙█▓▒░<>/\\|=+*#ABCDEFGHJKLMNPRSTUVWXYZ0123456789";
export function decode(el, text, ms = 520) {
  if (!el) return;
  if (RM) { el.textContent = text; return; }
  const t0 = performance.now();
  const step = (now) => {
    const k = Math.min(1, (now - t0) / ms), n = Math.floor(text.length * k);
    el.textContent = text.slice(0, n) + [...text.slice(n)].map((ch) => (ch === " " ? " " : GLYPHS[(Math.random() * GLYPHS.length) | 0])).join("");
    if (k < 1) requestAnimationFrame(step); else el.textContent = text;
  };
  requestAnimationFrame(step);
}
export function panelEnter() {
  const p = $("panel");
  if (!p) return;
  if (!RM) { p.classList.remove("materialize"); void p.offsetWidth; p.classList.add("materialize"); }
  const t = $("panelTitle");
  setTimeout(() => decode(t, t.textContent), 0);
}

// ------------------------------------------------------------ system vitals (real feed states)
function vitals() {
  const tk = $("ticker");
  tk.insertAdjacentHTML("afterbegin", `<div class="vitals" id="vitals" title="Live feed health"><span class="vt-l mono">FEEDS</span><span class="vt-bars" id="vtBars"></span><span class="vt-n mono" id="vtN">—</span></div>`);
  const upd = () => {
    const f = (S.status?.feeds || []).filter((x) => !["NOT CONNECTED", "NOT CHECKED"].includes(x.state));
    const cls = (st) => (st === "LIVE" || st === "OBSERVED" ? "ok" : st === "UNAVAILABLE" ? "bad" : "mid");
    $("vtBars").innerHTML = f.map((x) => `<i class="${cls(x.state)}" title="${esc(x.name)}: ${esc(x.state)}"></i>`).join("");
    const live = f.filter((x) => cls(x.state) === "ok").length;
    $("vtN").textContent = f.length ? `${live}/${f.length} LIVE` : "—";
  };
  upd(); setInterval(upd, 5000);
}

// ------------------------------------------------------------ click ripples
function ripples() {
  if (RM) return;
  document.addEventListener("pointerdown", (e) => {
    const b = e.target.closest(".btn, .rail-btn, .icon-btn, .hc-chip, .gate-kind");
    if (!b) return;
    const r = b.getBoundingClientRect();
    const i = document.createElement("i");
    i.className = "ripple";
    i.style.left = e.clientX - r.left + "px"; i.style.top = e.clientY - r.top + "px";
    b.appendChild(i);
    setTimeout(() => i.remove(), 650);
  });
}

// ------------------------------------------------------------ INDRA Core assistant
const CHIPS = [["Brief me", "brief me"], ["Weather here", "weather near me"], ["Any alerts?", "any alerts"], ["How accurate?", "how accurate are you"], ["Show radar", "show radar"], ["Help", "what can you do"]];
let busy = false;
function core() {
  const top = document.querySelector(".top-right");
  top.insertAdjacentHTML("afterbegin", `<button class="hcore" id="hcore" aria-label="INDRA Core assistant" aria-expanded="false" title="INDRA Core — talk or type (J)">
    <svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="29" class="hc-r0"/><circle cx="32" cy="32" r="25" class="hc-r1"/><circle cx="32" cy="32" r="19" class="hc-r2"/><circle cx="32" cy="32" r="13" class="hc-r3"/><circle cx="32" cy="32" r="7" class="hc-core"/></svg>
    <span class="hc-lbl mono">CORE</span></button>`);
  document.body.insertAdjacentHTML("beforeend", `<section class="hconsole glass holo-frame" id="hconsole" hidden aria-label="INDRA Core assistant">
    <header class="hc-h"><div class="hc-id"><span class="hc-dot"></span><b>INDRA CORE</b><span class="mono" id="hcState">ONLINE</span></div>
      <div class="hc-tools"><button class="icon-btn sm" id="hcVoiceOut" title="Spoken replies" aria-label="Toggle spoken replies"><svg viewBox="0 0 24 24"><path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16 9a4 4 0 0 1 0 6"/></svg></button><button class="icon-btn sm" id="hcClose" aria-label="Close assistant"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div></header>
    <div class="hc-watch mono" id="hcWatch"></div>
    <div class="hc-log" id="hcLog" role="log" aria-live="polite"></div>
    <div class="hc-chips">${CHIPS.map(([t, q]) => `<button class="hc-chip" data-q="${esc(q)}">${t}</button>`).join("")}</div>
    <form class="hc-in" id="hcForm"><button type="button" class="icon-btn" id="hcMic" title="Speak (V)" aria-label="Speak a command"><svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg></button><input id="hcInput" autocomplete="off" placeholder="Ask INDRA… e.g. weather in Meerut, brief me"><button class="btn sm" type="submit">Send</button></form>
  </section>`);
  const btn = $("hcore"), con = $("hconsole");
  const toggle = (show = con.hidden) => {
    con.hidden = !show; btn.setAttribute("aria-expanded", String(show)); btn.classList.toggle("open", show);
    if (show) { watch(); if (!$("hcLog").children.length) greet(); setTimeout(() => $("hcInput").focus(), 30); }
  };
  btn.onclick = () => toggle();
  $("hcClose").onclick = () => toggle(false);
  $("hcMic").onclick = () => opts.startVoice?.();
  const vo = $("hcVoiceOut");
  const syncVo = () => vo.classList.toggle("active", !!S.prefs.voice);
  vo.onclick = () => { S.prefs.voice = !S.prefs.voice; savePrefs(); syncVo(); };
  syncVo();
  con.querySelectorAll(".hc-chip").forEach((c) => (c.onclick = () => ask(c.dataset.q)));
  $("hcForm").onsubmit = (e) => { e.preventDefault(); const v = $("hcInput").value.trim(); if (v) { $("hcInput").value = ""; ask(v); } };
  document.addEventListener("keydown", (e) => {
    if (e.key.toLowerCase() === "j" && !e.target.closest("input,textarea,select") && !e.ctrlKey && !e.metaKey) { e.preventDefault(); toggle(); }
    if (e.key === "Escape" && !con.hidden) toggle(false);
  });
  on("say", (t) => line("indra", t));
  on("speaking", (v) => { btn.classList.toggle("speaking", v); $("hcState").textContent = v ? "SPEAKING" : "ONLINE"; });
  on("ev:alert", (e) => {
    const d = e.data || {};
    if (!["ISSUED", "ESCALATED"].includes(d.event) || !["HIGH", "CRITICAL"].includes(d.level)) return;
    line("alert", `${d.level} screening alert ${d.event.toLowerCase()}: ${d.title}. Experimental INDRA alert, not an official warning.`, d.level);
    btn.dataset.alert = d.level; setTimeout(() => delete btn.dataset.alert, 20000);
  });
  on("ev:official", (e) => { const n = e.data?.new?.length; if (n) line("official", `${n} new official NDMA SACHET alert${n > 1 ? "s" : ""} received.`); });
  setInterval(() => { if (!con.hidden) watch(); }, 15000);
  const t = document.getElementById("btnVoice");
  if (t) t.title = "Voice command (V) — replies appear in INDRA Core (J)";
}
function watch() {
  const st = S.status || {};
  const feeds = (st.feeds || []).filter((f) => f.state === "LIVE" || f.state === "OBSERVED").length;
  const act = (S.alerts || []).filter((a) => a.status === "ACTIVE").length;
  $("hcWatch").innerHTML = `<span>WATCHING</span> ${feeds} live feeds · ${(S.cells || []).length} storm cells · ${act} INDRA alerts · ${S.official?.active ?? "—"} official · scan #${st.fusion_id ?? "—"}`;
}
function line(who, text, level) {
  const log = $("hcLog");
  if (!log) return;
  const el = document.createElement("div");
  el.className = "hc-line " + who;
  if (level) el.style.setProperty("--lv", LV_COLOR[level] || "var(--cyan)");
  const tm = new Date().toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" });
  el.innerHTML = `<span class="hl-w mono">${who === "user" ? "YOU" : who === "alert" ? "ALERT" : who === "official" ? "OFFICIAL" : "INDRA"} · ${tm}</span><span class="hl-t"></span>`;
  log.appendChild(el);
  const t = el.querySelector(".hl-t");
  if (who === "user" || RM) t.textContent = text;
  else { let i = 0; const iv = setInterval(() => { i += 3; t.textContent = text.slice(0, i); log.scrollTop = log.scrollHeight; if (i >= text.length) clearInterval(iv); }, 14); }
  while (log.children.length > 60) log.firstChild.remove();
  log.scrollTop = log.scrollHeight;
}
function greet() {
  const h = +new Date().toLocaleString("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", hour12: false });
  const name = AUTH.user?.id ? AUTH.user.name.split(" ")[0] : "";
  line("indra", `Good ${h < 12 ? "morning" : h < 17 ? "afternoon" : "evening"}${name ? ", " + name : ""}. INDRA Core is online and watching India's weather feeds. Ask for a briefing, a place, alerts or accuracy.`);
}
async function ask(q) {
  if (busy) return;
  busy = true; line("user", q);
  $("hcore").classList.add("thinking");
  try { await answer(q); } catch (e) { line("indra", "I could not complete that: " + (e.body?.error || e.message)); }
  finally { busy = false; $("hcore").classList.remove("thinking"); }
}
async function answer(q) {
  const t = q.toLowerCase();
  if (/(near me|here|my location|current location|mere paas|yahan)/.test(t)) {
    if (!navigator.geolocation) return say("Location is not available in this browser. Search a place instead.");
    return new Promise((res) => navigator.geolocation.getCurrentPosition(
      (p) => { location.hash = `#/loc/${p.coords.latitude.toFixed(4)},${p.coords.longitude.toFixed(4)},My location`; say("Locking onto your location and opening the weather report."); res(); },
      () => { say("I could not get your location. Allow location access, or tell me a place name."); res(); }, { timeout: 8000 }));
  }
  if (/(alert|warning|danger|khatra|chetavani)/.test(t) && !/(open|show) alert/.test(t)) {
    const act = (S.alerts || []).filter((a) => a.status === "ACTIVE");
    const by = (l) => act.filter((a) => a.level === l).length;
    const top = act.slice().sort((a, b) => (b.score || 0) - (a.score || 0))[0];
    const off = S.official?.active;
    return say(`${act.length} INDRA screening alerts are active: ${by("CRITICAL")} critical, ${by("HIGH")} high, ${by("MEDIUM")} medium. ${off != null ? `${off} official NDMA SACHET alerts are active separately.` : "Official alerts are still loading."}${top ? ` The strongest INDRA alert is ${top.title}.` : ""} Screening alerts are experimental; official warnings take priority.`);
  }
  if (/(accura|trust|how good|reliable|sahi)/.test(t)) {
    const a = S.status?.accuracy || {};
    if (a.status !== "LIVE") return say("I am still collecting ground-station observations. Accuracy scores appear within the first hour.");
    return say(`Checked against ${a.stations} real weather stations over the last ${a.test_window_h} hours: ${Math.round(a.temp_within_2c_pct)} percent of temperatures within 2 degrees, ${Math.round(a.wind_within_10kmh_pct)} percent of winds within 10 kilometres per hour, and rain yes or no correct ${Math.round(a.rain_yes_no_pct)} percent of the time. Rain timing is the weakest part, so watch the live rain map too.`);
  }
  if (/(who are you|what are you|kaun ho|introduce)/.test(t))
    return say("I am INDRA Core, the assistant inside INDRA, India's live severe-weather console. I watch rain, satellite, lightning, ground stations, five weather models and official alerts, and I tell you what matters.");
  if (/(what can you do|help|commands)/.test(t))
    return say("Try: brief me. Weather in Meerut. Weather near me. Any alerts. How accurate are you. Show radar, storms or nowcast. Turn on lightning. Play the loop. Zoom to Kerala. Press J to open me and V to speak.");
  if (/^(time|what time|samay)/.test(t))
    return say("It is " + new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "numeric", minute: "2-digit" }) + " India time.");
  if (/(storm|cells|tufan)/.test(t) && /(how many|kitne|count|near)/.test(t)) {
    const c = S.cells || [], sev = c.filter((x) => ["HIGH", "CRITICAL"].includes(x.severity)).length;
    return say(`${c.length} convective cells are being tracked across the region, ${sev} of them high or critical.`);
  }
  await opts.handleText(q);
}
