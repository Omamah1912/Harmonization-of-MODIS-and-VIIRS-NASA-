"""Central configuration for the Emberline pipeline (CLAUDE.md §4–§7, §11)."""
from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
RAW = DATA / "raw"
PROCESSED = DATA / "processed"
BOUNDARIES = DATA / "boundaries"
DOCS = ROOT / "docs"

try:  # load .env without making python-dotenv mandatory
    from dotenv import load_dotenv

    load_dotenv(ROOT / ".env")
except ImportError:  # pragma: no cover
    pass


def map_key() -> str:
    key = os.environ.get("FIRMS_MAP_KEY", "").strip()
    if not key:
        raise SystemExit("FIRMS_MAP_KEY is not set. Put it in .env (see .env.example).")
    return key


# §4.1 coverage region — W, S, E, N
BBOX = (-60.0, -31.0, -55.5, -27.0)
REGION_NAME = "Corrientes, Argentina"
COVERAGE_BUFFER_DEG = 0.05  # small buffer when clipping detections to the province polygon

# §4.2 FIRMS
FIRMS_BASE = "https://firms.modaps.eosdis.nasa.gov"
DAY_RANGE = 5
# FIRMS limit is 5000 transactions / 10 min. Observed: FIRMS charges ~2 transactions per requested day
# (506 five-day requests -> 4992 transactions), so budget in transactions, not days.
TRANSACTIONS_PER_DAY = 2
MAX_TRANSACTIONS_PER_10MIN = 4000
SERVER_TX_CEILING = 4300  # pause while FIRMS reports usage above this
FETCH_WORKERS = 4

# Sources by group. Priority within VIIRS: SNPP > NOAA20 > NOAA21 (§5.2)
SOURCES = {
    "MODIS": ("MODIS_SP", "MODIS_NRT"),
    "VIIRS_SNPP": ("VIIRS_SNPP_SP", "VIIRS_SNPP_NRT"),
    "VIIRS_NOAA20": ("VIIRS_NOAA20_SP", "VIIRS_NOAA20_NRT"),
    "VIIRS_NOAA21": ("VIIRS_NOAA21_SP", "VIIRS_NOAA21_NRT"),
}
VIIRS_PRIORITY = ["SNPP", "NOAA20", "NOAA21"]

# §5.2 grid
CELL_DEG = 0.02

# §5.4 calibration
SHRINK_N0 = 200
BOOTSTRAP_DRAWS = 500
BOOTSTRAP_SEED = 20261115
INTER_VIIRS_TOLERANCE = 0.10
INTER_VIIRS_MIN_CELLS = 200  # a month decides the inter-VIIRS check only with >= 200 cells

# §6.1
INCOMPLETE_COVERAGE = 0.80

# §7.2 alert rule (pre-registered — do NOT tune on 2022)
ALERT_RULE = {
    "signal": "7-day rolling sum of harmonized burning cells H_d in the AOI",
    "window_days": 7,
    "baseline_years": [2003, 2021],
    "doy_pool_halfwidth": 15,
    "alert_percentile": 90,
    "severe_percentile": 99,
    "consecutive_days": 3,
}
BACKTEST_SEASON = ("2021-11-01", "2022-03-31")

# §11 official markers. verified=False -> dashed line + "(unverified)" in the UI.
OFFICIAL_MARKERS = [
    {
        "date": "2022-01-01",
        "label": "National emergencia ígnea, Decree 6/2022 (exact date to verify)",
        "source_url": "https://www.argentina.gob.ar/sites/default/files/2022/12/2_de_diciembre_-_reporte.pdf",
        "verified": False,
    },
    {
        "date": "2022-02-01",
        "label": "Corrientes emergencia ígnea, Decree 167/2022 (press date)",
        "source_url": "https://aldiaargentina.microjuris.com/2022/02/24/legislacion-incendios-se-declara-a-la-provincia-de-corrientes-zona-de-desastre-ecologico-y-ambiental-debido-a-los-estragos-ocasionados-en-la-fauna-la-flora-y-la-biodiversidad/",
        "verified": False,
    },
    {
        "date": "2022-02-07",
        "label": "Corrientes agricultural emergency/disaster, Decree 200/2022 (signed; B.O. 9 Feb)",
        "source_url": "https://aldiaargentina.microjuris.com/2022/02/11/legislacion-incendios-rurales-corrientes-declara-el-estado-de-emergencia-y-o-desastre-agropecuario-por-6-meses/",
        "verified": True,
    },
    {
        "date": "2022-02-22",
        "label": "Corrientes ecological & environmental disaster zone, DNU 335/2022 (B.O.)",
        "source_url": "https://aldiaargentina.microjuris.com/2022/02/24/legislacion-incendios-se-declara-a-la-provincia-de-corrientes-zona-de-desastre-ecologico-y-ambiental-debido-a-los-estragos-ocasionados-en-la-fauna-la-flora-y-la-biodiversidad/",
        "verified": False,
    },
]
