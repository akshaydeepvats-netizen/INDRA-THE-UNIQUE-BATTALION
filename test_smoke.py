"""Smoke tests that run offline (engine disabled): python -m pytest -q"""
import os
import sys
from pathlib import Path

os.environ["INDRA_SKIP_DOTENV"] = "1"
os.environ["INDRA_ENGINE"] = "0"
os.environ["INDRA_PRO_ACCESS_CODE"] = "TEST-PRO-CODE"
os.environ["INDRA_AUTH_RATE_MULT"] = "100"
os.environ["INDRA_EMAIL_DEMO_ECHO"] = "1"
os.environ["INDRA_SMTP_HOST"] = ""
os.environ["INDRA_ADMIN_EMAILS"] = "admin@example.org"
os.environ["INDRA_OWNER_EMAIL"] = "owner@example.org"
os.environ["INDRA_OWNER_PASSWORD"] = "owner-pass-2026"
os.environ.setdefault("INDRA_RUNTIME_DIR", str(Path(__file__).parent / ".runtime"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest  # noqa: E402

from app import app  # noqa: E402


import uuid  # noqa: E402

app.config["TESTING"] = True


def _token(tier, email=None, verify=True):
    c = app.test_client()
    if tier == "guest":
        return c.post("/api/auth/guest").get_json()["token"]
    body = {"email": email or f"{uuid.uuid4().hex[:10]}@example.org", "name": "Test User", "password": "test-pass-123", "tier": tier}
    if tier == "professional":
        body.update(org="Test SDMA", role="Duty officer", access_code="TEST-PRO-CODE")
    r = c.post("/api/auth/register", json=body)
    assert r.status_code == 200, r.get_json()
    j = r.get_json()
    if verify:
        v = c.post("/api/auth/verify", json={"code": j["demo_code"]}, headers={"Authorization": "Bearer " + j["token"]})
        assert v.status_code == 200, v.get_json()
    return j["token"]


def _client(tier):
    c = app.test_client()
    c.environ_base["HTTP_AUTHORIZATION"] = "Bearer " + _token(tier)
    return c


@pytest.fixture()
def client():
    return _client("professional")


@pytest.fixture()
def anon():
    return app.test_client()


def test_index_served(client):
    r = client.get("/")
    assert r.status_code == 200 and b"INDRA" in r.data


def test_spa_fallback(client):
    assert client.get("/desk/anything").status_code == 200
    assert client.get("/api/does-not-exist").status_code == 404


def test_health(client):
    r = client.get("/api/health")
    assert r.status_code == 200 and "version" in r.get_json()


def test_states_cover_all_36(client):
    gj = client.get("/static/geo/states.geojson").get_json()
    assert len(gj["features"]) == 36  # 28 states + 8 UTs
    assert client.get("/api/states").status_code == 200


def test_district_drilldown(client):
    d = client.get("/api/states/uttar-pradesh/districts").get_json()
    rows = d.get("districts", d)
    assert len(rows) >= 70
    assert any(x["name"] == "Meerut" for x in rows)


def test_search_village_level(client):
    d = client.get("/api/search?q=Sardhana").get_json()
    assert d["results"], d


def test_status_never_claims_simulated_live(client):
    feeds = client.get("/api/status").get_json()["feeds"]
    ids = {f["id"]: f["state"] for f in feeds}
    for k in ("insat", "dwr", "ilds"):
        assert ids[k] != "LIVE"


def test_static_assets(client):
    for p in ("/static/js/app.js", "/static/css/indra.css", "/static/geo/states.geojson"):
        assert client.get(p).status_code == 200, p


def test_official_endpoint_separate(client):
    r = client.get("/api/official")
    assert r.status_code == 200
    j = r.get_json()
    assert "alerts" in j and "notice" in j


def test_imerg_colormap_roundtrip():
    import numpy as np
    from indra import radar
    i = len(radar._PAL_RGB) // 2
    im = np.zeros((1, 2, 4), dtype=np.uint8)
    im[0, 0, :3] = radar._PAL_RGB[i].astype(np.uint8)
    im[0, 0, 3] = 255
    mmh = radar.rgba_to_mmh(im)
    assert abs(float(mmh[0, 0]) - float(radar._PAL_MMH[i])) < 1e-6
    assert np.isnan(mmh[0, 1])  # transparent = no rain / no data


def test_sachet_normalise_official():
    import time
    from indra import sachet
    rec = {"identifier": "123", "severity": "ALERT", "disaster_type": "Thunderstorm & Lightning",
           "area_description": "Gomati, South Tripura", "centroid": "91.62,23.53", "area_covered": "1200",
           "effective_start_time": "Mon Nov 09 10:00:00 IST 2026", "effective_end_time": "Mon Nov 09 23:00:00 IST 2099",
           "warning_message": "test", "alert_source": "IMD"}
    a = sachet._normalise(rec, time.time())
    assert a["classification"] == "OFFICIAL" and a["level"] == "ALERT" and a["radius_km"] > 0
    assert a["state"] == "Tripura"


def test_auth_required(anon):
    r = anon.get("/api/national")
    assert r.status_code == 401 and r.get_json()["code"] == "auth_required"
    assert anon.get("/api/health").status_code == 200


def test_guest_tier_limits():
    c = _client("guest")
    assert c.get("/api/national").status_code == 200
    assert c.get("/api/accuracy").status_code == 200
    r = c.get("/api/verification")
    assert r.status_code == 403 and r.get_json()["required_tier"] == "professional"
    assert c.get("/api/places").status_code == 403
    me = c.get("/api/auth/me").get_json()
    assert me["user"]["tier"] == "guest" and me["features"]["home"] and not me["features"]["command"]


def test_public_places_and_upgrade():
    c = _client("public")
    r = c.post("/api/places", json={"lat": 28.98, "lon": 77.70, "name": "Meerut"})
    assert r.status_code == 200 and r.get_json()["places"][0]["name"] == "Meerut"
    pid = r.get_json()["places"][0]["id"]
    assert c.delete(f"/api/places/{pid}").get_json()["places"] == []
    assert c.get("/api/export/alerts.csv").status_code == 403
    assert c.post("/api/auth/upgrade", json={"access_code": "wrong", "org": "X Org"}).status_code == 400
    r = c.post("/api/auth/upgrade", json={"access_code": "TEST-PRO-CODE", "org": "District EOC"})
    assert r.status_code == 200 and r.get_json()["user"]["tier"] == "professional"
    assert c.get("/api/verification").status_code == 200


def test_register_validation_and_login(anon):
    assert anon.post("/api/auth/register", json={"email": "bad", "name": "A", "password": "x"}).status_code == 400
    r = anon.post("/api/auth/register", json={"email": "p1@example.org", "name": "Pro Wannabe", "password": "abc12345",
                                              "tier": "professional", "org": "Org", "access_code": "nope"})
    assert r.status_code == 400
    email = f"{uuid.uuid4().hex[:8]}@example.org"
    anon.post("/api/auth/register", json={"email": email, "name": "Pub", "password": "abc12345", "tier": "public"})
    assert anon.post("/api/auth/login", json={"email": email, "password": "wrong999"}).status_code == 401
    assert anon.post("/api/auth/login", json={"email": email, "password": "abc12345", "tier": "professional"}).status_code == 400
    r = anon.post("/api/auth/login", json={"email": email, "password": "abc12345"})
    assert r.status_code == 200 and r.get_json()["user"]["account_tier"] == "public" and r.get_json()["user"]["needs_verification"]


def test_token_query_param_and_logout():
    tok = _token("guest")
    c = app.test_client()
    assert c.get(f"/api/states?token={tok}").status_code == 200
    c.post("/api/auth/logout", headers={"Authorization": "Bearer " + tok})
    assert c.get(f"/api/states?token={tok}").status_code == 401


def test_accuracy_and_stations_shape(client):
    a = client.get("/api/accuracy").get_json()
    assert "summary" in a and "detail" in a
    s = client.get("/api/stations").get_json()
    assert s["label"].startswith("OBSERVED")


def _h(tok):
    return {"Authorization": "Bearer " + tok}


def test_email_verification_gates_features(anon):
    em = f"{uuid.uuid4().hex[:10]}@example.org"
    r = anon.post("/api/auth/register", json={"email": em, "name": "Uv User", "password": "abc12345x", "tier": "professional",
                                             "org": "X SDMA", "access_code": "TEST-PRO-CODE"}).get_json()
    tok = r["token"]
    assert r["user"]["needs_verification"] and r["user"]["tier"] == "guest" and r["user"]["account_tier"] == "professional"
    assert anon.get("/api/nowcast?lat=28.98&lon=77.7", headers=_h(tok)).get_json()["code"] == "verify_required"
    bad = anon.post("/api/auth/verify", json={"code": "000000" if r["demo_code"] != "000000" else "111111"}, headers=_h(tok))
    assert bad.status_code == 400 and "attempt" in bad.get_json()["error"]
    ok = anon.post("/api/auth/verify", json={"code": r["demo_code"]}, headers=_h(tok)).get_json()
    assert ok["user"]["verified"] and ok["user"]["tier"] == "professional"
    assert anon.get("/api/auth/me", headers=_h(tok)).get_json()["features"]["nowcast"]


def test_password_reset_flow(anon):
    em = f"{uuid.uuid4().hex[:10]}@example.org"
    old = _token("public", em)
    f = anon.post("/api/auth/forgot", json={"email": em}).get_json()
    assert "demo_code" in f
    ghost = anon.post("/api/auth/forgot", json={"email": "nobody-" + em}).get_json()
    assert ghost["message"] == f["message"] and "demo_code" not in ghost  # no account enumeration
    r = anon.post("/api/auth/reset", json={"email": em, "code": f["demo_code"], "password": "newpass99"})
    assert r.status_code == 200 and r.get_json()["token"]
    assert anon.get("/api/auth/me", headers=_h(old)).status_code == 401  # old sessions revoked
    assert anon.post("/api/auth/login", json={"email": em, "password": "test-pass-123"}).status_code == 401
    assert anon.post("/api/auth/login", json={"email": em, "password": "newpass99"}).status_code == 200
    assert anon.post("/api/auth/reset", json={"email": em, "code": f["demo_code"], "password": "again999x"}).status_code == 400


def test_admin_console(anon):
    admin = _token("professional", "admin@example.org") if anon.post("/api/auth/login", json={
        "email": "admin@example.org", "password": "test-pass-123"}).status_code != 200 else anon.post(
        "/api/auth/login", json={"email": "admin@example.org", "password": "test-pass-123"}).get_json()["token"]
    pub = _token("public")
    assert anon.get("/api/admin/overview", headers=_h(pub)).status_code == 403
    ov = anon.get("/api/admin/overview", headers=_h(admin)).get_json()
    assert ov["stats"]["users"] >= 1 and ov["stats"]["access_code"] == "TEST-PRO-CODE"
    # public user requests professional access, admin approves
    assert anon.post("/api/auth/request-pro", json={"org": "Meerut DDMA", "role": "Officer"}, headers=_h(pub)).status_code == 200
    reqs = anon.get("/api/admin/requests", headers=_h(admin)).get_json()["requests"]
    rid = [x for x in reqs if x["org"] == "Meerut DDMA"][0]["id"]
    assert anon.post(f"/api/admin/requests/{rid}", json={"decision": "approve"}, headers=_h(admin)).status_code == 200
    assert anon.get("/api/auth/me", headers=_h(pub)).get_json()["user"]["tier"] == "professional"
    uid = anon.get("/api/auth/me", headers=_h(pub)).get_json()["user"]["id"]
    users = anon.get("/api/admin/users?tier=professional", headers=_h(admin)).get_json()
    assert any(u["id"] == uid for u in users["users"]) and all("pw_hash" not in u for u in users["users"])
    # suspend -> sessions die; demote; self-protection
    assert anon.post(f"/api/admin/users/{uid}", json={"action": "disable"}, headers=_h(admin)).status_code == 200
    assert anon.get("/api/auth/me", headers=_h(pub)).status_code == 401
    assert anon.post(f"/api/admin/users/{uid}", json={"action": "enable"}, headers=_h(admin)).status_code == 200
    assert anon.post(f"/api/admin/users/{uid}", json={"action": "set_tier", "value": "public"}, headers=_h(admin)).get_json()["user"]["tier"] == "public"
    me = anon.get("/api/auth/me", headers=_h(admin)).get_json()["user"]
    assert anon.post(f"/api/admin/users/{me['id']}", json={"action": "disable"}, headers=_h(admin)).status_code == 400
    assert anon.get("/api/admin/outbox", headers=_h(admin)).get_json()["mode"] == "outbox"
    assert anon.get("/api/admin/audit", headers=_h(admin)).status_code == 200


def _login(email, pw):
    c = app.test_client()
    r = c.post("/api/auth/login", json={"email": email, "password": pw})
    assert r.status_code == 200, r.get_json()
    c.environ_base["HTTP_AUTHORIZATION"] = "Bearer " + r.get_json()["token"]
    return c, r.get_json()["user"]


def test_owner_admin_has_everything_and_is_protected():
    own, u = _login("owner@example.org", "owner-pass-2026")
    assert u["is_owner"] and u["is_admin"] and u["tier"] == "professional" and u["verified"]
    assert own.get("/api/admin/overview").get_json()["stats"]["owner_email"] == "owner@example.org"
    # second admin cannot touch the owner
    adm = _client("public")
    me = adm.get("/api/auth/me").get_json()["user"]
    assert own.post(f"/api/admin/users/{me['id']}", json={"action": "make_admin"}).status_code == 200
    me2 = adm.get("/api/auth/me").get_json()["user"]
    assert me2["is_admin"] and me2["tier"] == "professional"          # promoted public -> pro admin
    assert adm.get("/api/admin/overview").status_code == 200
    assert adm.post(f"/api/admin/users/{u['id']}", json={"action": "remove_admin"}).status_code == 400
    assert adm.post(f"/api/admin/users/{u['id']}", json={"action": "disable"}).status_code == 400


def test_personal_pro_keys():
    own, _ = _login("owner@example.org", "owner-pass-2026")
    k = own.post("/api/admin/keys", json={"label": "DDMA", "email": "kk@example.org", "max_uses": 1, "days": 7}).get_json()["key"]
    assert k["status"] == "active" and k["code"].startswith("PRO-")
    c = app.test_client()
    base = {"name": "Key User", "password": "test-pass-123", "tier": "professional", "org": "DDMA", "access_code": k["code"].lower()}
    assert c.post("/api/auth/register", json={**base, "email": "other@example.org"}).status_code == 400   # locked to email
    assert c.post("/api/auth/register", json={**base, "email": "kk@example.org"}).status_code == 200
    assert c.post("/api/auth/register", json={**base, "email": "kk2@example.org"}).status_code == 400     # used up
    ks = own.get("/api/admin/keys").get_json()["keys"]
    assert next(x for x in ks if x["id"] == k["id"])["status"] == "used"
    k2 = own.post("/api/admin/keys", json={"max_uses": 0, "days": 0}).get_json()["key"]
    assert own.post(f"/api/admin/keys/{k2['id']}/revoke").status_code == 200
    assert c.post("/api/auth/register", json={**base, "email": "kk3@example.org", "access_code": k2["code"]}).status_code == 400
    # non-admins cannot issue keys
    assert _client("professional").post("/api/admin/keys", json={}).status_code == 403


def test_admin_creates_users():
    own, _ = _login("owner@example.org", "owner-pass-2026")
    r = own.post("/api/admin/users", json={"name": "New Admin", "email": "newadm@example.org", "tier": "public", "admin": True})
    j = r.get_json()
    assert r.status_code == 200 and j["temp_password"] and j["user"]["is_admin"] and j["user"]["tier"] == "professional"
    c, u = _login("newadm@example.org", j["temp_password"])
    assert u["verified"] and u["is_admin"]
    assert c.get("/api/admin/users").status_code == 200
    assert own.post("/api/admin/users", json={"name": "Dup", "email": "newadm@example.org"}).status_code == 400
