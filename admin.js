// INDRA admin console: users, professional approvals, access code, email outbox, audit.
import { AUTH, api, esc, toast } from "./core.js";
import { tierLabel } from "./account.js";

const tab = { id: "overview", q: "", tier: "", status: "" };
const ago = (t) => {
  if (!t) return "—";
  const s = Date.now() / 1000 - t;
  if (s < 90) return "just now";
  if (s < 5400) return Math.round(s / 60) + " min ago";
  if (s < 172800) return Math.round(s / 3600) + " h ago";
  return Math.round(s / 86400) + " d ago";
};
const when = (t) => (t ? new Date(t * 1000).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—");

function kpi(label, val, sub = "", cls = "") {
  return `<div class="kpi ${cls}"><div class="k">${esc(label)}</div><div class="v">${esc(String(val))}</div>${sub ? `<div class="s">${sub}</div>` : ""}</div>`;
}

export async function admin(body) {
  document.getElementById("panel").classList.add("wide"); document.body.classList.add("panel-wide");
  if (!AUTH.user?.is_admin) {
    body.innerHTML = `<div class="empty">Administrator access required.</div>`;
    return;
  }
  body.innerHTML = `<div class="adm">
    <div class="seg adm-tabs" role="tablist">
      ${[["overview", "Overview"], ["keys", "Pro keys"], ["users", "Users"], ["requests", "Pro requests"], ["outbox", "Email outbox"], ["audit", "Audit"]].map(([id, t]) => `<button class="seg-b ${tab.id === id ? "active" : ""}" data-tab="${id}" role="tab">${t}<b class="seg-n" data-n="${id}" hidden></b></button>`).join("")}
    </div>
    <div id="admBody"><div class="skel" style="height:220px"></div></div>
  </div>`;
  body.querySelectorAll("[data-tab]").forEach((b) => (b.onclick = () => { tab.id = b.dataset.tab; admin(body); }));
  const el = document.getElementById("admBody");
  try {
    if (tab.id === "overview") await overview(el, body);
    else if (tab.id === "users") await users(el, body);
    else if (tab.id === "keys") await keys(el, body);
    else if (tab.id === "requests") await requests(el, body);
    else if (tab.id === "outbox") await outbox(el);
    else await audit(el);
  } catch (e) {
    el.innerHTML = `<div class="empty">Could not load: ${esc(e.body?.error || e.message)}</div>`;
  }
}

async function overview(el, body) {
  const { stats: s, requests: rq } = await api("/api/admin/overview");
  const n = body.querySelector('[data-n="requests"]');
  if (n && s.pending_requests) { n.hidden = false; n.textContent = s.pending_requests; }
  el.innerHTML = `
    <div class="grid4">
      ${kpi("Accounts", s.users, `${s.new_7d} new this week`)}
      ${kpi("Professional", s.professional, `${s.admins} admin${s.admins === 1 ? "" : "s"}`, "hi")}
      ${kpi("Public", s.public, `${s.unverified} unverified`)}
      ${kpi("Online now", s.active_sessions, `${s.guest_sessions} guest sessions`)}
    </div>
    <div class="adm-card holo-frame">
      <div class="sec-h">Shared professional access code</div>
      <div class="code-row"><code class="mono big-code" id="accCode">${esc(s.access_code)}</code>
        <button class="btn sm ghost" id="cpCode">Copy</button>
        ${s.access_code_pinned ? '<span class="note">Pinned by INDRA_PRO_ACCESS_CODE — change it in the server environment.</span>' : '<button class="btn sm" id="rotCode">Generate new code</button>'}</div>
      <div class="note">Anyone with this shared code can create a professional account. For individual people, issue a personal key instead (single-use, can be tied to one email and revoked). <button class="linkbtn" data-go="keys">Issue a personal key →</button></div>
    </div>
    <div class="grid2">
      <div class="adm-card"><div class="sec-h">Email delivery</div>
        <div class="adm-line"><span>Mode</span><b>${s.email_mode === "smtp" ? '<span class="badge b-live">SMTP</span>' : '<span class="badge b-est">OUTBOX ONLY</span>'}</b></div>
        <div class="adm-line"><span>Verification required</span><b>${s.verification_required ? "Yes" : "No"}</b></div>
        <div class="note">${s.email_mode === "smtp" ? "Codes are sent by your mail server. Failures show in Email outbox." : "No mail server is set. Codes are stored in Email outbox and the server log. Set INDRA_SMTP_HOST, INDRA_SMTP_USER, INDRA_SMTP_PASS and INDRA_SMTP_FROM to send real email."}</div>
      </div>
      <div class="adm-card"><div class="sec-h">Administrators</div>
        ${s.owner_email ? `<div class="adm-line"><span>Owner</span><b>${esc(s.owner_email)} <span class="vpill own">OWNER</span></b></div>` : ""}
        <div class="adm-line"><span>Administrators</span><b>${s.admins}</b></div>
        <div class="adm-line"><span>Active personal Pro keys</span><b>${s.keys_active}</b></div>
        <div class="note">${s.admin_emails_env.length ? `Set by INDRA_ADMIN_EMAILS: ${s.admin_emails_env.map(esc).join(", ")}` : "Promote anyone from Users → Actions → Make administrator. Administrators always get every feature."}</div>
        <div class="adm-line"><span>Suspended accounts</span><b>${s.suspended}</b></div>
      </div>
    </div>
    <div class="adm-card"><div class="sec-h">Waiting for approval <span class="badge">${rq.length}</span></div>
      ${rq.length ? rq.slice(0, 4).map(reqRow).join("") + (rq.length > 4 ? `<button class="linkbtn" data-go="requests">See all ${rq.length}</button>` : "") : '<div class="note">No pending professional requests.</div>'}
    </div>`;
  el.querySelector("#cpCode").onclick = () => { navigator.clipboard?.writeText(s.access_code); toast(`<div class="tb"><div class="tt">Access code copied</div></div>`, "info", 2500); };
  const rot = el.querySelector("#rotCode");
  if (rot) rot.onclick = async () => {
    if (!confirm("Generate a new professional access code? The old code stops working for new sign-ups.")) return;
    const r = await api("/api/admin/access-code", { method: "POST" }).catch((e) => toast(`<div class="tb"><div class="tt">${esc(e.body?.error || e.message)}</div></div>`));
    if (r) { el.querySelector("#accCode").textContent = r.access_code; s.access_code = r.access_code; toast(`<div class="tb"><div class="tt">New access code active</div></div>`); }
  };
  el.querySelectorAll("[data-go]").forEach((b) => (b.onclick = () => { tab.id = b.dataset.go; admin(body); }));
  bindReq(el, body);
}

const reqRow = (r) => `<div class="req-row" data-rid="${r.id}">
  <div class="rq-main"><b>${esc(r.name || "—")}</b> <span class="muted">${esc(r.email || "")}</span>${r.verified ? "" : ' <span class="vpill bad">UNVERIFIED</span>'}
  <div class="rq-meta">${esc(r.org)}${r.role ? " · " + esc(r.role) : ""} · ${ago(r.created_at)}</div>${r.note ? `<div class="rq-note">“${esc(r.note)}”</div>` : ""}</div>
  ${r.status === "pending" ? `<div class="rq-act"><button class="btn sm" data-dec="approve">Approve</button><button class="btn sm ghost" data-dec="reject">Reject</button></div>` : `<span class="badge">${esc(r.status.toUpperCase())}</span>`}
</div>`;

function bindReq(el, body) {
  el.querySelectorAll("[data-dec]").forEach((b) => (b.onclick = async () => {
    const rid = b.closest("[data-rid]").dataset.rid;
    try {
      await api(`/api/admin/requests/${rid}`, { method: "POST", body: JSON.stringify({ decision: b.dataset.dec }) });
      toast(`<div class="tb"><div class="tt">Request ${b.dataset.dec === "approve" ? "approved" : "rejected"}</div><div class="ts">The user was emailed.</div></div>`);
      admin(body);
    } catch (e) { toast(`<div class="tb"><div class="tt">${esc(e.body?.error || e.message)}</div></div>`); }
  }));
}

async function requests(el, body) {
  const st = tab.rqStatus || "pending";
  const { requests: rq } = await api(`/api/admin/requests?status=${st}`);
  el.innerHTML = `<div class="adm-filters"><select id="rqSt" aria-label="Request status">${["pending", "approved", "rejected", "all"].map((x) => `<option ${x === st ? "selected" : ""} value="${x}">${x[0].toUpperCase() + x.slice(1)}</option>`).join("")}</select><span class="note">${rq.length} request${rq.length === 1 ? "" : "s"}</span></div>
    <div class="adm-card">${rq.length ? rq.map(reqRow).join("") : '<div class="note">Nothing here.</div>'}</div>`;
  el.querySelector("#rqSt").onchange = (e) => { tab.rqStatus = e.target.value; admin(body); };
  bindReq(el, body);
}

const ACTIONS = (u, self) => (u.is_owner && !self ? [["verify", "Mark email verified"]].filter(() => !u.verified) : [
  u.tier !== "professional" && ["set_tier:professional", "Make Professional"],
  u.tier === "professional" && !self && ["set_tier:public", "Change to Public"],
  !u.verified && ["verify", "Mark email verified"],
  !u.verified && ["resend_verify", "Resend verification code"],
  ["send_reset", "Send password reset code"],
  !u.is_admin && ["make_admin", "Make administrator (all features)"],
  u.is_admin && !self && ["remove_admin", "Remove administrator"],
  u.sessions > 0 && ["revoke_sessions", "Sign out everywhere"],
  !self && (u.disabled ? ["enable", "Re-activate account"] : ["disable", "Suspend account"]),
  !self && ["delete", "Delete account"],
].filter(Boolean));

async function users(el, body) {
  const qs = new URLSearchParams({ q: tab.q, tier: tab.tier, status: tab.status, limit: 200 });
  const r = await api("/api/admin/users?" + qs);
  el.innerHTML = `<div class="adm-filters">
      <input id="uq" type="search" placeholder="Search name, email or organisation" value="${esc(tab.q)}" aria-label="Search users">
      <select id="ut" aria-label="Tier"><option value="">All tiers</option><option value="professional" ${tab.tier === "professional" ? "selected" : ""}>Professional</option><option value="public" ${tab.tier === "public" ? "selected" : ""}>Public</option></select>
      <select id="us" aria-label="Status"><option value="">Any status</option>${[["unverified", "Unverified"], ["suspended", "Suspended"], ["admin", "Admins"]].map(([v, t]) => `<option value="${v}" ${tab.status === v ? "selected" : ""}>${t}</option>`).join("")}</select>
      <span class="note">${r.total} account${r.total === 1 ? "" : "s"}</span>
      <button class="btn sm" id="uAdd">+ Add user</button>
    </div>
    <form class="adm-card holo-frame adm-form" id="uForm" hidden>
      <div class="sec-h">Create an account</div>
      <div class="adm-grid">
        <label class="field"><span>Full name</span><input name="name" required minlength="2" autocomplete="off"></label>
        <label class="field"><span>Email</span><input name="email" type="email" required autocomplete="off"></label>
        <label class="field"><span>Account type</span><select name="tier"><option value="professional">Professional (all features)</option><option value="public">Public</option></select></label>
        <label class="field"><span>Organisation</span><input name="org" autocomplete="off"></label>
        <label class="field"><span>Role</span><input name="role" autocomplete="off"></label>
        <label class="field"><span>Password (blank = generate)</span><input name="password" type="text" autocomplete="off" placeholder="auto-generated"></label>
      </div>
      <label class="chk"><input type="checkbox" name="admin"> Make this person an administrator (manages users and keys, gets every feature)</label>
      <label class="chk"><input type="checkbox" name="send" checked> Email the sign-in details to them</label>
      <div class="gate-err" id="uErr" hidden></div>
      <div class="adm-out" id="uOut" hidden></div>
      <div style="display:flex;gap:8px"><button class="btn" type="submit">Create account</button><button class="btn ghost" type="button" id="uCancel">Cancel</button></div>
    </form>
    <div class="user-list">${r.users.map((u) => {
      const self = u.id === AUTH.user.id;
      const ini = (u.name || "?").split(/\s+/).map((x) => x[0]).join("").slice(0, 2).toUpperCase();
      return `<div class="user-row ${u.disabled ? "off" : ""}" data-uid="${u.id}">
        <span class="acct-av t-${u.tier}">${esc(ini)}</span>
        <div class="ur-main"><div><b>${esc(u.name)}</b>${self ? ' <span class="muted">(you)</span>' : ""} <span class="tier-pill t-${u.tier}">${tierLabel(u.tier).toUpperCase()}</span>${u.is_owner ? '<span class="vpill own">OWNER</span>' : ""}${u.is_admin ? '<span class="vpill adm">ADMIN</span>' : ""}${u.verified ? "" : '<span class="vpill bad">UNVERIFIED</span>'}${u.disabled ? '<span class="vpill bad">SUSPENDED</span>' : ""}</div>
          <div class="ur-meta">${esc(u.email)}${u.org ? " · " + esc(u.org) : ""}${u.role ? " · " + esc(u.role) : ""}</div>
          <div class="ur-meta mono">joined ${when(u.created_at)} · last sign-in ${ago(u.last_login)} · ${u.sessions} session${u.sessions === 1 ? "" : "s"} · ${u.places} place${u.places === 1 ? "" : "s"}</div></div>
        <select class="ur-act" aria-label="Actions for ${esc(u.email)}"><option value="">Actions…</option>${ACTIONS(u, self).map(([v, t]) => `<option value="${v}">${t}</option>`).join("")}</select>
      </div>`;
    }).join("") || '<div class="empty">No accounts match.</div>'}</div>`;
  const reload = () => users(el, body);
  let t;
  el.querySelector("#uq").oninput = (e) => { clearTimeout(t); t = setTimeout(() => { tab.q = e.target.value.trim(); reload(); }, 300); };
  el.querySelector("#ut").onchange = (e) => { tab.tier = e.target.value; reload(); };
  el.querySelector("#us").onchange = (e) => { tab.status = e.target.value; reload(); };
  const f = el.querySelector("#uForm");
  el.querySelector("#uAdd").onclick = () => { f.hidden = false; f.querySelector("[name=name]").focus(); };
  el.querySelector("#uCancel").onclick = () => { f.hidden = true; };
  f.querySelector("[name=admin]").onchange = (e) => { if (e.target.checked) f.querySelector("[name=tier]").value = "professional"; };
  f.onsubmit = async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(f));
    d.admin = !!f.querySelector("[name=admin]").checked; d.send = !!f.querySelector("[name=send]").checked;
    const err = f.querySelector("#uErr"); err.hidden = true;
    try {
      const r = await api("/api/admin/users", { method: "POST", body: JSON.stringify(d) });
      const out = f.querySelector("#uOut");
      out.hidden = false;
      out.innerHTML = `<b>${esc(r.user.email)}</b> created as ${r.user.is_admin ? "administrator" : tierLabel(r.user.tier)}.${r.temp_password ? ` Temporary password: <code class="mono big-code sm">${esc(r.temp_password)}</code> <button class="btn sm ghost" type="button" id="cpPw">Copy</button> — shown once; ask them to change it.` : ""}`;
      const cp = out.querySelector("#cpPw"); if (cp) cp.onclick = () => navigator.clipboard?.writeText(r.temp_password);
      f.querySelectorAll("input:not([type=checkbox])").forEach((i) => (i.value = ""));
      toast(`<div class="tb"><div class="tt">Account created</div><div class="ts">${esc(r.user.email)}</div></div>`);
      setTimeout(() => users(el, body).then(() => { const nf = el.querySelector("#uForm"); nf.hidden = false; const o = nf.querySelector("#uOut"); o.hidden = false; o.innerHTML = out.innerHTML; const c2 = o.querySelector("#cpPw"); if (c2) c2.onclick = () => navigator.clipboard?.writeText(r.temp_password); }), 50);
    } catch (x) { err.hidden = false; err.textContent = x.body?.error || x.message; }
  };
  el.querySelectorAll(".ur-act").forEach((s) => (s.onchange = async () => {
    const [action, value] = s.value.split(":");
    const uid = s.closest("[data-uid]").dataset.uid;
    const label = s.selectedOptions[0].textContent;
    s.value = "";
    if (!action) return;
    if (["delete", "disable", "set_tier", "remove_admin", "make_admin"].includes(action) && !confirm(`${label} for this user?`)) return;
    try {
      const r = await api(`/api/admin/users/${uid}`, { method: "POST", body: JSON.stringify({ action, value }) });
      toast(`<div class="tb"><div class="tt">${esc(label)} — done</div>${r.demo_code ? `<div class="ts">Demo mode code: <b class="mono">${esc(r.demo_code)}</b></div>` : r.email_mode === "outbox" ? '<div class="ts">Code stored in Email outbox (no mail server).</div>' : ""}</div>`);
      reload();
    } catch (e) { toast(`<div class="tb"><div class="tt">${esc(e.body?.error || e.message)}</div></div>`); }
  }));
}

async function outbox(el) {
  const r = await api("/api/admin/outbox");
  el.innerHTML = `<div class="note box">${r.mode === "smtp" ? "Messages sent through your SMTP server, newest first." : "No mail server configured — these messages were not delivered. Read the code here and pass it on, or configure SMTP."}</div>
    <div class="adm-card">${r.messages.map((m) => `<details class="mail-row"><summary><span class="badge ${m.status === "sent" ? "b-live" : m.status === "failed" ? "b-unavail" : "b-est"}">${esc(m.status.toUpperCase())}</span><b>${esc(m.subject)}</b><span class="muted">${esc(m.to_addr)} · ${ago(m.created_at)}</span></summary><pre class="mono">${esc(m.body)}${m.error ? "\n\nERROR: " + esc(m.error) : ""}</pre></details>`).join("") || '<div class="note">No messages yet.</div>'}</div>`;
}

async function audit(el) {
  const r = await api("/api/admin/audit");
  el.innerHTML = `<div class="adm-card"><div class="tbl-wrap"><table class="tbl"><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Target</th></tr></thead><tbody>${r.events.map((e) => `<tr><td class="mono">${when(e.at)}</td><td>${esc(e.actor || "")}</td><td><span class="badge">${esc(e.action.replace(/^ADMIN_/, ""))}</span></td><td class="mono">${esc(e.target || "")}</td></tr>`).join("") || '<tr><td colspan="4">No account events yet.</td></tr>'}</tbody></table></div></div>`;
}

async function keys(el, body) {
  const r = await api("/api/admin/keys");
  const st = { active: "b-live", used: "b-est", expired: "b-unavail", revoked: "b-unavail" };
  el.innerHTML = `
    <form class="adm-card holo-frame adm-form" id="kForm">
      <div class="sec-h">Issue a professional key</div>
      <div class="note" style="margin-bottom:8px">Give this key to a person. They choose Professional on the sign-in screen, create their account and enter the key. Keys can be tied to one email, limited in uses, expire, and be revoked any time.</div>
      <div class="adm-grid">
        <label class="field"><span>For (name or team)</span><input name="label" placeholder="e.g. Meerut DDMA control room" autocomplete="off"></label>
        <label class="field"><span>Lock to email (optional)</span><input name="email" type="email" placeholder="anyone with the key" autocomplete="off"></label>
        <label class="field"><span>Uses</span><select name="max_uses"><option value="1">1 person</option><option value="5">5 people</option><option value="25">25 people</option><option value="0">Unlimited</option></select></label>
        <label class="field"><span>Valid for</span><select name="days"><option value="7">7 days</option><option value="30" selected>30 days</option><option value="90">90 days</option><option value="365">1 year</option><option value="0">No expiry</option></select></label>
      </div>
      <label class="chk"><input type="checkbox" name="send"> Email the key to the address above</label>
      <div class="gate-err" id="kErr" hidden></div>
      <div class="adm-out" id="kOut" hidden></div>
      <button class="btn" type="submit">Generate key</button>
    </form>
    <div class="adm-card"><div class="sec-h">Issued keys <span class="badge">${r.keys.length}</span></div>
      ${r.keys.length ? r.keys.map((k) => `<div class="key-row ${k.status !== "active" ? "off" : ""}" data-kid="${k.id}">
        <div class="kr-main"><code class="mono kr-code">${esc(k.code)}</code> <span class="badge ${st[k.status]}">${k.status.toUpperCase()}</span>
          <div class="ur-meta">${esc(k.label || "—")}${k.email ? " · for " + esc(k.email) : " · any email"} · used ${k.uses}/${k.max_uses || "∞"} · ${k.expires_at ? "expires " + when(k.expires_at) : "no expiry"}</div>
          ${k.used_by.length ? `<div class="ur-meta mono">used by ${k.used_by.map(esc).join(", ")}</div>` : ""}</div>
        <div class="rq-act"><button class="btn sm ghost" data-cp="${esc(k.code)}">Copy</button>${k.status === "active" ? '<button class="btn sm ghost" data-rv>Revoke</button>' : ""}</div>
      </div>`).join("") : '<div class="note">No personal keys yet. Generate one above.</div>'}
    </div>
    <div class="adm-card"><div class="sec-h">Shared code</div><div class="note">The shared code <code class="mono">${esc(r.shared_code)}</code> also works for anyone. Rotate it from Overview if it leaks.</div></div>`;
  const f = el.querySelector("#kForm");
  f.onsubmit = async (e) => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(f));
    d.send = !!f.querySelector("[name=send]").checked;
    const err = f.querySelector("#kErr"); err.hidden = true;
    if (d.send && !d.email) { err.hidden = false; err.textContent = "Enter an email to send the key to."; return; }
    try {
      const x = await api("/api/admin/keys", { method: "POST", body: JSON.stringify(d) });
      await keys(el, body);
      const out = el.querySelector("#kOut");
      out.hidden = false;
      out.innerHTML = `New key: <code class="mono big-code">${esc(x.key.code)}</code> <button class="btn sm" type="button" id="kCp">Copy</button>${x.sent_to ? ` <span class="note">Emailed to ${esc(x.sent_to)}${AUTH.user?.email_mode === "outbox" ? " (stored in Email outbox — no mail server)" : ""}.</span>` : ""}`;
      out.querySelector("#kCp").onclick = () => { navigator.clipboard?.writeText(x.key.code); toast(`<div class="tb"><div class="tt">Key copied</div></div>`, "info", 2000); };
    } catch (x) { err.hidden = false; err.textContent = x.body?.error || x.message; }
  };
  el.querySelectorAll("[data-cp]").forEach((b) => (b.onclick = () => { navigator.clipboard?.writeText(b.dataset.cp); toast(`<div class="tb"><div class="tt">Key copied</div></div>`, "info", 2000); }));
  el.querySelectorAll("[data-rv]").forEach((b) => (b.onclick = async () => {
    if (!confirm("Revoke this key? It stops working immediately; accounts already created keep their access.")) return;
    await api(`/api/admin/keys/${b.closest("[data-kid]").dataset.kid}/revoke`, { method: "POST" }).catch(() => {});
    keys(el, body);
  }));
}
