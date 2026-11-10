"""Official IMD feeds (district nowcast / district warnings). IMD restricts these APIs to
whitelisted IPs or registered tokens. INDRA never treats a missing feed as 'no warning'."""
from . import config, net

PRODUCTS = {
    "district_nowcast": (f"{config.IMD_LEGACY_BASE}/nowcast_district_api.php", f"{config.IMD_API_BASE}/districtnowcast"),
    "district_warnings": (f"{config.IMD_LEGACY_BASE}/warnings_district_api.php", f"{config.IMD_API_BASE}/districtwarning"),
}


def fetch(kind):
    errors = []
    for i, url in enumerate(PRODUCTS[kind]):
        headers = {"Accept": "application/json"}
        if i == 1 and config.IMD_API_TOKEN:
            headers["Authorization"] = f"Bearer {config.IMD_API_TOKEN}"
        data, meta = net.get(url, ttl=300, feed="imd_official", headers=headers, timeout=12)
        if data is not None:
            recs = data.get("data", data.get("result", data)) if isinstance(data, dict) else data
            if isinstance(recs, list):
                return {"status": meta["status"], "records": recs[:2000], "endpoint": url, "fetched_at": meta.get("fetched_at")}
            errors.append(f"{url}: unexpected shape")
        else:
            errors.append(f"{url}: {meta.get('error', '')[:160]}")
    return {"status": "UNAVAILABLE", "records": [], "errors": errors,
            "message": "IMD restricts this API to whitelisted IP addresses / registered tokens. Request access from IMD and set IMD_API_TOKEN, "
                       "or deploy from a whitelisted IP. Absence of this feed does NOT mean absence of an official warning — check mausam.imd.gov.in."}


def summary():
    return {"official_source": "India Meteorological Department", "url": "https://mausam.imd.gov.in/",
            "district_nowcast": fetch("district_nowcast"), "district_warnings": fetch("district_warnings")}
