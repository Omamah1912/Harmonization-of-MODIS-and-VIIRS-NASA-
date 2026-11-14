# Emberline — Harmonized Burning Activity Calendar

NASA Space Apps Challenge 2026 · *Harmonization of MODIS and VIIRS Hot Spots* (CONAE)

**What it is.** A web app that turns 25 years of NASA FIRMS active-fire detections from two different
satellite sensors (MODIS 1 km, since 2000; VIIRS 375 m, since 2012) into one consistent,
sensor-independent record of burning activity, so that "the sensor of origin no longer matters".
Coverage: **Corrientes, Argentina**.

**Why.** During the Dec 2021 – Feb 2022 Corrientes wildfires the satellite record already existed. What was
missing was a consistent view that says *"this is not normal for this place and this time of year"*, early.
Raw hotspot counts can't give that view: VIIRS sees ~3× more hotspots than MODIS for the same fires, so a
naive record jumps in 2012 when VIIRS starts.

## What you can do

| Lens | For | Shows |
|---|---|---|
| **Response Station** | early warning, emergency responders, firefighters | activity status (Normal / Elevated / Extreme / No data), now vs normal, critical window, current fire vs previous, 7-day map, field card |
| **Ranger Post** | land managers | 25-year burning calendar, seasonal climatology and peaks, anomalies vs multi-year averages |
| **Research Lab** | scientists | raw vs harmonized (the 2012 seam), sensor differences, calibration and validation, CSV exports |

- Area of interest: draw a rectangle/polygon, type lat/lon + radius, or pick the province or a department.
- Date range, as-of date (**time-travel replay**: everything recomputed using only data up to that date),
  confidence, static-source and day/night filters, adjustable baseline years.
- **"Would we have seen it coming?"**: a pre-registered alert rule (fixed before examining 2022) is backtested
  against the 2021–22 Corrientes fires and compared with the official emergency decrees. The rule is also run on
  every season from 2003 to 2021, so its false-alarm rate is visible.
- Downloads: hotspots CSV, summary CSV, calendar PNG, one-page field card PNG.

## How the harmonization works (short)

1. **Overlap resolution.** Detections go onto a 0.02° (~2.2 km) grid. The unit is **burning cells per day**:
   a cell counts once however many pixels, overpasses or satellites saw it. This resolves duplicate rows,
   multi-pixel fires and the same fire seen by several satellites. Consecutive-day fires are linked into
   **fire events**.
2. **One VIIRS platform per day** (S-NPP > NOAA-20 > NOAA-21), so adding satellites doesn't inflate counts.
   Suomi NPP stopped delivering data on 2026-11-02, and the reference hands over to NOAA-20 automatically.
3. **Bridging.** Days seen by both sensors use the union of their cells (*observed*). Days with only one
   sensor, including the whole MODIS-only era before 2012, are scaled by month-specific calibration factors
   fitted on the overlap years (*estimated*, with a bootstrap 90% interval).
4. **Missing ≠ zero.** Days without satellite coverage are *no data*, never zero.
5. **Checks:** leave-one-year-out hold-out test, year-by-year stability, and a seam test (naive vs
   harmonized across 2012). Results are in [docs/METHODS.md](docs/METHODS.md) and at `/api/methods`.

Every value is labelled `observed`, `estimated` or `cached`.

## Run it locally

```bash
python -m venv .venv && .venv/Scripts/pip install -r requirements.txt      # (Linux/macOS: .venv/bin/pip)
cp .env.example .env        # put your free FIRMS MAP_KEY in .env
python -m pipeline.run_all  # download (≈1 h, resumable) → normalize → grid → calibrate → events → backtest → fallbacks
uvicorn backend.app.main:app --port 8000
cd frontend && npm install && npm run dev        # http://localhost:5173
```

One-command demo backup: `cd frontend && npm run build`, then `uvicorn backend.app.main:app --port 8000` serves
the app at http://127.0.0.1:8000.

Tests: `pytest backend/tests pipeline/tests`.

## Deploy

- API (+ app): Hugging Face Docker Space — `python deploy/hf_space.py <user>/emberline` (needs `HF_TOKEN`).
- Frontend only: Vercel — build with `VITE_API_URL=https://<user>-emberline.hf.space`.
- If the API is slow or down, the frontend falls back to precomputed results for the preset areas
  (`frontend/public/fallback/`) and shows a **cached** badge.

## Repository

```
pipeline/   fetch_firms · fetch_missing · fetch_boundaries · normalize · grid · harmonize · calibrate · events · alerts · backtest · build_fallbacks · run_all
backend/    FastAPI app (analytics, AOI handling, exports) + tests + Dockerfile
frontend/   React + Vite + TypeScript, MapLibre GL, terra-draw, ECharts, html-to-image
docs/       METHODS.md (harmonization, validation results, pre-registered alert rule, backtest)
```

## Data credits

- We acknowledge the use of data and/or imagery from NASA's Fire Information for Resource Management System
  (FIRMS), part of NASA's Earth Science Data and Information System (ESDIS).
- MODIS Collection 6.1 Hotspot / Active Fire Detections MCD14ML (doi:10.5067/FIRMS/MODIS/MCD14ML) and
  NRT MCD14DL (doi:10.5067/FIRMS/MODIS/MCD14DL.NRT.0061).
- VIIRS 375 m active fire: S-NPP VNP14IMGT (doi:10.5067/FIRMS/VIIRS/VNP14IMGT_NRT.002), NOAA-20 VJ114IMGT
  (doi:10.5067/FIRMS/VIIRS/VJ114IMGT_NRT.002), NOAA-21 VJ214IMGT; standard-processing archives as listed on FIRMS.
- Algorithms: Giglio, Schroeder & Justice 2016 (doi:10.1016/j.rse.2016.02.054); Schroeder et al. 2014
  (doi:10.1016/j.rse.2013.12.008); FIRMS: Davies et al. 2009 (doi:10.1109/TGRS.2008.2002076).
- Boundaries: geoBoundaries gbOpen (CC BY 4.0). Basemap: OpenFreeMap, © OpenMapTiles, © OpenStreetMap contributors.
- Official event dates: provincial and national decrees as cited in `pipeline/config.py` (unverified ones are
  marked as such in the app).

## AI-use disclosure

This project was built with AI assistance (Anthropic Claude, via Claude Code) for code generation, debugging
and documentation, under the team's direction and review. No AI model runs in the app or produces any number
shown: all values are computed deterministically from NASA FIRMS data or quoted from cited official documents.
