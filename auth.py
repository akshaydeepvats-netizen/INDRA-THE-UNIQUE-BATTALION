"""Accounts, sessions and feature tiers.

Tiers
-----
guest         Public access without an account (session only, nothing saved).
public        Free registered account: everything a guest gets plus saved places,
              place alerts and storm/satellite views.
professional  Full console: nowcasting engine, impact, verification, system/API, exports,
              alert acknowledgement, raw per-model data, QC layers, replay, audit.

Professional sign-up needs the organisation access code (env INDRA_PRO_ACCESS_CODE). If it
is not set, a random code is generated on first start, written to the runtime folder and
printed in the server log, so a deployment is never left with a guessable default.
"""
import hashlib
import secrets
import threading
import time
from functools import wraps

from flask import g, jsonify, request
from werkzeug.security import check_password_hash, generate_password_hash

from . import config, mailer
from .store import db

TIERS = ("guest", "public", "professional")
RANK = {t: i for i, t in enumerate(TIERS)}

# feature -> minimum tier
FEATURES = {
    # normal weather features
    "home": "guest", "weather": "guest", "atlas": "guest", "search": "guest", "official_alerts": "guest",
    "screening_alerts": "guest", "rain_map": "guest", "lightning": "guest", "satellite_ir": "guest",
    "best_estimate": "guest", "accuracy_summary": "guest", "stations": "guest", "help": "guest",
    # some advanced features (free account)
    "saved_places": "public", "place_alerts": "public", "storms": "public", "storms_map": "guest", "radarsat": "public",
    "himawari": "public", "nowcast_point": "public", "district_report": "guest", "feedback": "public",
    # professional only
    "command": "professional", "nowcast": "professional", "impact": "professional", "verify": "professional",
    "system": "professional", "exports": "professional", "ack": "professional", "model_raw": "professional",
    "qc_layers": "professional", "sat_products": "professional", "hazard_overlay": "professional",
    "replay": "professional", "audit": "professional", "station_table": "professional", "api_docs": "professional",
}
SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE, name TEXT, pw_hash TEXT, tier TEXT,
  org TEXT, role TEXT, created_at REAL, last_login REAL);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id INTEGER, tier TEXT, name TEXT, created_at REAL, expires_at REAL, last_seen REAL);
CREATE INDEX IF NOT EXISTS ix_sess_exp ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS saved_places (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, name TEXT, lat REAL, lon REAL, district_id INTEGER,
  notify INTEGER DEFAULT 1, created_at REAL);
CREATE INDEX IF NOT EXISTS ix_sp_user ON saved_places(user_id);
CREATE TABLE IF NOT EXISTS auth_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, purpose TEXT, code_hash TEXT, expires_at REAL,
  attempts INTEGER DEFAULT 0, created_at REAL);
CREATE INDEX IF NOT EXISTS ix_codes_user ON auth_codes(user_id, purpose);
CREATE TABLE IF NOT EXISTS pro_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, org TEXT, role TEXT, note TEXT, status TEXT,
  created_at REAL, decided_at REAL, decided_by TEXT);
CREATE TABLE IF NOT EXISTS pro_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT UNIQUE, label TEXT, email TEXT, max_uses INTEGER DEFAULT 1,
  uses INTEGER DEFAULT 0, expires_at REAL, revoked INTEGER DEFAULT 0, created_by TEXT, created_at REAL,
  last_used_at REAL, used_by TEXT);
"""
_MIGRATIONS = ("ALTER TABLE users ADD COLUMN verified INTEGER DEFAULT 0",
               "ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0",
               "ALTER TABLE users ADD COLUMN disabled INTEGER DEFAULT 0",
               "ALTER TABLE users ADD COLUMN verified_at REAL",
               "ALTER TABLE users ADD COLUMN is_owner INTEGER DEFAULT 0")
CODE_TTL = {"verify": 24 * 3600, "reset": 15 * 60}
CODE_MAX_ATTEMPTS = 5
SESSION_DAYS = {"guest": 1, "public": 30, "professional": 7}
_rl = {}
_rl_lock = threading.Lock()
_PRO_CODE = None


def init():
    with db() as con:
        con.executescript(SCHEMA)
        for m in _MIGRATIONS:
            try:
                con.execute(m)
            except Exception:
                pass  # column already exists
        if config.ADMIN_EMAILS:
            con.execute("UPDATE users SET is_admin=1 WHERE email IN (%s)" % ",".join("?" * len(config.ADMIN_EMAILS)),
                        tuple(config.ADMIN_EMAILS))
        con.execute("UPDATE users SET tier='professional', verified=1 WHERE is_admin=1 AND (tier!='professional' OR verified=0)")
    mailer.init()
    pro_code()
    ensure_owner()


def _gen_password():
    alpha = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789"
    return "-".join("".join(secrets.choice(alpha) for _ in range(4)) for _ in range(4)) + "!"


def ensure_owner():
    """Create / repair the built-in owner administrator (INDRA_OWNER_EMAIL).

    The owner is a verified professional administrator that other admins cannot demote,
    suspend or delete. Password comes from INDRA_OWNER_PASSWORD; if unset, one is generated once,
    printed in the server log and saved to data/runtime/owner_credentials.txt."""
    email = (config.OWNER_EMAIL or "").strip().lower()
    if not email or not _valid_email(email):
        return None
    now = time.time()
    with db() as con:
        u = con.execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
        if u:
            con.execute("UPDATE users SET is_owner=1, is_admin=1, tier='professional', verified=1, disabled=0, "
                        "verified_at=COALESCE(verified_at, ?) WHERE id=?", (now, u["id"]))
            if config.OWNER_PASSWORD and not check_password_hash(u["pw_hash"], config.OWNER_PASSWORD):
                con.execute("UPDATE users SET pw_hash=? WHERE id=?", (generate_password_hash(config.OWNER_PASSWORD), u["id"]))
            print(f"\n  [INDRA] Owner admin ready: {email}  (sign in as Professional"
                  + ("; password from INDRA_OWNER_PASSWORD / .env)" if config.OWNER_PASSWORD else ")") + "\n", flush=True)
            return u["id"]
        pw = config.OWNER_PASSWORD or _gen_password()
        cur = con.execute("INSERT INTO users(email,name,pw_hash,tier,org,role,created_at,last_login,verified,verified_at,is_admin,is_owner,disabled) "
                          "VALUES(?,?,?,'professional',?,?,?,NULL,1,?,1,1,0)",
                          (email, config.OWNER_NAME or "INDRA Owner", generate_password_hash(pw), config.OWNER_ORG or "INDRA",
                           "Owner / Administrator", now, now))
    if config.OWNER_PASSWORD:
        print(f"\n  [INDRA] Owner admin created: {email}  (sign in as Professional; password from INDRA_OWNER_PASSWORD / .env)\n", flush=True)
    else:
        f = config.RUNTIME_DIR / "owner_credentials.txt"
        f.write_text(f"email: {email}\npassword: {pw}\n", encoding="utf-8")
        print(f"\n  [INDRA] Owner admin created: {email}  password: {pw}\n"
              f"          (saved to {f}; change it from the account menu after signing in)\n", flush=True)
    return cur.lastrowid


def pro_code():
    global _PRO_CODE
    if _PRO_CODE:
        return _PRO_CODE
    env = (config.PRO_ACCESS_CODE or "").strip()
    if env:
        _PRO_CODE = env
        return _PRO_CODE
    f = config.RUNTIME_DIR / "pro_access_code.txt"
    if f.exists() and f.read_text(encoding="utf-8").strip():
        _PRO_CODE = f.read_text(encoding="utf-8").strip()
    else:
        _PRO_CODE = "INDRA-" + secrets.token_hex(3).upper() + "-" + secrets.token_hex(3).upper()
        f.write_text(_PRO_CODE, encoding="utf-8")
    print(f"\n  [INDRA] Professional access code: {_PRO_CODE}  (set INDRA_PRO_ACCESS_CODE to choose your own)\n", flush=True)
    return _PRO_CODE


def rotate_code():
    """New random professional access code (only when not pinned by INDRA_PRO_ACCESS_CODE)."""
    global _PRO_CODE
    if (config.PRO_ACCESS_CODE or "").strip():
        return None, "The access code is pinned by the INDRA_PRO_ACCESS_CODE environment variable. Change it there."
    _PRO_CODE = "INDRA-" + secrets.token_hex(3).upper() + "-" + secrets.token_hex(3).upper()
    (config.RUNTIME_DIR / "pro_access_code.txt").write_text(_PRO_CODE, encoding="utf-8")
    return _PRO_CODE, None


def _hash(tok):
    return hashlib.sha256(tok.encode()).hexdigest()


def allowed(tier, feature):
    need = FEATURES.get(feature, "professional")
    return RANK.get(tier, -1) >= RANK[need]


def feature_map(tier):
    return {f: allowed(tier, f) for f in FEATURES}


def _limit(key, n=8, window=600):
    n = n * config.AUTH_RATE_MULT
    now = time.time()
    with _rl_lock:
        hits = [t for t in _rl.get(key, []) if now - t < window]
        if len(hits) >= n:
            _rl[key] = hits
            return False
        hits.append(now)
        _rl[key] = hits
        if len(_rl) > 5000:
            _rl.clear()
        return True


def _issue(user_id, tier, name):
    tok = secrets.token_urlsafe(32)
    now = time.time()
    with db() as con:
        con.execute("INSERT INTO sessions(token_hash,user_id,tier,name,created_at,expires_at,last_seen) VALUES(?,?,?,?,?,?,?)",
                    (_hash(tok), user_id, tier, name, now, now + SESSION_DAYS[tier] * 86400, now))
        con.execute("DELETE FROM sessions WHERE expires_at < ?", (now,))
    return tok


def _effective(u):
    """Tier the user actually gets right now (unverified accounts only get guest features)."""
    if u["is_admin"] and not u["disabled"]:
        return "professional"   # administrators always get every feature
    if config.REQUIRE_EMAIL_VERIFY and not u["verified"]:
        return "guest"
    return u["tier"]


def _user_public(u, tier=None):
    if not u:
        return {"id": None, "name": "Guest", "email": None, "tier": "guest", "account_tier": "guest", "org": None,
                "role": None, "verified": None, "is_admin": False, "email_mode": mailer.mode()}
    return {"id": u["id"], "name": u["name"], "email": u["email"], "tier": tier or _effective(u), "account_tier": u["tier"],
            "org": u["org"], "role": u["role"], "verified": bool(u["verified"]), "is_admin": bool(u["is_admin"]),
            "is_owner": bool(u["is_owner"]),
            "needs_verification": bool(config.REQUIRE_EMAIL_VERIFY and not u["verified"] and not u["is_admin"]), "email_mode": mailer.mode()}


def _valid_email(e):
    return 3 < len(e) <= 160 and "@" in e and "." in e.split("@")[-1] and " " not in e


def register(data, ip):
    email = (data.get("email") or "").strip().lower()
    name = (data.get("name") or "").strip()[:80]
    pw = data.get("password") or ""
    tier = data.get("tier") or "public"
    if tier not in ("public", "professional"):
        return None, "Choose a public or professional account."
    if not _limit("reg:" + ip, 6, 3600):
        return None, "Too many sign-ups from this network. Try again later."
    if not _valid_email(email):
        return None, "Enter a valid email address."
    if len(name) < 2:
        return None, "Enter your name."
    if len(pw) < 8 or pw.isdigit() or pw.isalpha():
        return None, "Password must be at least 8 characters and mix letters with numbers or symbols."
    org = role = None
    if tier == "professional":
        org = (data.get("org") or "").strip()[:120]
        role = (data.get("role") or "").strip()[:80]
        if len(org) < 2:
            return None, "Organisation is required for a professional account."
        key, kerr = _check_key(data.get("access_code"), email)
        if kerr:
            return None, kerr
    now = time.time()
    with db() as con:
        if con.execute("SELECT 1 FROM users WHERE email=?", (email,)).fetchone():
            return None, "An account with this email already exists. Sign in instead."
        admin = email in config.ADMIN_EMAILS
        if not admin and not config.ADMIN_EMAILS and tier == "professional":
            # bootstrap: the first professional account becomes the administrator
            admin = not con.execute("SELECT 1 FROM users WHERE is_admin=1").fetchone()
        verified = 0 if config.REQUIRE_EMAIL_VERIFY else 1
        cur = con.execute("INSERT INTO users(email,name,pw_hash,tier,org,role,created_at,last_login,verified,is_admin,disabled) "
                          "VALUES(?,?,?,?,?,?,?,?,?,?,0)",
                          (email, name, generate_password_hash(pw), tier, org, role, now, now, verified, 1 if admin else 0))
        uid = cur.lastrowid
        if tier == "professional":
            _consume_key(con, key, email)
        u = con.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
    out = {"token": _issue(uid, tier, name), "user": _user_public(u)}
    if config.REQUIRE_EMAIL_VERIFY:
        out.update(_send_code(u, "verify"))
    return out, None


def login(data, ip):
    email = (data.get("email") or "").strip().lower()
    pw = data.get("password") or ""
    want = data.get("tier")
    if not _limit("login:" + ip + ":" + email, 8, 600):
        return None, "Too many attempts. Wait 10 minutes and try again."
    with db() as con:
        u = con.execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
        if not u or not check_password_hash(u["pw_hash"], pw):
            return None, "Email or password is incorrect."
        if u["disabled"]:
            return None, "This account is suspended. Contact your INDRA administrator."
        if want == "professional" and u["tier"] != "professional":
            return None, "This is a public account. Use Public sign-in, or upgrade with an access code after signing in."
        con.execute("UPDATE users SET last_login=? WHERE id=?", (time.time(), u["id"]))
    tier = u["tier"]
    return {"token": _issue(u["id"], tier, u["name"]), "user": _user_public(u)}, None


# ------------------------------------------------------------------ email codes
def _send_code(u, purpose):
    """Create a 6-digit code, email it, and return {email_mode, demo_code?}."""
    code = f"{secrets.randbelow(10**6):06d}"
    now = time.time()
    with db() as con:
        con.execute("DELETE FROM auth_codes WHERE user_id=? AND purpose=?", (u["id"], purpose))
        con.execute("INSERT INTO auth_codes(user_id,purpose,code_hash,expires_at,attempts,created_at) VALUES(?,?,?,?,0,?)",
                    (u["id"], purpose, _hash(f"{u['id']}:{purpose}:{code}"), now + CODE_TTL[purpose], now))
    link = ""
    if config.PUBLIC_URL:
        from urllib.parse import quote
        link = f"\n\nOr open: {config.PUBLIC_URL}/#/{'verify' if purpose == 'verify' else 'reset'}?email={quote(u['email'])}&code={code}"
    if purpose == "verify":
        subj = f"INDRA: your verification code {code}"
        body = (f"Hello {u['name']},\n\nYour INDRA email verification code is: {code}\n"
                f"It is valid for 24 hours.{link}\n\nIf you did not create an INDRA account, ignore this email.")
    else:
        subj = f"INDRA: password reset code {code}"
        body = (f"Hello {u['name']},\n\nYour INDRA password reset code is: {code}\n"
                f"It is valid for 15 minutes.{link}\n\nIf you did not ask to reset your password, ignore this email; "
                f"your password stays the same.")
    m = mailer.send(u["email"], subj, body, purpose)
    out = {"email_mode": m, "code_sent_to": _mask(u["email"])}
    if m == "outbox" and config.EMAIL_DEMO_ECHO:
        out["demo_code"] = code
    return out


def _mask(e):
    name, _, dom = e.partition("@")
    return (name[:2] + "•" * max(1, len(name) - 2)) + "@" + dom


def _check_code(uid, purpose, code):
    code = (code or "").strip()
    now = time.time()
    with db() as con:
        r = con.execute("SELECT * FROM auth_codes WHERE user_id=? AND purpose=? ORDER BY id DESC LIMIT 1", (uid, purpose)).fetchone()
        if not r or r["expires_at"] < now:
            return "This code has expired. Ask for a new one."
        if r["attempts"] >= CODE_MAX_ATTEMPTS:
            return "Too many wrong codes. Ask for a new one."
        if not secrets.compare_digest(r["code_hash"], _hash(f"{uid}:{purpose}:{code}")):
            con.execute("UPDATE auth_codes SET attempts=attempts+1 WHERE id=?", (r["id"],))
            left = CODE_MAX_ATTEMPTS - r["attempts"] - 1
            return f"That code is not right. {left} attempt{'s' if left != 1 else ''} left."
        con.execute("DELETE FROM auth_codes WHERE user_id=? AND purpose=?", (uid, purpose))
    return None


def verify_email(user_id, code):
    err = _check_code(user_id, "verify", code)
    if err:
        return None, err
    with db() as con:
        con.execute("UPDATE users SET verified=1, verified_at=? WHERE id=?", (time.time(), user_id))
        u = con.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
    return {"user": _user_public(u), "features": feature_map(_effective(u))}, None


def resend_verification(user_id, ip):
    if not _limit(f"resend:{user_id}", 5, 3600) or not _limit("resend-ip:" + ip, 15, 3600):
        return None, "Too many codes requested. Try again in an hour."
    with db() as con:
        u = con.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
        last = con.execute("SELECT created_at FROM auth_codes WHERE user_id=? AND purpose='verify' ORDER BY id DESC LIMIT 1",
                           (user_id,)).fetchone()
    if not u:
        return None, "Account not found."
    if u["verified"]:
        return None, "This email is already verified."
    if last and time.time() - last[0] < 45:
        return None, "Please wait a few seconds before asking for another code."
    return _send_code(u, "verify"), None


_GENERIC_RESET = "If an account exists for that email, a reset code has been sent to it."


def forgot_password(email, ip):
    email = (email or "").strip().lower()
    if not _limit("forgot-ip:" + ip, 10, 3600) or not _limit("forgot:" + email, 4, 3600):
        return None, "Too many reset requests. Try again in an hour."
    out = {"message": _GENERIC_RESET, "email_mode": mailer.mode()}
    with db() as con:
        u = con.execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
    if u and not u["disabled"]:
        r = _send_code(u, "reset")
        if "demo_code" in r:
            out["demo_code"] = r["demo_code"]
    return out, None  # same answer whether or not the account exists


def reset_password(email, code, new_pw, ip):
    email = (email or "").strip().lower()
    if not _limit("reset:" + ip, 12, 3600):
        return None, "Too many attempts. Try again later."
    if len(new_pw or "") < 8 or new_pw.isdigit() or new_pw.isalpha():
        return None, "Password must be at least 8 characters and mix letters with numbers or symbols."
    with db() as con:
        u = con.execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
    if not u or u["disabled"]:
        return None, "This code has expired. Ask for a new one."
    err = _check_code(u["id"], "reset", code)
    if err:
        return None, err
    now = time.time()
    with db() as con:
        # receiving the code proves the mailbox, so the email counts as verified too
        con.execute("UPDATE users SET pw_hash=?, verified=1, verified_at=COALESCE(verified_at, ?), last_login=? WHERE id=?",
                    (generate_password_hash(new_pw), now, now, u["id"]))
        con.execute("DELETE FROM sessions WHERE user_id=?", (u["id"],))  # sign out everywhere
        u = con.execute("SELECT * FROM users WHERE id=?", (u["id"],)).fetchone()
    return {"token": _issue(u["id"], u["tier"], u["name"]), "user": _user_public(u)}, None


def change_password(user_id, old_pw, new_pw):
    if len(new_pw or "") < 8 or new_pw.isdigit() or new_pw.isalpha():
        return None, "Password must be at least 8 characters and mix letters with numbers or symbols."
    if not _limit(f"chpw:{user_id}", 6, 600):
        return None, "Too many attempts. Wait 10 minutes."
    with db() as con:
        u = con.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
        if not u or not check_password_hash(u["pw_hash"], old_pw or ""):
            return None, "Current password is incorrect."
        con.execute("UPDATE users SET pw_hash=? WHERE id=?", (generate_password_hash(new_pw), user_id))
        tok = _token_from_request()
        con.execute("DELETE FROM sessions WHERE user_id=? AND token_hash<>?", (user_id, _hash(tok)))
    return {"ok": True, "message": "Password changed. Other devices were signed out."}, None


def request_pro(user_id, org, role, note):
    org, role, note = (org or "").strip()[:120], (role or "").strip()[:80], (note or "").strip()[:500]
    if len(org) < 2:
        return None, "Organisation is required."
    with db() as con:
        u = con.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
        if u["tier"] == "professional":
            return None, "You already have a professional account."
        if con.execute("SELECT 1 FROM pro_requests WHERE user_id=? AND status='pending'", (user_id,)).fetchone():
            return None, "Your request is already waiting for an administrator."
        con.execute("INSERT INTO pro_requests(user_id,org,role,note,status,created_at) VALUES(?,?,?,?,'pending',?)",
                    (user_id, org, role, note, time.time()))
    return {"ok": True, "message": "Request sent. An administrator will review it."}, None


def my_request(user_id):
    with db() as con:
        r = con.execute("SELECT id,org,role,note,status,created_at,decided_at FROM pro_requests WHERE user_id=? ORDER BY id DESC LIMIT 1",
                        (user_id,)).fetchone()
    return dict(r) if r else None


def guest(ip):
    if not _limit("guest:" + ip, 30, 3600):
        return None, "Too many guest sessions from this network."
    return {"token": _issue(None, "guest", "Guest"), "user": _user_public(None)}, None


def upgrade(user_id, code, org, role):
    if len((org or "").strip()) < 2:
        return None, "Organisation is required."
    with db() as con:
        em = (con.execute("SELECT email FROM users WHERE id=?", (user_id,)).fetchone() or {"email": ""})["email"]
    key, kerr = _check_key(code, em)
    if kerr:
        return None, kerr
    with db() as con:
        _consume_key(con, key, em)
        con.execute("UPDATE users SET tier='professional', org=?, role=? WHERE id=?", (org.strip()[:120], (role or "").strip()[:80], user_id))
        con.execute("UPDATE sessions SET tier='professional' WHERE user_id=?", (user_id,))
        con.execute("UPDATE pro_requests SET status='superseded', decided_at=? WHERE user_id=? AND status='pending'", (time.time(), user_id))
        u = con.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()
    return {"user": _user_public(u), "features": feature_map(_effective(u))}, None


def _token_from_request():
    h = request.headers.get("Authorization", "")
    if h.startswith("Bearer "):
        return h[7:].strip()
    return (request.args.get("token") or "").strip()


def resolve():
    """Attach g.session = {tier, user_id, name} for the current request (or None)."""
    tok = _token_from_request()
    g.session = None
    if not tok or len(tok) > 200:
        return None
    now = time.time()
    with db() as con:
        s = con.execute("SELECT * FROM sessions WHERE token_hash=?", (_hash(tok),)).fetchone()
        if not s or s["expires_at"] < now:
            return None
        u = None
        if s["user_id"]:
            u = con.execute("SELECT * FROM users WHERE id=?", (s["user_id"],)).fetchone()
            if not u or u["disabled"]:
                con.execute("DELETE FROM sessions WHERE token_hash=?", (s["token_hash"],))
                return None
        if now - (s["last_seen"] or 0) > 300:
            con.execute("UPDATE sessions SET last_seen=? WHERE token_hash=?", (now, s["token_hash"]))
    tier = _effective(u) if u else "guest"
    g.session = {"tier": tier, "user_id": s["user_id"], "name": u["name"] if u else s["name"],
                 "email": u["email"] if u else None, "is_admin": bool(u and u["is_admin"] and tier != "guest"),
                 "unverified": bool(u and tier == "guest")}
    return g.session


def logout():
    tok = _token_from_request()
    if tok:
        with db() as con:
            con.execute("DELETE FROM sessions WHERE token_hash=?", (_hash(tok),))


def me():
    s = getattr(g, "session", None)
    if not s:
        return None
    if s["user_id"]:
        with db() as con:
            u = con.execute("SELECT * FROM users WHERE id=?", (s["user_id"],)).fetchone()
        return _user_public(u)
    return _user_public(None)


def tier():
    s = getattr(g, "session", None)
    return s["tier"] if s else None


def require(feature):
    """Decorator: 401 without a session, 403 if the tier lacks the feature."""
    def deco(fn):
        @wraps(fn)
        def inner(*a, **kw):
            s = getattr(g, "session", None)
            if not s:
                return jsonify({"error": "Sign in required", "code": "auth_required"}), 401
            if not allowed(s["tier"], feature):
                need = FEATURES.get(feature, "professional")
                if s.get("unverified"):
                    return jsonify({"error": "Verify your email to unlock your account features.", "code": "verify_required",
                                    "feature": feature, "required_tier": need, "your_tier": s["tier"]}), 403
                return jsonify({"error": f"This feature needs a {need} account.", "code": "tier_required",
                                "feature": feature, "required_tier": need, "your_tier": s["tier"]}), 403
            return fn(*a, **kw)
        return inner
    return deco


def require_user(fn):
    """Signed-in account (any tier, verified or not) - for verification / password endpoints."""
    @wraps(fn)
    def inner(*a, **kw):
        s = getattr(g, "session", None)
        if not s:
            return jsonify({"error": "Sign in required", "code": "auth_required"}), 401
        if not s["user_id"]:
            return jsonify({"error": "Create an account first - guests have no email or password.", "code": "account_required"}), 403
        return fn(*a, **kw)
    return inner


def require_admin(fn):
    @wraps(fn)
    def inner(*a, **kw):
        s = getattr(g, "session", None)
        if not s:
            return jsonify({"error": "Sign in required", "code": "auth_required"}), 401
        if not s.get("is_admin"):
            return jsonify({"error": "Administrator access required.", "code": "admin_required"}), 403
        return fn(*a, **kw)
    return inner


# ------------------------------------------------------------------ admin console
def _admin_row(r):
    d = dict(r)
    d.pop("pw_hash", None)
    for k in ("verified", "is_admin", "disabled", "is_owner"):
        d[k] = bool(d.get(k))
    return d


def admin_stats():
    now = time.time()
    with db() as con:
        q = lambda sql, *p: con.execute(sql, p).fetchone()[0]
        return {
            "users": q("SELECT COUNT(*) FROM users"),
            "professional": q("SELECT COUNT(*) FROM users WHERE tier='professional'"),
            "public": q("SELECT COUNT(*) FROM users WHERE tier='public'"),
            "unverified": q("SELECT COUNT(*) FROM users WHERE verified=0"),
            "suspended": q("SELECT COUNT(*) FROM users WHERE disabled=1"),
            "admins": q("SELECT COUNT(*) FROM users WHERE is_admin=1"),
            "keys_active": q("SELECT COUNT(*) FROM pro_keys WHERE revoked=0 AND (expires_at IS NULL OR expires_at>?) AND (max_uses=0 OR uses<max_uses)", now),
            "owner_email": (con.execute("SELECT email FROM users WHERE is_owner=1 LIMIT 1").fetchone() or {"email": None})["email"],
            "new_7d": q("SELECT COUNT(*) FROM users WHERE created_at>?", now - 7 * 86400),
            "active_sessions": q("SELECT COUNT(*) FROM sessions WHERE expires_at>? AND last_seen>?", now, now - 3600),
            "guest_sessions": q("SELECT COUNT(*) FROM sessions WHERE user_id IS NULL AND expires_at>?", now),
            "pending_requests": q("SELECT COUNT(*) FROM pro_requests WHERE status='pending'"),
            "email_mode": mailer.mode(),
            "verification_required": config.REQUIRE_EMAIL_VERIFY,
            "access_code": pro_code(),
            "access_code_pinned": bool((config.PRO_ACCESS_CODE or "").strip()),
            "admin_emails_env": sorted(config.ADMIN_EMAILS),
        }


def admin_users(q="", tier="", status="", limit=100, offset=0):
    where, p = [], []
    if q:
        where.append("(email LIKE ? OR name LIKE ? OR org LIKE ?)")
        p += [f"%{q}%"] * 3
    if tier in ("public", "professional"):
        where.append("tier=?"); p.append(tier)
    if status == "unverified":
        where.append("verified=0")
    elif status == "suspended":
        where.append("disabled=1")
    elif status == "admin":
        where.append("is_admin=1")
    sql = "FROM users" + (" WHERE " + " AND ".join(where) if where else "")
    with db() as con:
        total = con.execute("SELECT COUNT(*) " + sql, p).fetchone()[0]
        rows = con.execute("SELECT *, (SELECT COUNT(*) FROM sessions s WHERE s.user_id=users.id AND s.expires_at>?) AS sessions, "
                           "(SELECT COUNT(*) FROM saved_places sp WHERE sp.user_id=users.id) AS places "
                           + sql + " ORDER BY created_at DESC LIMIT ? OFFSET ?", [time.time()] + p + [min(500, limit), offset]).fetchall()
    return {"total": total, "users": [_admin_row(r) for r in rows]}


def admin_action(actor_id, uid, action, value=None):
    with db() as con:
        u = con.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
        if not u:
            return None, "User not found."
        self_act = uid == actor_id
        admins = con.execute("SELECT COUNT(*) FROM users WHERE is_admin=1 AND disabled=0").fetchone()[0]
        if self_act and action in ("disable", "delete", "remove_admin", "set_tier"):
            return None, "You cannot do that to your own account."
        if u["is_owner"] and not self_act and action in ("disable", "delete", "remove_admin", "set_tier", "revoke_sessions", "send_reset"):
            return None, "The owner account is protected and cannot be changed by other administrators."
        if action == "remove_admin" and u["is_admin"] and admins <= 1:
            return None, "At least one administrator must remain."
        if action == "set_tier":
            if value not in ("public", "professional"):
                return None, "Tier must be public or professional."
            con.execute("UPDATE users SET tier=?, is_admin=CASE WHEN ?='public' THEN 0 ELSE is_admin END WHERE id=?", (value, value, uid))
            con.execute("UPDATE sessions SET tier=? WHERE user_id=?", (value, uid))
            if value == "professional":
                con.execute("UPDATE pro_requests SET status='approved', decided_at=? WHERE user_id=? AND status='pending'", (time.time(), uid))
        elif action == "verify":
            con.execute("UPDATE users SET verified=1, verified_at=COALESCE(verified_at, ?) WHERE id=?", (time.time(), uid))
        elif action == "disable":
            con.execute("UPDATE users SET disabled=1 WHERE id=?", (uid,))
            con.execute("DELETE FROM sessions WHERE user_id=?", (uid,))
        elif action == "enable":
            con.execute("UPDATE users SET disabled=0 WHERE id=?", (uid,))
        elif action == "revoke_sessions":
            con.execute("DELETE FROM sessions WHERE user_id=?", (uid,))
        elif action == "make_admin":
            # any account can be promoted; administrators always become verified professionals
            con.execute("UPDATE users SET is_admin=1, tier='professional', verified=1, disabled=0, "
                        "verified_at=COALESCE(verified_at, ?) WHERE id=?", (time.time(), uid))
            con.execute("UPDATE sessions SET tier='professional' WHERE user_id=?", (uid,))
        elif action == "remove_admin":
            con.execute("UPDATE users SET is_admin=0 WHERE id=?", (uid,))
        elif action == "delete":
            if u["is_admin"] and admins <= 1:
                return None, "At least one administrator must remain."
            for t in ("sessions", "saved_places", "auth_codes", "pro_requests"):
                con.execute(f"DELETE FROM {t} WHERE user_id=?", (uid,))
            con.execute("DELETE FROM users WHERE id=?", (uid,))
            return {"ok": True, "deleted": uid}, None
        elif action not in ("resend_verify", "send_reset"):
            return None, "Unknown action."
        u = con.execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
    extra = {}
    if action == "resend_verify":
        if u["verified"]:
            return None, "This email is already verified."
        extra = _send_code(u, "verify")
    elif action == "send_reset":
        extra = _send_code(u, "reset")
    return {"ok": True, "user": _admin_row(u), **extra}, None


# ------------------------------------------------------------------ professional keys
def _norm_code(c):
    return (c or "").strip().upper().replace(" ", "")


def _check_key(code, email):
    """Accept the shared access code or an admin-issued personal key. Returns (key_row|None, error|None)."""
    c = _norm_code(code)
    if not c:
        return None, "Enter the professional access key from your INDRA administrator."
    if secrets.compare_digest(c, pro_code().upper()):
        return None, None
    with db() as con:
        k = con.execute("SELECT * FROM pro_keys WHERE code=?", (c,)).fetchone()
    if not k:
        return None, "The professional access key is not valid. Ask your INDRA administrator for one."
    if k["revoked"]:
        return None, "This professional key has been revoked."
    if k["expires_at"] and k["expires_at"] < time.time():
        return None, "This professional key has expired. Ask your administrator for a new one."
    if k["max_uses"] and k["uses"] >= k["max_uses"]:
        return None, "This professional key has already been used."
    if k["email"] and k["email"] != (email or "").strip().lower():
        return None, "This professional key was issued for a different email address."
    return k, None


def _consume_key(con, key, email):
    if key:
        con.execute("UPDATE pro_keys SET uses=uses+1, last_used_at=?, used_by=TRIM(COALESCE(used_by,'') || ' ' || ?) WHERE id=?",
                    (time.time(), email, key["id"]))


def _key_row(r):
    d = dict(r)
    now = time.time()
    d["revoked"] = bool(d["revoked"])
    d["status"] = ("revoked" if d["revoked"] else "expired" if d["expires_at"] and d["expires_at"] < now
                   else "used" if d["max_uses"] and d["uses"] >= d["max_uses"] else "active")
    d["used_by"] = [x for x in (d.get("used_by") or "").split() if x]
    return d


def admin_keys():
    with db() as con:
        return [_key_row(r) for r in con.execute("SELECT * FROM pro_keys ORDER BY id DESC LIMIT 300").fetchall()]


def admin_create_key(actor_email, label="", email="", max_uses=1, days=30, send=False):
    email = (email or "").strip().lower()
    if email and not _valid_email(email):
        return None, "Enter a valid email address for the key, or leave it blank."
    try:
        max_uses = max(0, min(1000, int(max_uses)))
        days = max(0, min(3650, int(days)))
    except (TypeError, ValueError):
        return None, "Uses and validity must be numbers."
    code = "PRO-" + "-".join(secrets.token_hex(2).upper() for _ in range(3))
    now = time.time()
    with db() as con:
        con.execute("INSERT INTO pro_keys(code,label,email,max_uses,uses,expires_at,revoked,created_by,created_at) VALUES(?,?,?,?,0,?,0,?,?)",
                    (code, (label or "").strip()[:80] or None, email or None, max_uses, now + days * 86400 if days else None, actor_email, now))
        k = con.execute("SELECT * FROM pro_keys WHERE code=?", (code,)).fetchone()
    out = {"ok": True, "key": _key_row(k)}
    if send and email:
        link = config.PUBLIC_URL
        mailer.send(email, "INDRA: your professional access key",
                    f"Hello,\n\nYou have been given an INDRA professional account key: {code}\n\n"
                    "Open INDRA, choose Professional, create your account and enter this key"
                    + (f" (or open {link})" if link else "") + "."
                    + (f"\nThe key works until {time.strftime('%d %b %Y', time.localtime(now + days * 86400))}." if days else ""),
                    "notice")
        out["sent_to"] = email
    return out, None


def admin_revoke_key(kid):
    with db() as con:
        if not con.execute("SELECT 1 FROM pro_keys WHERE id=?", (kid,)).fetchone():
            return None, "Key not found."
        con.execute("UPDATE pro_keys SET revoked=1 WHERE id=?", (kid,))
    return {"ok": True}, None


def admin_create_user(actor_email, data):
    email = (data.get("email") or "").strip().lower()
    name = (data.get("name") or "").strip()[:80]
    tier = data.get("tier") or "professional"
    make_admin = bool(data.get("admin"))
    pw = data.get("password") or ""
    if not _valid_email(email):
        return None, "Enter a valid email address."
    if len(name) < 2:
        return None, "Enter the person's name."
    if tier not in ("public", "professional"):
        return None, "Tier must be public or professional."
    if make_admin:
        tier = "professional"
    generated = not pw
    if generated:
        pw = _gen_password()
    elif len(pw) < 8 or pw.isdigit() or pw.isalpha():
        return None, "Password must be at least 8 characters and mix letters with numbers or symbols."
    now = time.time()
    with db() as con:
        if con.execute("SELECT 1 FROM users WHERE email=?", (email,)).fetchone():
            return None, "An account with this email already exists."
        cur = con.execute("INSERT INTO users(email,name,pw_hash,tier,org,role,created_at,verified,verified_at,is_admin,is_owner,disabled) "
                          "VALUES(?,?,?,?,?,?,?,1,?,?,0,0)",
                          (email, name, generate_password_hash(pw), tier, (data.get("org") or "").strip()[:120] or None,
                           (data.get("role") or "").strip()[:80] or None, now, now, 1 if make_admin else 0))
        u = con.execute("SELECT * FROM users WHERE id=?", (cur.lastrowid,)).fetchone()
    if data.get("send", True):
        mailer.send(email, "INDRA: your account is ready",
                    f"Hello {name},\n\n{actor_email} created an INDRA {('administrator' if make_admin else tier)} account for you.\n"
                    f"Email: {email}\nTemporary password: {pw}\n\n"
                    + (f"Sign in at {config.PUBLIC_URL} " if config.PUBLIC_URL else "Sign in ")
                    + "and change the password from the account menu.", "notice")
    return {"ok": True, "user": _admin_row(u), "temp_password": pw if generated else None}, None


def admin_requests(status="pending"):
    with db() as con:
        rows = con.execute("SELECT r.*, u.email, u.name, u.tier, u.verified FROM pro_requests r LEFT JOIN users u ON u.id=r.user_id "
                           + ("WHERE r.status=? " if status != "all" else "") + "ORDER BY r.id DESC LIMIT 200",
                           (status,) if status != "all" else ()).fetchall()
    return [dict(r) for r in rows]


def admin_decide(rid, approve, actor_email):
    now = time.time()
    with db() as con:
        r = con.execute("SELECT * FROM pro_requests WHERE id=?", (rid,)).fetchone()
        if not r or r["status"] != "pending":
            return None, "This request is no longer pending."
        con.execute("UPDATE pro_requests SET status=?, decided_at=?, decided_by=? WHERE id=?",
                    ("approved" if approve else "rejected", now, actor_email, rid))
        if approve:
            con.execute("UPDATE users SET tier='professional', org=?, role=? WHERE id=?", (r["org"], r["role"], r["user_id"]))
            con.execute("UPDATE sessions SET tier='professional' WHERE user_id=?", (r["user_id"],))
        u = con.execute("SELECT * FROM users WHERE id=?", (r["user_id"],)).fetchone()
    if u:
        mailer.send(u["email"], "INDRA: professional access " + ("approved" if approve else "not approved"),
                    f"Hello {u['name']},\n\nYour request for an INDRA professional account was "
                    + ("approved. Sign in again to use every feature." if approve else "not approved. Contact your administrator for details."),
                    "notice")
    return {"ok": True}, None


# ------------------------------------------------------------------ saved places
def places(user_id):
    with db() as con:
        return [dict(r) for r in con.execute("SELECT id,name,lat,lon,district_id,notify,created_at FROM saved_places WHERE user_id=? ORDER BY id", (user_id,))]


def add_place(user_id, name, lat, lon, district_id):
    with db() as con:
        n = con.execute("SELECT COUNT(*) FROM saved_places WHERE user_id=?", (user_id,)).fetchone()[0]
        if n >= 20:
            return None, "You can save up to 20 places."
        if con.execute("SELECT 1 FROM saved_places WHERE user_id=? AND abs(lat-?)<0.005 AND abs(lon-?)<0.005", (user_id, lat, lon)).fetchone():
            return None, "This place is already saved."
        con.execute("INSERT INTO saved_places(user_id,name,lat,lon,district_id,notify,created_at) VALUES(?,?,?,?,?,1,?)",
                    (user_id, name[:120], lat, lon, district_id, time.time()))
    return places(user_id), None


def remove_place(user_id, pid):
    with db() as con:
        con.execute("DELETE FROM saved_places WHERE user_id=? AND id=?", (user_id, pid))
    return places(user_id)
