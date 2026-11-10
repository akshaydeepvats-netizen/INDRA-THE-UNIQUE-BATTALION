"""Hazard scoring rules, threat levels and safety precautions.

All INDRA hazard scores are EXPERIMENTAL screening indices (0-100). They are not calibrated
probabilities and have not been validated against an independent event archive."""
import math

LEVELS = ["MINIMAL", "LOW", "MEDIUM", "HIGH", "CRITICAL"]
HAZARDS = ["thunderstorm", "lightning", "hail", "cloudburst", "downburst", "heavy_rain"]
HAZARD_LABEL = {"thunderstorm": "Thunderstorm", "lightning": "Lightning", "hail": "Hailstorm", "cloudburst": "Cloudburst",
                "downburst": "Downburst / damaging wind", "heavy_rain": "Heavy rainfall", "severe_convective": "Severe convective storm"}
SINGLE_SOURCE_CAP = 65  # one observing system only (e.g. radar without lightning/satellite) -> max HIGH
SAT_ONLY_CAP = 55  # cold cloud tops alone can be cirrus anvils -> max MEDIUM
MODEL_ONLY_CAP = 70  # CRITICAL requires an observation (radar, satellite or lightning)


def level(score):
    if score is None:
        return "UNKNOWN"
    if score >= 80:
        return "CRITICAL"
    if score >= 60:
        return "HIGH"
    if score >= 40:
        return "MEDIUM"
    if score >= 20:
        return "LOW"
    return "MINIMAL"


def level_rank(lv):
    return LEVELS.index(lv) if lv in LEVELS else -1


def c01(x):
    return max(0.0, min(1.0, x))


def rain_rate(dbz):
    """Marshall-Palmer Z = 200 R^1.6 (mm/h)."""
    return (10 ** (dbz / 10) / 200) ** (1 / 1.6)


def score_radar_cell(o, env, strikes):
    mx, p90 = o["max_dbz"], o["p90_dbz"]
    rr = rain_rate(p90)
    slow = 1.0 if (o["motion"].get("speed_kmh") is not None and o["motion"]["speed_kmh"] < 12) else 0.0
    trend = o.get("trend", {})
    env = env or {}
    cape = env.get("cape", 0) or 0
    fzl = env.get("freezing_level_m", 4800) or 4800
    ltg = 0 if not strikes else 50 if strikes < 5 else 70 if strikes < 15 else 85 if strikes < 40 else 96
    thunder = 100 * c01((mx - 35) / 22) * 0.75 + 0.25 * max(ltg, 100 * c01(cape / 2500))
    hail = 0.0
    if mx >= 50:
        hail = 35 + 45 * c01((mx - 52) / 10) + 15 * c01((4500 - fzl) / 1500) + 10 * c01(o["frac_ge55"] * 10)
    area_f = c01(o.get("area_km2", 0) / 600)
    cloudburst = 100 * c01((rr - 50) / 70) * (0.6 + 0.4 * slow) * (0.6 + 0.4 * area_f)
    heavy = 100 * c01((rr - 8) / 60) * (0.55 + 0.45 * area_f)
    collapse = 1.0 if (trend.get("intensity_change_h") or 0) < -20 and mx >= 45 else 0.0
    downburst = 100 * c01(0.45 * c01((mx - 45) / 15) + 0.35 * collapse + 0.2 * c01((env.get("gust_kmh") or 0) / 80))
    lightning = max(ltg, thunder * 0.7)
    if trend.get("state") == "RAPIDLY INTENSIFYING":
        thunder += 8
    s = {"thunderstorm": thunder, "lightning": lightning, "hail": hail, "cloudburst": cloudburst,
         "downburst": downburst, "heavy_rain": heavy}
    return {k: int(round(min(100, v))) for k, v in s.items()}, {"rain_rate_p90_mmh": round(rr, 1)}


def score_sat_cell(o, env, strikes):
    mn = o["min_bt"]
    cool = o.get("cooling_k_15min")
    env = env or {}
    cape = env.get("cape", 0) or 0
    ltg = 0 if not strikes else 50 if strikes < 5 else 70 if strikes < 15 else 85 if strikes < 40 else 96
    depth = c01((235 - mn) / 35)
    cool_b = c01(-(cool or 0) / 10)
    thunder = 100 * (0.55 * depth + 0.2 * cool_b + 0.25 * c01(cape / 2000))
    thunder = max(thunder, ltg * 0.9)
    heavy = 100 * c01(depth * 0.7 + 0.3 * o.get("frac_core", 0))
    s = {"thunderstorm": thunder, "lightning": max(ltg, thunder * 0.6), "hail": 100 * c01((215 - mn) / 20) * c01(cape / 2000) * 0.7,
         "cloudburst": 100 * c01(o.get("frac_core", 0) * depth) * 0.6, "downburst": 100 * c01(cape / 3000) * depth * 0.5,
         "heavy_rain": heavy}
    return {k: int(round(min(100, v))) for k, v in s.items()}


PRECAUTIONS = {
    "thunderstorm": ["Stay indoors; postpone outdoor work and travel during the storm window.",
                     "Unplug sensitive electrical appliances.",
                     "Keep away from trees, poles and weak structures."],
    "lightning": ["When thunder roars, go indoors — follow the 30-30 rule.",
                  "Avoid open fields, rooftops, water bodies, isolated trees and metal structures.",
                  "If caught outside, crouch low on the balls of your feet; do not lie flat.",
                  "Use the official Damini (IITM) app for lightning alerts."],
    "hail": ["Shelter vehicles and livestock; cover standing crops and nursery beds where possible.",
             "Stay away from windows and skylights."],
    "cloudburst": ["Move away from rivers, nullahs, steep slopes and landslide-prone areas.",
                   "Do not cross flowing water on foot or by vehicle.",
                   "Keep emergency kit, torch and charged phone ready; follow SDMA instructions."],
    "downburst": ["Secure loose roofing sheets, hoardings and outdoor objects.",
                  "Stay clear of tall trees, hoardings and electricity lines.",
                  "Drivers: slow down and avoid parking under trees."],
    "heavy_rain": ["Avoid waterlogged underpasses and roads; watch for urban flooding.",
                   "Keep drains clear; move valuables to higher shelves.",
                   "Check official IMD district warnings and SDMA advisories."],
}
COMMON = ["INDRA output is experimental screening, not an official warning. Always follow IMD and State/District Disaster Management Authority instructions.",
          "Emergency: dial 112 (ERSS) · NDMA helpline 1078."]


def precautions(hazard_scores):
    order = sorted(((v, k) for k, v in hazard_scores.items() if k in PRECAUTIONS and v >= 20), reverse=True)
    out = []
    for _, k in order[:3]:
        out += PRECAUTIONS[k]
    if not out:
        out = ["No significant convective hazard signal at present. Keep monitoring official forecasts."]
    return out + COMMON


def confidence(sources, model_spread=None, lead_h=0):
    """Qualitative confidence based on independent evidence lines and lead time."""
    n = len(set(sources))
    base = 0.35 + 0.18 * n - 0.07 * lead_h
    if model_spread is not None:
        base -= 0.1 * c01(model_spread)
    base = c01(base)
    return {"score": round(base, 2), "label": "HIGH" if base >= 0.7 else "MEDIUM" if base >= 0.45 else "LOW",
            "basis": sorted(set(sources))}
