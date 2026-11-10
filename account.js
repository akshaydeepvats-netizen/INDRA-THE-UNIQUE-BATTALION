// INDRA accounts: login gate (Public / Guest / Professional), account menu, upgrade, locked-feature prompts, guided tour.
import { AUTH, api, setSession, esc, on, emit, toast, disconnectLive } from "./core.js";

const TIER_LABEL = { guest: "Guest", public: "Public", professional: "Professional" };
export const tierLabel = (t) => TIER_LABEL[t] || "—";

// What each account gets — shown on the gate and in Help.
export const TIER_TABLE = [
  ["Home: plain-language local weather, 12 h forecast, safety tips", 1, 1, 1],
  ["INDRA best estimate (station-scored model blend)", 1, 1, 1],
  ["Nearest ground-station observation (METAR)", 1, 1, 1],
  ["India map, state → district → town → village drill-down, search", 1, 1, 1],
  ["Rain (NASA IMERG), lightning, IR satellite, ground-station layers", 1, 1, 1],
  ["Official NDMA SACHET alerts + INDRA screening alerts", 1, 1, 1],
  ["Live accuracy summary", 1, 1, 1],
  ["Saved places and alerts for your places", 0, 1, 1],
  ["Storm cell tracking, Radar/Sat centre, Himawari layer", 0, 1, 1],
  ["Report observed weather (ground truth)", 0, 1, 1],
  ["Command desk, Nowcast engine 0–6 h, Impact intelligence", 0, 0, 1],
  ["Per-model data (ECMWF, GFS, ICON, UKMO, AIFS) and model charts", 0, 0, 1],
  ["Hazard overlay, IMERG QC grid, advanced satellite products", 0, 0, 1],
  ["Alert acknowledgement, alert log, verification, replay, audit", 0, 0, 1],
  ["Full station accuracy table, CSV exports, API", 0, 0, 1],
];

const tick = (v) => (v ? '<span class="tk-y" aria-label="Included">✓</span>' : '<span class="tk-n" aria-label="Not included">—</span>');
export function tierTableHtml(compact = false) {
  return `<div class="tbl-wrap"><table class="tbl tier-tbl"><thead><tr><th>Feature</th><th>Guest</th><th>Public</th><th>Pro</th></tr></thead><tbody>${TIER_TABLE.filter((r, i) => !compact || i % 2 === 0 || i > 9).map((r) => `<tr><td>${esc(r[0])}</td><td>${tick(r[1])}</td><td>${tick(r[2])}</td><td>${tick(r[3])}</td></tr>`).join("")}</tbody></table></div>`;
}

// ---------------------------------------------------------------- gate
let gateResolve = null;
let gateState = { kind: "public", mode: "signin" };

function field(name, label, type = "text", extra = "") {
  return `<label class="field"><span>${label}</span><input name="${name}" type="${type}" ${extra}></label>`;
}

function mailNote(st) {
  if (st.demo) return `<div class="demo-code"><span>DEMO MODE</span>No mail server is configured, so the code is shown here: <b class="mono">${esc(st.demo)}</b></div>`;
  if (st.mailMode === "outbox") return `<div class="note">This INDRA server has no mail server configured yet. The code is in the server log and in Admin → Email outbox. Ask your administrator.</div>`;
  return `<div class="note">Check your inbox (and spam folder). The email comes from INDRA.</div>`;
}
const otp = (v = "") => `<label class="field otp-field"><span>6-digit code</span><input name="code" class="otp mono" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" required value="${esc(v)}" placeholder="••••••"></label>`;

function gateForm() {
  const { kind, mode } = gateState;
  if (mode === "forgot") return `<form class="gate-form" data-act="forgot"><div class="gate-step"><b>Reset your password</b><span>Enter the email you signed up with. We will send a 6-digit reset code.</span></div>${field("email", "Email", "email", `autocomplete="email" required value="${esc(gateState.email || "")}"`)}<button class="btn" type="submit">Send reset code</button><button type="button" class="linkbtn" data-mode="signin">Back to sign in</button></form>`;
  if (mode === "reset") return `<form class="gate-form" data-act="reset"><div class="gate-step"><b>Choose a new password</b><span>${gateState.sentMsg ? esc(gateState.sentMsg) : "Enter the code from the email."}</span></div>${mailNote(gateState)}${field("email", "Email", "email", `autocomplete="email" required value="${esc(gateState.email || "")}"`)}${otp(gateState.code)}${field("password", "New password (8+ characters, letters and numbers)", "password", 'autocomplete="new-password" minlength="8" required')}<button class="btn" type="submit">Set new password and sign in</button><div class="gate-links"><button type="button" class="linkbtn" data-mode="forgot">Send a new code</button><button type="button" class="linkbtn" data-mode="signin">Back to sign in</button></div></form>`;
  if (mode === "verify") return `<form class="gate-form" data-act="verify"><div class="gate-step"><b>Verify your email</b><span>We sent a 6-digit code to <b>${esc(gateState.sentTo || AUTH.user?.email || "your email")}</b>. Verifying unlocks your ${tierLabel(AUTH.user?.account_tier)} features.</span></div>${mailNote(gateState)}${otp(gateState.code)}<button class="btn" type="submit">Verify email</button><div class="gate-links"><button type="button" class="linkbtn" id="gateResend">Resend code</button><button type="button" class="linkbtn" id="gateLater">Do this later (guest features until verified)</button></div></form>`;
  if (kind === "public") {
    if (mode === "signin") return `<form class="gate-form" data-act="login">${field("email", "Email", "email", 'autocomplete="email" required')}${field("password", "Password", "password", 'autocomplete="current-password" required')}<button class="btn" type="submit">Sign in</button><div class="gate-links"><button type="button" class="linkbtn" data-mode="register">New here? Create a free public account</button><button type="button" class="linkbtn" data-mode="forgot">Forgot password?</button></div></form>`;
    return `<form class="gate-form" data-act="register">${field("name", "Your name", "text", 'autocomplete="name" required')}${field("email", "Email", "email", 'autocomplete="email" required')}${field("password", "Password (8+ characters, letters and numbers)", "password", 'autocomplete="new-password" minlength="8" required')}<button class="btn" type="submit">Create public account</button><button type="button" class="linkbtn" data-mode="signin">Already have an account? Sign in</button></form>`;
  }
  if (mode === "signin") return `<form class="gate-form" data-act="login">${field("email", "Work email", "email", 'autocomplete="email" required')}${field("password", "Password", "password", 'autocomplete="current-password" required')}<button class="btn" type="submit">Sign in to professional console</button><div class="gate-links"><button type="button" class="linkbtn" data-mode="register">Register a professional account</button><button type="button" class="linkbtn" data-mode="forgot">Forgot password?</button></div></form>`;
  return `<form class="gate-form" data-act="register"><div class="grid2">${field("name", "Full name", "text", 'autocomplete="name" required')}${field("email", "Work email", "email", 'autocomplete="email" required')}</div>${field("password", "Password (8+ characters, letters and numbers)", "password", 'autocomplete="new-password" minlength="8" required')}<div class="grid2">${field("org", "Organisation", "text", 'placeholder="e.g. Meerut DDMA" required')}${field("role", "Role", "text", 'placeholder="e.g. Duty officer"')}</div>${field("access_code", "Professional access key", "text", 'placeholder="PRO-XXXX-XXXX-XXXX or shared code" autocomplete="off" required')}<div class="note">Your INDRA administrator gives you a personal key (Admin console → Pro keys) or the shared access code.</div><button class="btn" type="submit">Create professional account</button><button type="button" class="linkbtn" data-mode="signin">Already registered? Sign in</button></form>`;
}

function renderGate() {
  const g = document.getElementById("gate");
  const { kind, mode } = gateState;
  const focusMode = ["verify", "reset", "forgot"].includes(mode);
  g.innerHTML = `<div class="gate-holo" aria-hidden="true"><div class="gh-ring r1"></div><div class="gh-ring r2"></div><div class="gh-ring r3"></div><div class="gh-scan"></div></div><div class="gate-shell glass holo-frame">
    <div class="gate-brand">
      <svg viewBox="0 0 32 32" class="gate-logo" aria-hidden="true"><circle cx="16" cy="16" r="13" class="lg-ring"/><circle cx="16" cy="16" r="9" class="lg-ring2"/><path d="M17 5 10 18h6l-2 9 8-14h-6z" class="lg-bolt"/></svg>
      <div><div class="gate-title">INDRA</div><div class="gate-sub">Severe-weather intelligence for India · live</div></div>
    </div>
    <div class="gate-intro">Choose how you want to use INDRA. Everyone sees real, labelled data — accounts only change how many tools you get.</div>
    <div class="gate-kinds" role="tablist" ${focusMode ? "hidden" : ""}>
      <button class="gate-kind ${kind === "public" ? "active" : ""}" data-kind="public" role="tab" aria-selected="${kind === "public"}">
        <div class="gk-h"><span class="gk-name">Public</span><span class="tier-pill t-public">FREE</span></div>
        <div class="gk-d">For citizens, students and families. Local weather in plain words, rain and lightning maps, official alerts. Guest access available.</div>
      </button>
      <button class="gate-kind ${kind === "professional" ? "active" : ""}" data-kind="professional" role="tab" aria-selected="${kind === "professional"}">
        <div class="gk-h"><span class="gk-name">Professional</span><span class="tier-pill t-professional">ALL FEATURES</span></div>
        <div class="gk-d">For disaster managers, forecasters and researchers. Command desk, nowcast engine, per-model data, verification, exports.</div>
      </button>
    </div>
    <div class="gate-body">
      ${gateForm()}
      ${kind === "public" && !focusMode ? `<div class="gate-or"><span>or</span></div><button class="btn ghost gate-guest" id="gateGuest">Continue as guest</button><div class="note" style="text-align:center">Guest: normal weather features only, no saved places. Session lasts 24 h.</div>` : ""}
      <div class="gate-err" id="gateErr" role="alert" hidden></div>
    </div>
    <details class="gate-compare"><summary>Compare Guest, Public and Professional</summary>${tierTableHtml()}</details>
    <div class="gate-foot">INDRA screening alerts are experimental and are never mixed with official IMD / NDMA warnings.</div>
  </div>`;
  g.querySelectorAll("[data-kind]").forEach((b) => (b.onclick = () => { gateState = { kind: b.dataset.kind, mode: "signin" }; renderGate(); }));
  g.querySelectorAll("[data-mode]").forEach((b) => (b.onclick = () => { gateState.mode = b.dataset.mode; renderGate(); }));
  const gb = document.getElementById("gateGuest");
  if (gb) gb.onclick = () => submit("guest", {});
  const rs = document.getElementById("gateResend");
  if (rs) rs.onclick = () => resendCode(rs);
  const lt = document.getElementById("gateLater");
  if (lt) lt.onclick = () => closeGate();
  g.querySelectorAll(".otp").forEach((i) => (i.oninput = () => { i.value = i.value.replace(/\D/g, "").slice(0, 6); }));
  const f = g.querySelector("form");
  f.onsubmit = (e) => { e.preventDefault(); submit(f.dataset.act, Object.fromEntries(new FormData(f))); };
  setTimeout(() => f.querySelector("input")?.focus(), 30);
}

async function submit(act, data) {
  const err = document.getElementById("gateErr");
  err.hidden = true;
  const btns = document.querySelectorAll("#gate button");
  btns.forEach((b) => (b.disabled = true));
  try {
    if (act === "forgot") {
      const r = await api("/api/auth/forgot", { method: "POST", body: JSON.stringify({ email: data.email }) });
      gateState = { ...gateState, mode: "reset", email: data.email, demo: r.demo_code, code: r.demo_code || "", mailMode: r.email_mode, sentMsg: r.message };
      return renderGate();
    }
    if (act === "reset") {
      const r = await api("/api/auth/reset", { method: "POST", body: JSON.stringify(data) });
      setSession(r.token, r.user, r.features);
      closeGate();
      toast(`<div class="tb"><div class="tt">Password updated</div><div class="ts">You are signed in. Other devices were signed out.</div></div>`);
      return;
    }
    if (act === "verify") {
      const r = await api("/api/auth/verify", { method: "POST", body: JSON.stringify({ code: data.code }) });
      setSession(AUTH.token, r.user, r.features);
      closeGate();
      toast(`<div class="tb"><div class="tt">Email verified</div><div class="ts">Your ${tierLabel(r.user.tier)} features are unlocked.</div></div>`);
      return;
    }
    const r = await api("/api/auth/" + act, { method: "POST", body: JSON.stringify({ ...data, tier: gateState.kind }) });
    setSession(r.token, r.user, r.features);
    if (r.user?.needs_verification) {
      gateState = { ...gateState, mode: "verify", demo: r.demo_code, code: r.demo_code || "", sentTo: r.code_sent_to, mailMode: r.email_mode || r.user.email_mode };
      return renderGate();
    }
    closeGate();
  } catch (e) {
    err.textContent = e.body?.error || e.message || "Could not sign in.";
    err.hidden = false;
  } finally { btns.forEach((b) => (b.disabled = false)); }
}

async function resendCode(btn) {
  const err = document.getElementById("gateErr") || document.getElementById("vErr");
  try {
    btn.disabled = true;
    const r = await api("/api/auth/resend", { method: "POST" });
    gateState = { ...gateState, demo: r.demo_code, code: r.demo_code || "", sentTo: r.code_sent_to, mailMode: r.email_mode };
    if (document.getElementById("gate").hidden) verifyDialog(); else renderGate();
    toast(`<div class="tb"><div class="tt">New code sent</div><div class="ts">to ${esc(r.code_sent_to || "your email")}</div></div>`);
  } catch (e) { if (err) { err.textContent = e.body?.error || e.message; err.hidden = false; } }
  finally { setTimeout(() => (btn.disabled = false), 45000); }
}

export function openGate(opts = {}) {
  if (opts.kind || opts.mode) gateState = { kind: opts.kind || gateState.kind, mode: opts.mode || "signin", email: opts.email, code: opts.code };
  const g = document.getElementById("gate");
  g.hidden = false;
  renderGate();
  return new Promise((res) => (gateResolve = res));
}
function closeGate() {
  const g = document.getElementById("gate");
  g.hidden = true; g.innerHTML = "";
  if (gateResolve) { const r = gateResolve; gateResolve = null; r(AUTH); }
}

// Resolve a valid session before the console starts.
function hashParams() {
  const h = location.hash || "", i = h.indexOf("?");
  return { head: h.replace(/^#\/?/, "").split(/[/?]/)[0], q: new URLSearchParams(i >= 0 ? h.slice(i + 1) : "") };
}
export async function ensureSession() {
  const { head, q } = hashParams();
  if (head === "reset") {
    history.replaceState(null, "", "#/home");
    return openGate({ mode: "reset", email: q.get("email") || "", code: q.get("code") || "" });
  }
  if (head === "verify") { gateState.code = q.get("code") || ""; history.replaceState(null, "", "#/home"); }
  if (AUTH.token) {
    try {
      const r = await api("/api/auth/me");
      setSession(AUTH.token, r.user, r.features);
      AUTH.proRequest = r.pro_request || null;
      if (r.user?.needs_verification && gateState.code) return openGate({ mode: "verify", code: gateState.code });
      return AUTH;
    } catch (e) { if (e.status === 401) setSession("", null, {}); else throw e; }
  }
  return openGate();
}

export async function signOut() {
  try { await api("/api/auth/logout", { method: "POST" }); } catch (_) {}
  disconnectLive();
  setSession("", null, {});
  location.hash = "#/home";
  location.reload();
}

// Session expired mid-use → sign in again, then reload with the fresh token.
let reauthing = false;
on("auth:required", async () => {
  if (reauthing || !document.getElementById("gate").hidden) return;
  reauthing = true;
  setSession("", null, {});
  await openGate();
  location.reload();
});

// ---------------------------------------------------------------- account menu
export function renderAccount() {
  const el = document.getElementById("acct");
  const u = AUTH.user;
  if (!u) { el.hidden = true; return; }
  el.hidden = false;
  const ini = (u.name || "G").split(/\s+/).map((x) => x[0]).join("").slice(0, 2).toUpperCase();
  el.innerHTML = `<button class="acct-btn" id="acctBtn" aria-haspopup="true" aria-expanded="false" title="Account"><span class="acct-av t-${u.tier}">${esc(ini)}</span><span class="tier-pill t-${u.tier}">${tierLabel(u.tier).toUpperCase()}</span></button>
    <div class="acct-menu glass" id="acctMenu" hidden>
      <div class="am-h"><b>${esc(u.name)}</b><span>${esc(u.email || "Guest session · 24 h")}</span>${u.org ? `<span>${esc(u.org)}${u.role ? " · " + esc(u.role) : ""}</span>` : ""}</div>
      <div class="am-tier">Account: <span class="tier-pill t-${u.account_tier || u.tier}">${tierLabel(u.account_tier || u.tier).toUpperCase()}</span>${u.id ? (u.verified ? '<span class="vpill ok">EMAIL VERIFIED</span>' : '<span class="vpill bad">NOT VERIFIED</span>') : ""}${u.is_owner ? '<span class="vpill own">OWNER</span>' : ""}${u.is_admin ? '<span class="vpill adm">ADMIN</span>' : ""}</div>
      ${u.needs_verification ? `<button class="am-item hi" data-a="verify">Verify email to unlock features</button>` : ""}
      ${u.is_admin && !u.needs_verification ? `<button class="am-item hi" data-a="admin">Admin console</button>` : ""}
      ${u.id && !u.needs_verification && (u.account_tier || u.tier) === "public" ? `<button class="am-item" data-a="upgrade">${AUTH.proRequest?.status === "pending" ? "Professional request pending…" : "Get Professional access"}</button>` : ""}
      ${!u.id ? `<button class="am-item" data-a="upgrade">Create an account / unlock more</button>` : ""}
      ${u.id ? `<button class="am-item" data-a="password">Change password</button>` : ""}
      <button class="am-item" data-a="help">Help &amp; guide</button>
      <button class="am-item" data-a="tour">Take the 30-second tour</button>
      <button class="am-item danger" data-a="out">${u.tier === "guest" ? "Leave guest session" : "Sign out"}</button>
    </div>`;
  const btn = document.getElementById("acctBtn"), menu = document.getElementById("acctMenu");
  btn.onclick = (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; btn.setAttribute("aria-expanded", String(!menu.hidden)); };
  document.addEventListener("click", (e) => { if (!e.target.closest("#acct")) menu.hidden = true; });
  menu.onclick = (e) => {
    const a = e.target.closest("[data-a]")?.dataset.a; if (!a) return;
    menu.hidden = true;
    if (a === "upgrade") upgradeDialog();
    if (a === "verify") verifyDialog();
    if (a === "admin") location.hash = "#/admin";
    if (a === "password") passwordDialog();
    if (a === "help") location.hash = "#/help";
    if (a === "tour") startTour(true);
    if (a === "out") signOut();
  };
}

// ---------------------------------------------------------------- locked / upgrade
export function lockedCard(what, need = "professional", detail = "") {
  const t = AUTH.user?.tier;
  if (AUTH.user?.needs_verification && ["public", "professional"].includes(AUTH.user.account_tier) && (need === "public" || AUTH.user.account_tier === "professional"))
    return `<div class="locked-card"><div class="lc-ico" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg></div><div class="lc-t">${esc(what)}</div><div class="lc-d">Your ${tierLabel(AUTH.user.account_tier)} account is ready — verify your email to unlock it. Until then you have guest features.</div><button class="btn sm" onclick="window.__indraVerify()">Verify email</button></div>`;
  return `<div class="locked-card"><div class="lc-ico" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg></div>
    <div class="lc-t">${esc(what)}</div>
    <div class="lc-d">${detail || `Available with a <b>${tierLabel(need)}</b> account.`} You are using a <b>${tierLabel(t)}</b> account.</div>
    <button class="btn sm" onclick="window.__indraUpgrade('${need}')">${t === "guest" ? (need === "public" ? "Create free account" : "See account options") : "Upgrade with access code"}</button></div>`;
}
window.__indraUpgrade = (need) => upgradeDialog(need);
window.__indraVerify = () => verifyDialog();

function closeModal() { const m = document.getElementById("modal"); m.hidden = true; m.innerHTML = ""; }

export function verifyDialog() {
  const m = document.getElementById("modal");
  const st = gateState;
  m.innerHTML = `<div class="modal-box holo-frame"><div class="sec-h">Verify your email</div><div class="note" style="margin-bottom:10px">Enter the 6-digit code sent to <b>${esc(st.sentTo || AUTH.user?.email || "")}</b>. If you don't have it, send a new one.</div>${mailNote(st)}<form id="vForm" style="display:grid;gap:10px;margin-top:10px">${otp(st.code)}<div class="gate-err" id="vErr" hidden></div><div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn" type="submit">Verify</button><button class="btn ghost" type="button" id="vResend">Send new code</button><button class="btn ghost" type="button" id="vCancel">Later</button></div></form></div>`;
  m.hidden = false;
  const f = document.getElementById("vForm");
  f.querySelector(".otp").oninput = (e) => { e.target.value = e.target.value.replace(/\D/g, "").slice(0, 6); };
  document.getElementById("vCancel").onclick = closeModal;
  document.getElementById("vResend").onclick = (e) => resendCode(e.currentTarget);
  f.onsubmit = async (e) => {
    e.preventDefault();
    try {
      const r = await api("/api/auth/verify", { method: "POST", body: JSON.stringify({ code: new FormData(f).get("code") }) });
      setSession(AUTH.token, r.user, r.features);
      closeModal();
      toast(`<div class="tb"><div class="tt">Email verified</div><div class="ts">Unlocking your ${tierLabel(r.user.tier)} features…</div></div>`);
      setTimeout(() => location.reload(), 900);
    } catch (err) { const el = document.getElementById("vErr"); el.textContent = err.body?.error || err.message; el.hidden = false; }
  };
  setTimeout(() => f.querySelector(".otp").focus(), 30);
}

export function passwordDialog() {
  const m = document.getElementById("modal");
  m.innerHTML = `<div class="modal-box holo-frame"><div class="sec-h">Change password</div><form id="pwForm" style="display:grid;gap:8px">${field("old_password", "Current password", "password", 'autocomplete="current-password" required')}${field("new_password", "New password (8+ characters, letters and numbers)", "password", 'autocomplete="new-password" minlength="8" required')}<div class="note">Other devices will be signed out. Forgot the current one? Sign out and use “Forgot password?”.</div><div class="gate-err" id="pwErr" hidden></div><div style="display:flex;gap:8px"><button class="btn" type="submit">Change password</button><button class="btn ghost" type="button" id="pwCancel">Cancel</button></div></form></div>`;
  m.hidden = false;
  document.getElementById("pwCancel").onclick = closeModal;
  const f = document.getElementById("pwForm");
  f.onsubmit = async (e) => {
    e.preventDefault();
    try {
      const r = await api("/api/auth/password", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(f))) });
      closeModal();
      toast(`<div class="tb"><div class="tt">Password changed</div><div class="ts">${esc(r.message)}</div></div>`);
    } catch (err) { const el = document.getElementById("pwErr"); el.textContent = err.body?.error || err.message; el.hidden = false; }
  };
}

// banner shown while an account is waiting for email verification
export function renderVerifyBanner() {
  document.getElementById("vbanner")?.remove();
  const u = AUTH.user;
  if (!u?.needs_verification) return;
  const b = document.createElement("div");
  b.id = "vbanner"; b.className = "vbanner glass";
  b.innerHTML = `<span class="vb-dot"></span><span><b>Verify your email</b> to unlock your ${tierLabel(u.account_tier)} account. Until then INDRA runs with guest features.</span><button class="btn sm">Enter code</button>`;
  b.querySelector("button").onclick = verifyDialog;
  document.querySelector(".stage").appendChild(b);
}

export function upgradeDialog(need) {
  const t = AUTH.user?.tier;
  const m = document.getElementById("modal");
  if (t === "guest") {
    m.innerHTML = `<div class="modal-box"><div class="sec-h">Unlock more of INDRA</div><div class="note" style="margin-bottom:10px">Guest sessions are limited to normal weather features. Create a free Public account for saved places, storm tracking and reporting, or register as a Professional for every tool.</div>${tierTableHtml(true)}<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px"><button class="btn" data-k="public">Create free public account</button><button class="btn ghost" data-k="professional">Professional sign-up</button><button class="btn ghost" data-k="close">Not now</button></div></div>`;
    m.hidden = false;
    m.querySelectorAll("[data-k]").forEach((b) => (b.onclick = async () => {
      m.hidden = true; m.innerHTML = "";
      if (b.dataset.k === "close") return;
      try { await api("/api/auth/logout", { method: "POST" }); } catch (_) {}
      setSession("", null, {});
      await openGate({ kind: b.dataset.k, mode: "register" });
      location.reload();
    }));
    return;
  }
  if (AUTH.user?.needs_verification) return verifyDialog();
  if (t === "professional") return;
  const pr = AUTH.proRequest;
  m.innerHTML = `<div class="modal-box holo-frame"><div class="sec-h">Get Professional access</div><div class="seg" role="tablist"><button class="seg-b active" data-seg="code">I have an access code</button><button class="seg-b" data-seg="req">Request approval</button></div>
    <div data-pane="req" hidden>${pr?.status === "pending" ? `<div class="note box">Your request for <b>${esc(pr.org)}</b> is waiting for an administrator. You will get an email when it is decided.</div><div style="margin-top:10px"><button class="btn ghost" type="button" data-close>Close</button></div>` : `${pr?.status === "rejected" ? '<div class="note box" style="margin-bottom:8px">Your previous request was not approved. You can send a new one.</div>' : ""}<form id="rqForm" style="display:grid;gap:8px"><div class="grid2"><label class="field">Organisation<input name="org" required value="${esc(AUTH.user?.org || "")}" placeholder="e.g. Meerut DDMA"></label><label class="field">Role<input name="role" value="${esc(AUTH.user?.role || "")}" placeholder="e.g. Duty officer"></label></div><label class="field">Why do you need professional tools? (optional)<textarea name="note" rows="3" maxlength="500"></textarea></label><div class="gate-err" id="rqErr" hidden></div><div style="display:flex;gap:8px"><button class="btn" type="submit">Send request</button><button class="btn ghost" type="button" data-close>Cancel</button></div></form>`}</div>
    <div data-pane="code"><div class="note" style="margin-bottom:10px">Professional accounts unlock the Command desk, Nowcast engine, Impact, per-model data, verification, alert acknowledgement, exports and the API. You need a personal key or the access code from your INDRA administrator.</div>
    <form id="upForm" style="display:grid;gap:8px"><div class="grid2"><label class="field">Organisation<input name="org" required value="${esc(AUTH.user?.org || "")}"></label><label class="field">Role<input name="role" value="${esc(AUTH.user?.role || "")}"></label></div><label class="field">Professional access key<input name="access_code" required autocomplete="off" placeholder="PRO-XXXX-XXXX-XXXX or shared code"></label><div class="gate-err" id="upErr" hidden></div><div style="display:flex;gap:8px"><button class="btn" type="submit">Upgrade</button><button class="btn ghost" type="button" id="upCancel">Cancel</button></div></form></div></div>`;
  m.hidden = false;
  document.getElementById("upCancel").onclick = () => { m.hidden = true; m.innerHTML = ""; };
  m.querySelectorAll("[data-close]").forEach((b) => (b.onclick = closeModal));
  m.querySelectorAll("[data-seg]").forEach((b) => (b.onclick = () => {
    m.querySelectorAll("[data-seg]").forEach((x) => x.classList.toggle("active", x === b));
    m.querySelectorAll("[data-pane]").forEach((p) => (p.hidden = p.dataset.pane !== b.dataset.seg));
  }));
  const rq = document.getElementById("rqForm");
  if (rq) rq.onsubmit = async (e) => {
    e.preventDefault();
    try {
      const r = await api("/api/auth/request-pro", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(rq))) });
      AUTH.proRequest = { status: "pending", org: new FormData(rq).get("org") };
      closeModal(); renderAccount();
      toast(`<div class="tb"><div class="tt">Request sent</div><div class="ts">${esc(r.message)}</div></div>`);
    } catch (err) { const el = document.getElementById("rqErr"); el.textContent = err.body?.error || err.message; el.hidden = false; }
  };
  const f = document.getElementById("upForm");
  f.onsubmit = async (e) => {
    e.preventDefault();
    try {
      const r = await api("/api/auth/upgrade", { method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(f))) });
      setSession(AUTH.token, r.user, r.features);
      m.hidden = true; m.innerHTML = "";
      toast(`<div class="tb"><div class="tt">Professional access enabled</div><div class="ts">All INDRA modules are now unlocked.</div></div>`);
      setTimeout(() => location.reload(), 900);
    } catch (err) { const el = document.getElementById("upErr"); el.textContent = err.body?.error || err.message; el.hidden = false; }
  };
}
on("locked", (d) => {
  const t = AUTH.user?.tier;
  if (d?.code === "verify_required" || AUTH.user?.needs_verification) {
    const el = toast(`<div class="tb"><div class="tt">Verify your email first</div><div class="ts">${esc(d?.what || "This feature")} unlocks once your email is verified.</div></div><button class="btn sm" data-u>Verify</button>`, "info", 8000);
    el.querySelector("[data-u]").onclick = () => { el.remove(); verifyDialog(); };
    return;
  }
  const need = d?.required_tier || (["saved_places", "storms", "himawari", "feedback", "radarsat", "place_alerts"].includes(d?.feature) ? "public" : "professional");
  const el = toast(`<div class="tb"><div class="tt">${esc(d?.what || "This feature")} is locked</div><div class="ts">Needs a ${tierLabel(need)} account — you are on ${tierLabel(t)}.</div></div><button class="btn sm" data-u>${t === "guest" ? "Options" : "Upgrade"}</button>`, "info", 8000);
  el.querySelector("[data-u]").onclick = () => { el.remove(); upgradeDialog(need); };
});
addEventListener("unhandledrejection", (e) => { if (e.reason?.locked) { e.preventDefault(); emit("locked", { ...(e.reason.body || {}), what: "This feature" }); } });

// ---------------------------------------------------------------- guided tour
const STEPS = [
  ["#search", "Search any place", "Type a state, district, city, town or village. INDRA zooms there and opens a weather report."],
  ["#rail", "Modules", "Home gives a simple local summary. Locked modules show PRO — they belong to professional accounts."],
  ["#layerBox", "Map layers", "Switch rain, lightning, satellite, ground stations and alerts on or off. Hover a layer for what it means."],
  ["#panel", "Information panel", "Reports, alerts and explanations appear here. Every number has a label: LIVE, OBSERVED, ESTIMATED, EXPERIMENTAL or UNAVAILABLE."],
  ["#liveChip", "Live link", "Green LIVE means INDRA is streaming updates in the background. New alerts pop up by themselves."],
  ["#hcore", "INDRA Core assistant", "Talk or type to INDRA: “brief me”, “weather in Meerut”, “show radar”. It answers out loud and keeps watching alerts in the background."],
  ["#acct", "Your account", "See your account type, verify email, change password, upgrade, open Help or sign out."],
];
export function startTour(force = false) {
  if (!force && localStorage.getItem("indra.toured")) return;
  localStorage.setItem("indra.toured", "1");
  let i = 0;
  const wrap = document.createElement("div");
  wrap.className = "tour"; wrap.innerHTML = `<div class="tour-hole"></div><div class="tour-card glass" role="dialog" aria-live="polite"></div>`;
  document.body.appendChild(wrap);
  const hole = wrap.querySelector(".tour-hole"), card = wrap.querySelector(".tour-card");
  const show = () => {
    let el = null;
    while (i < STEPS.length && !(el = document.querySelector(STEPS[i][0])?.getBoundingClientRect())?.width) i++;
    if (i >= STEPS.length) return end();
    const [, t, d] = STEPS[i];
    const pad = 6;
    Object.assign(hole.style, { left: el.left - pad + "px", top: el.top - pad + "px", width: el.width + pad * 2 + "px", height: el.height + pad * 2 + "px" });
    card.innerHTML = `<div class="tc-step mono">STEP ${i + 1} / ${STEPS.length}</div><div class="tc-t">${t}</div><div class="tc-d">${d}</div><div class="tc-b"><button class="btn ghost sm" data-x>Skip</button><button class="btn sm" data-n>${i === STEPS.length - 1 ? "Done" : "Next"}</button></div>`;
    const cw = Math.min(300, innerWidth - 24);
    let x = el.right + 14, y = el.top;
    if (x + cw > innerWidth - 8) x = Math.max(8, Math.min(innerWidth - cw - 8, el.left));
    if (x === el.left || x < el.right) y = el.bottom + 12 > innerHeight - 170 ? Math.max(8, el.top - 170) : el.bottom + 12;
    Object.assign(card.style, { left: x + "px", top: Math.min(y, innerHeight - 180) + "px", width: cw + "px" });
    card.querySelector("[data-n]").onclick = () => { i++; show(); };
    card.querySelector("[data-x]").onclick = end;
  };
  const end = () => wrap.remove();
  show();
}
