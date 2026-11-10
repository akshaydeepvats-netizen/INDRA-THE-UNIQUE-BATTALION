"""Runtime configuration. Every value can be overridden with an environment variable."""
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _load_dotenv(path):
    """Read KEY=VALUE lines from .env (no extra dependency). Real environment variables win."""
    try:
        lines = path.read_text(encoding="utf-8-sig").splitlines()
    except OSError:
        return
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k, v = k.strip(), v.strip()
        if v[:1] in ("'", '"') and v[-1:] == v[:1] and len(v) >= 2:
            v = v[1:-1]
        elif " #" in v:
            v = v.split(" #", 1)[0].rstrip()
        if k and k not in os.environ:
            os.environ[k] = v


if os.getenv("INDRA_SKIP_DOTENV") != "1":
    _load_dotenv(ROOT / ".env")
DATA_DIR = ROOT / "data"
RUNTIME_DIR = Path(os.getenv("INDRA_RUNTIME_DIR", str(DATA_DIR / "runtime")))
RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH = Path(os.getenv("INDRA_DB_PATH", str(RUNTIME_DIR / "indra.sqlite3")))

VERSION = "4.3.1"
USER_AGENT = os.getenv("INDRA_USER_AGENT", "INDRA-Nowcast/4.0 (SIH26084 research prototype)")
HTTP_TIMEOUT = float(os.getenv("INDRA_HTTP_TIMEOUT_SECONDS", "20"))

# Engine cadence (seconds)
ENGINE_ENABLED = os.getenv("INDRA_ENGINE", "1") == "1"
RADAR_INTERVAL = int(os.getenv("INDRA_RADAR_INTERVAL", "300"))
SATELLITE_INTERVAL = int(os.getenv("INDRA_SATELLITE_INTERVAL", "300"))
MODEL_GRID_INTERVAL = int(os.getenv("INDRA_MODEL_GRID_INTERVAL", "3600"))
LIGHTNING_ENABLED = os.getenv("INDRA_LIGHTNING", "1") == "1"

# Open-Meteo (free tier works; set an API key for the commercial endpoint and denser grids)
OPEN_METEO_KEY = os.getenv("OPEN_METEO_API_KEY", "").strip()
OPEN_METEO_URL = ("https://customer-api.open-meteo.com/v1/forecast" if OPEN_METEO_KEY
                  else os.getenv("OPEN_METEO_URL", "https://api.open-meteo.com/v1/forecast"))
MODEL_GRID_DEG = float(os.getenv("INDRA_MODEL_GRID_DEG", "1.0"))

# Precipitation observations: NASA GIBS (GPM IMERG 30-min) + Himawari IR display layer
GIBS_WMS_4326 = os.getenv("GIBS_WMS_4326", "https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi")
GIBS_WMTS_4326 = os.getenv("GIBS_WMTS_4326", "https://gibs.earthdata.nasa.gov/wmts/epsg4326/best")
GIBS_WMTS_3857 = os.getenv("GIBS_WMTS_3857", "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best")
GIBS_PRECIP_LAYER = os.getenv("GIBS_PRECIP_LAYER", "IMERG_Precipitation_Rate_30min")
GIBS_IR_LAYER = os.getenv("GIBS_IR_LAYER", "Himawari_AHI_Band13_Clean_Infrared")
# IMERG cells older than this are shown as recent history only (no ETA, no screening alert)
PRECIP_LIVE_AGE_S = int(os.getenv("INDRA_PRECIP_LIVE_AGE_S", "5400"))

# Official alerts: NDMA SACHET (Common Alerting Protocol integrated alert system)
SACHET_ALERTS_URL = os.getenv("SACHET_ALERTS_URL", "https://sachet.ndma.gov.in/cap_public_website/FetchAllAlertDetails")
SACHET_INTERVAL = int(os.getenv("INDRA_SACHET_INTERVAL", "180"))

# Satellite (EUMETSAT Meteosat Indian Ocean Data Coverage)
EUMETSAT_WMS = os.getenv("EUMETSAT_WMS", "https://view.eumetsat.int/geoserver/wms")
SAT_LAYER = os.getenv("INDRA_SAT_LAYER", "msg_iodc:ir108")

# Official IMD feeds (require IP whitelisting / API token from IMD)
IMD_API_BASE = os.getenv("IMD_API_BASE", "https://api.imd.gov.in/api/v1").rstrip("/")
IMD_API_TOKEN = os.getenv("IMD_API_TOKEN", "").strip()
IMD_LEGACY_BASE = os.getenv("IMD_LEGACY_BASE", "https://mausam.imd.gov.in/api").rstrip("/")

GEOCODER_URL = os.getenv("GEOCODER_URL", "https://nominatim.openstreetmap.org/search")
CORS_ORIGINS = os.getenv("INDRA_CORS", "*")

# Ground-truth stations (METAR) and live accuracy scoring
STATIONS_INTERVAL = int(os.getenv("INDRA_STATIONS_INTERVAL", "600"))
VERIFY_INTERVAL = int(os.getenv("INDRA_VERIFY_INTERVAL", "3600"))

# Accounts: professional sign-up/upgrade code (random code generated + logged if unset)
PRO_ACCESS_CODE = os.getenv("INDRA_PRO_ACCESS_CODE", "")
AUTH_RATE_MULT = max(1, int(os.getenv("INDRA_AUTH_RATE_MULT", "1")))  # raise only for automated tests

# ---- email (verification + password reset) ----
SMTP_HOST = os.getenv("INDRA_SMTP_HOST", "").strip()
SMTP_PORT = int(os.getenv("INDRA_SMTP_PORT", "587"))
SMTP_USER = os.getenv("INDRA_SMTP_USER", "").strip()
SMTP_PASS = os.getenv("INDRA_SMTP_PASS", "")
SMTP_FROM = os.getenv("INDRA_SMTP_FROM", "").strip() or SMTP_USER or "indra@localhost"
SMTP_SSL = os.getenv("INDRA_SMTP_SSL", "0") == "1"          # 1 = implicit TLS (port 465); else STARTTLS
PUBLIC_URL = os.getenv("INDRA_PUBLIC_URL", "").rstrip("/")     # used for links in emails
REQUIRE_EMAIL_VERIFY = os.getenv("INDRA_REQUIRE_EMAIL_VERIFY", "1") == "1"
# Demo only: when no SMTP server is configured, return codes in the API response so the flow can be tested.
EMAIL_DEMO_ECHO = os.getenv("INDRA_EMAIL_DEMO_ECHO", "0") == "1"
# ---- admin ----
# Built-in owner administrator (created on startup if missing; cannot be demoted by other admins)
OWNER_EMAIL = os.getenv("INDRA_OWNER_EMAIL", "").strip().lower()
OWNER_PASSWORD = os.getenv("INDRA_OWNER_PASSWORD", "")
OWNER_NAME = os.getenv("INDRA_OWNER_NAME", "").strip()
OWNER_ORG = os.getenv("INDRA_OWNER_ORG", "").strip()
ADMIN_EMAILS = {e.strip().lower() for e in os.getenv("INDRA_ADMIN_EMAILS", "").split(",") if e.strip()}
