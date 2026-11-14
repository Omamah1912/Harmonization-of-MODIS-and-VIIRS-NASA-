# CLAUDE.md — EMBERLINE: Harmonized Burning Activity Calendar
NASA Space Apps Challenge 2026 · Challenge: **Harmonization of MODIS and VIIRS Hot Spots** (authored by CONAE)
Team of 2 · Build window: ~22 hours · Submission deadline: confirm with Local Lead (team notes say Nov 15, 11:59 PM local)

> Working name "Emberline" is a placeholder — rename freely.
> This file is the single source of truth for the build. Read it fully before writing code.
> The visual/UI design spec will be added separately as `FRONTEND.md`. Until then, build the frontend
> **functionally** (data wiring, components, interactions listed in §9) with minimal neutral styling.

---

## 0. Rules for Claude Code (read first)

1. **Never fabricate data.** Every number shown in the app comes from FIRMS files we downloaded, or from a cited official document (§11). No synthetic data in the demo path. If a demo fallback is needed, it is *real precomputed output*, labelled as cached.
2. **Missing ≠ zero.** Days with no satellite coverage are `null`, never `0`. They render as hatched/grey "no data", never as "no fire".
3. **Label provenance everywhere.** Every value is one of: `observed` · `estimated` (bridged from one sensor via calibration) · `cached`. The UI must show which.
4. **Never sum MODIS + VIIRS hotspot counts** and call it a fire count. Overlapping detections are resolved by the method in §5.
5. **The demo must never hang.** Every API call in the frontend has a timeout and a fallback to precomputed JSON for the preset areas (§8.4).
6. **Secrets:** `FIRMS_MAP_KEY` lives in `.env` (git-ignored). Never commit it, never log it, never ship it to the frontend.
7. **Pre-registration:** the alert rule in §7 is fixed using 2003–2021 data *before* looking at the 2022 event. Do not tune thresholds to make 2022 look good. Record the rule and its parameters in `docs/METHODS.md` before running the backtest.
8. **Deterministic first.** No ML is required. Prefer simple, explainable, testable methods. An LLM is not on the critical path.
9. Work milestone by milestone (§13). After each milestone: run tests, commit, and print a short status summary.

---

## 1. What the challenge demands (requirement → where it is built)

Source: official challenge statement (Description, Objectives, Potential Considerations) + organizer guidance.

| # | Requirement | Built in |
|---|---|---|
| R1 | Harmonize MODIS and VIIRS so "the sensor of origin no longer matters" | §5 |
| R2 | Consistent series early-2000s → present, combining MODIS history with VIIRS continuity/detail | §5.4 |
| R3 | Web app that takes the harmonized dataset as input | §8, §9 |
| R4 | User selects a region (draw on map, or enter lat/lon) | §9.2 |
| R5 | User selects a date range | §9.2 |
| R6 | Burning activity calendar (hotspot activity by month/year, early-2000s → present) | §6.1 |
| R7 | Accessible color ramps | §9.4 |
| R8 | Which periods of the year see more fire; which years had more activity | §6.2 |
| R9 | Current month vs historical median for the area | §6.3 |
| R10 | Historical comparisons incl. anomalies vs multi-year averages | §6.4 |
| R11 | Downloadable CSV of hotspots detected in a search | §8.2 `/api/export/hotspots.csv` |
| R12 | Download analytics and visualizations | §8.2 `/api/export/summary.csv`, PNG export in §9 |
| R13 | Number of fires detected and reported | §6.5 (detected) + §11 (reported, cited, event only) |
| R14 | How a current fire compares with previous ones | §6.6 fire events |
| R15 | Audiences: early warning/emergency responders, scientists, land managers, firefighters | §9.1 audience lenses |
| R15b | Anticipate / examine critical periods | §6.8, §6.9 |
| R16 | Organizer note: handle **overlapping detections** and **differences between satellites**; make info useful and understandable, not just dots on a map | §5.2, §5.3, §6.7 |
| EDGE | "Would we have seen it coming?" — time-travel replay + backtest against a real documented disaster | §7 |

---

## 2. Problem statement (real event)

**Corrientes, Argentina — Dec 2021 to Feb 2022 wildfires.** During a severe drought, fires burned across Corrientes province (grasslands, palm groves, wetlands incl. the Iberá system). The emergency response was formalized in stages through provincial and national decrees (§11). Fire hotspots were visible from space throughout.

Pitch framing: *the satellite record already existed; what responders lacked was a consistent, sensor-independent view that says "this is not normal for this place and this time of year" — early.* Our tool provides that view for any area, and the replay mode tests honestly whether it would have helped in Corrientes.

---

## 3. Tech stack

| Layer | Choice |
|---|---|
| Data pipeline | Python 3.11, `requests`, `pandas`, `pyarrow`, `duckdb`, `numpy`, `shapely`, `geopandas` (only for boundary prep) |
| Backend API | FastAPI + DuckDB over Parquet (read-only), `uvicorn` |
| Frontend | React + Vite + TypeScript, MapLibre GL JS (free OSM/CARTO tiles, no key), `terra-draw` (or `@mapbox/mapbox-gl-draw` compatible with MapLibre) for drawing AOIs, charts via ECharts or Observable Plot (pick one, use it everywhere), `html-to-image` for PNG export |
| Hosting (free) | Backend: Hugging Face Spaces (Docker) — Render free tier as backup. Frontend: Vercel. Also run locally for the demo as a backup. |
| Keys | Only `FIRMS_MAP_KEY` (free). Nothing else requires a key. |

---

## 4. Data acquisition

### 4.1 Coverage region
- Region: **Corrientes province, Argentina**, plus buffer.
- Download bbox (W,S,E,N): `-60.0,-31.0,-55.5,-27.0`. **Verify** against the province polygon after downloading boundaries and widen if any part is clipped.
- Boundaries: geoBoundaries (gbOpen) ARG **ADM1** (province) and **ADM2** (departments). API: `https://www.geoboundaries.org/api/current/gbOpen/ARG/ADM1/` returns JSON with a `gjDownloadURL`. Save to `data/boundaries/`. Extract Corrientes; keep ADM2 departments inside it for presets.
- The app's coverage is this region only. The UI states it plainly ("Coverage: Corrientes, Argentina").

### 4.2 FIRMS sources
Use the FIRMS area API: `https://firms.modaps.eosdis.nasa.gov/api/area/csv/{MAP_KEY}/{SOURCE}/{W,S,E,N}/{DAY_RANGE}/{YYYY-MM-DD}`

| Source | Use |
|---|---|
| `MODIS_SP` | MODIS Terra+Aqua archive (standard processing), Nov 2000 → SP end |
| `MODIS_NRT` | MODIS after SP end → today |
| `VIIRS_SNPP_SP` / `VIIRS_SNPP_NRT` | VIIRS reference sensor, 2012 → SNPP end (SNPP has stopped delivering new data — see §5.2) |
| `VIIRS_NOAA20_SP` / `VIIRS_NOAA20_NRT` | Fills SNPP outages (2018 →) and becomes the reference after SNPP's end |
| `VIIRS_NOAA21_NRT` | Fills NOAA-20 gaps (recent) |

Steps:
1. Check key status first (FIRMS MAP_KEY status endpoint: `https://firms.modaps.eosdis.nasa.gov/mapserver/mapkey_status/?MAP_KEY=...`).
2. Call `https://firms.modaps.eosdis.nasa.gov/api/data_availability/csv/{MAP_KEY}/ALL` to get each source's min/max date. Use SP up to its max date, NRT strictly after it. Never double-load the same date from SP and NRT.
3. Fetch in chunks of `DAY_RANGE=5` (fall back to 1 if the API rejects 5). Each day counts as one transaction; the limit is 5,000 transactions / 10 min. **Throttle to ≤ 4,000 days per 10 minutes.** Expected total ≈ 18,000 day-transactions → ~50 min. Start this first; build everything else while it runs.
4. Cache every chunk as `data/raw/{SOURCE}/{start_date}.csv`. The fetcher must be **resumable** (skip existing files) and retry 5xx/504 with exponential backoff (max 5 tries), logging failures to `data/raw/failures.csv`.
5. Fetch missing-data dates per source (FIRMS `missing_data` service; inspect the response format first). Store in `data/raw/missing_days.csv`. These feed the coverage mask (§5.1).
6. **Fallback** if the API is down: FIRMS archive download tool (`https://firms.modaps.eosdis.nasa.gov/download/`, may require free Earthdata Login) or FIRMS per-country yearly CSVs for Argentina. Same normalizer must accept these.

### 4.3 Normalization → `data/processed/detections.parquet`
Map both sensors' columns into one schema:

| Column | Notes |
|---|---|
| `det_id` | stable hash of (platform, lat, lon, acq_utc) |
| `sensor` | `MODIS` / `VIIRS` |
| `platform` | `Terra`, `Aqua`, `SNPP`, `NOAA20`, `NOAA21` (map FIRMS codes like T/A/N/N20/N21 — inspect actual values) |
| `lat`, `lon` | |
| `acq_utc` | from `acq_date` + `acq_time` (HHMM, UTC) |
| `solar_date` | local solar date: `acq_utc + lon/15 h`, take the date. **All daily aggregation uses `solar_date`.** |
| `daynight` | D/N |
| `conf_class` | MODIS numeric: <30 `low`, 30–79 `nominal`, ≥80 `high`. VIIRS l/n/h → `low`/`nominal`/`high`. Keep `conf_raw`. |
| `frp` | MW |
| `bright` | MODIS `brightness` / VIIRS `bright_ti4` |
| `pixel_km2` | `scan * track` |
| `type` | FIRMS type if present (0 vegetation fire, 1 volcano, 2 other static land source, 3 offshore); else null |
| `source_product` | e.g. `MODIS_SP` |
| `processing` | `SP` / `NRT` |

Cleaning:
- Drop exact duplicates on (platform, lat, lon, acq_utc) — these come from chunk boundaries and SP/NRT overlap.
- Default analysis filter: `type` null or 0, and `conf_class` ≠ `low`. Keep all rows in the file with flags; filters are query-time options.
- Clip to the coverage polygon (+ small buffer).

---

## 5. Harmonization (Phase 1 of the challenge)

### 5.1 Coverage mask (missing ≠ zero)
Build `coverage.parquet`: for each `solar_date` × group (`MODIS` = Terra or Aqua observed that day; `VIIRS` = SNPP, or NOAA20/21 when SNPP missing) → boolean `observed`. A day is observed for a group if at least one platform in it has no missing-data entry for that date. Unobserved → downstream values are `null`.

### 5.2 Resolving overlapping detections (organizer emphasis)
A single fire produces many hotspot rows. We resolve overlap at four levels:

| Level | Overlap | How we resolve it |
|---|---|---|
| L1 | Same detection appears twice (SP/NRT, chunk boundary) | exact dedup (§4.3) |
| L2 | One fire → several adjacent pixels in one overpass (VIIRS 375 m sees one MODIS-pixel fire as multiple points; MODIS edge-of-scan pixels overlap) | **cell-day presence** on a fixed grid |
| L3 | Same fire seen by several platforms the same day (Terra AM, Aqua PM, SNPP/NOAA-20 ~PM) | **cell-day presence** across platforms |
| L4 | Same fire across consecutive days | **fire events** (§6.6) |

**Grid:** regular lat/lon grid, `CELL_DEG = 0.02` (~2.2 km, slightly larger than a MODIS nadir pixel; configurable). `cell_id = f"{row}_{col}"` from floor of (lat, lon)/CELL_DEG.

Build `cell_day.parquet` (one row per cell × solar_date with ≥1 detection after filters):
`cell_id, solar_date, m (bool: any MODIS), v (bool: any VIIRS reference), n_modis, n_viirs, n_terra, n_aqua, n_snpp, n_noaa20, n_noaa21, frp_sum, frp_max`

**VIIRS reference — exactly ONE VIIRS platform per day**, by priority **SNPP > NOAA-20 > NOAA-21**: on each day, `v` uses only the highest-priority platform that observed that day. Never union several VIIRS platforms on the same day (that would inflate counts when satellites were added in 2018/2023).

⚠️ **Suomi NPP is no longer delivering new data** (notice on the FIRMS Earthdata page). So for recent dates the reference automatically becomes NOAA-20. Required:
- Detect the SNPP last-data date from `data_availability` and log it in `docs/METHODS.md`.
- **Inter-VIIRS check:** over the SNPP–NOAA-20 overlap (2018 → SNPP end), compute `k_N20 = Σ SNPP cells / Σ NOAA-20 cells` per calendar month. If any month differs from 1 by more than 10%, multiply NOAA-20 cells by `k_N20` and mark those days `estimated`; otherwise use them as `observed` and report the factor. Same for NOAA-21 vs NOAA-20 (overlap 2023 →).
- The calendar/legend must note the platform handover date.

### 5.3 Core unit: "burning cells"
`burning cells on day d` = number of grid cells with an active-fire detection on day d. This is the harmonized unit used everywhere in the calendar. It is understandable ("how many ~2 km squares were burning that day") and immune to L1–L3 overlap.

Raw hotspot counts per sensor are still available (Scientist lens, CSV) but never mixed.

### 5.4 Bridging sensors both ways
Three eras, determined from coverage:

| Era | Available | Harmonized value `H_d` | Provenance |
|---|---|---|---|
| A: 2000 → VIIRS start (Jan 2012) | MODIS only | `k_M(month) × Σ_c m` | `estimated` |
| B: overlap | MODIS + VIIRS | `Σ_c (m OR v)` — the union, the best available picture | `observed` |
| C: after MODIS ends (or MODIS-missing days) | VIIRS only | `k_V(month) × Σ_c v` | `estimated` |
| — | neither | `null` | `no data` |

Calibration factors, fitted on era B days within the coverage region, per calendar month `m` (1–12):
- `k_M(m) = Σ union / Σ m-cells` — how many burning cells the union sees per MODIS cell.
- `k_V(m) = Σ union / Σ v-cells`.

AOI-specific shrinkage: if the selected AOI has enough overlap data, blend
`k = (n_aoi·k_aoi + n0·k_region) / (n_aoi + n0)`, with `n_aoi` = MODIS (or VIIRS) cell-days in the AOI for that month across overlap years and `n0 = 200`. Precompute region factors; compute AOI factors at query time (cheap).

**Uncertainty:** year-block bootstrap (resample overlap years with replacement, 500 draws) → 5th/95th percentile of `k` → `H_low`, `H_high` for estimated days. Show as a band / hatch in charts.

**Checks (must run, results go into `docs/METHODS.md` and `/api/methods`):**
1. **Hold-out test:** for each overlap year Y, fit `k_M` on all other overlap years, predict monthly `H` for Y from MODIS only, compare with observed union. Report MAPE, bias, Pearson r, and 90% interval coverage. Same for `k_V`.
2. **Stability:** `k_M` per year (2012 → now). Terra's orbit has been drifting in recent years; if `k_M` trends after ~2020, fit factors on 2012–2019 and Aqua-only for later years, and document it.
3. **Seam test:** naive splice (raw MODIS hotspots before 2012, raw MODIS+VIIRS hotspots after) vs harmonized `H`. The naive series should show a jump at 2012; harmonized should not (beyond real variability). This feeds the raw/harmonized toggle.

---

## 6. Analytics (computed per query: AOI + date range + filters)

All analytics are computed from `H_d` (daily burning cells) for cells whose centroid is inside the AOI.

### 6.1 Burning activity calendar (R6)
- **Monthly matrix:** rows = years (2000/2001 → now), cols = Jan–Dec, value = Σ `H_d` in that month.
- Per cell metadata: `provenance` (observed / estimated / mixed), `coverage_pct` (observed days / days in month), `incomplete` if coverage < 80%, `in_progress` for the current month.
- **Daily strip** (optional zoom): year × day-of-year for the selected year range.

### 6.2 Peak periods (R8)
- Calendar-month climatology across complete years: median, p25, p75, mean.
- Top-5 months-of-year by median; top-5 years by annual total; top-5 single months ever.

### 6.3 Current month vs historical median (R9)
- **Fair comparison:** month-to-date. If today is day 15, compare Σ `H` for days 1–15 of this month vs Σ days 1–15 of the same month in each baseline year.
- Output: value, baseline median, ratio (`×` median), percentile, rank "k of N", and a plain-language sentence, e.g. *"So far this November: 3.1× the usual level — highest of 25 years."*
- Baseline years: default = all complete years excluding the current year; user-adjustable.
- The "as of" date can be set by replay mode (§7) — then everything is computed using only data up to that date.

### 6.4 Anomalies (R10)
- Monthly anomaly = value / climatological median for that calendar month (and absolute difference). Also robust z = (value − median) / IQR.
- Annual anomaly vs multi-year mean.

### 6.5 Detected counts (R13)
For the query: raw hotspots by sensor and platform, burning-cell-days (harmonized), number of fire events (§6.6). Official reported figures exist only for the Corrientes 2022 event and come from §11, labelled `reported (official source)`.

### 6.6 Fire events (R14, overlap level L4)
- On the cell-day table (VIIRS era only, 2012 →, for comparability), link cell-days that are 8-neighbour adjacent and ≤1 day apart → union-find → events.
- Per event: `event_id, start, end, duration_days, peak_day, peak_cells, total_cell_days, footprint_cells (unique), footprint_km2 (approx = unique cells × cell area; label as "footprint", NOT burned area), centroid, max_frp`.
- "Current fire vs previous": for the largest active (or most recent) event in the AOI, rank it among all events in the AOI by footprint and duration. Sentence: *"This fire is the 2nd largest recorded here since 2012."*
- Pre-2012 events are not computed (MODIS-only footprints aren't comparable) — say so.

### 6.7 Sensor differences view (R16)
Per day in the overlap era: cells seen by **both**, **MODIS only**, **VIIRS only**. Share of MODIS cells also seen by VIIRS (using only days where both sensors observed). Mean pixel size by sensor. Day/night split. This makes the "differences between satellites" visible and explains *why* harmonization is needed.

---

### 6.8 Critical periods (brief: "anticipate critical periods", "examine … critical periods")
- From the daily climatology of `H` (smoothed, ±7-day window, baseline years), find contiguous day-of-year spans where the median exceeds the AOI's annual p75 → **critical windows**, e.g. *"Critical window for this area: 12 Jan – 24 Feb (historically 61% of yearly burning)."*
- Show them as bands on the calendar and timeline. Report share of annual activity inside each window.

### 6.9 Activity status (one glance, for responders)
- Current status for the AOI as of the as-of date, from the §7.2 rule: `Normal` (≤ P90) · `Elevated` (Alert) · `Extreme` (Severe) · `No data`.
- One badge + one sentence. Same thresholds as the backtest, so status and replay always agree.

## 7. EDGE — "Would we have seen it coming?" (replay + backtest)

### 7.1 Time-travel replay (general feature, any AOI)
User picks an **as-of date**. The whole dashboard recomputes using only data with `solar_date ≤ as_of`. The timeline can auto-play day by day. This is what a responder *would have seen* on that day.

### 7.2 Alert rule (pre-registered, fixed before looking at 2022)
- Signal `S_d` = 7-day rolling sum of `H_d` in the AOI.
- Baseline: for each day-of-year, pool `S` values from **2003–2021** within ±15 days of that day-of-year. Thresholds `P90`, `P99` per day-of-year.
- **Alert:** `S_d > P90` for 3 consecutive days. **Severe:** `S_d > P99` for 3 consecutive days.
- Write the rule and parameters to `docs/METHODS.md` before running 7.3.

### 7.3 Corrientes 2022 backtest
- AOI: Corrientes province polygon (geoBoundaries ADM1).
- Find the first Alert and first Severe date in the 2021-11-01 → 2022-03-31 season.
- Compare with official markers (§11): provincial *emergencia ígnea* decree, provincial agricultural emergency decree, provincial ecological-disaster DNU, national emergency decree.
- Report **lead/lag in days** for each marker. Do not claim causality; report what the data showed and when.
- **Honesty check (required):** run the same rule for every fire season 2003–2021 in the same AOI. Report how many seasons triggered Alert/Severe, so judges can see the false-alarm rate. Show it as a small table: "This rule fired in X of 19 seasons; Severe in Y."
- Precompute and store results: `data/processed/backtest_corrientes_2022.json`.

### 7.4 UI hooks
Timeline with markers: alert dates (our rule) + decree dates (cited). A "Replay Corrientes 2022" button that sets AOI + as-of and plays from 2021-12-01.

---

## 8. Backend

### 8.1 Data files (read-only at runtime)
```
data/processed/detections.parquet      # normalized hotspots
data/processed/cell_day.parquet        # §5.2
data/processed/coverage.parquet        # §5.1
data/processed/cells.parquet           # cell_id, lat_c, lon_c, row, col
data/processed/calibration.json        # k_M, k_V per month + bootstrap CIs + validation metrics
data/processed/events.parquet          # §6.6 (whole region; filter by AOI at query time)
data/processed/backtest_corrientes_2022.json
data/boundaries/corrientes_adm1.geojson, corrientes_adm2.geojson
```

### 8.2 Endpoints
| Method | Path | Returns |
|---|---|---|
| GET | `/api/health` | ok + data freshness |
| GET | `/api/coverage` | coverage polygon, bbox, date span per sensor, last data date, missing-day counts |
| GET | `/api/presets` | preset AOIs (province, ADM2 departments, Iberá-area box if verified) with GeoJSON |
| POST | `/api/query` | body: `{aoi, start, end, as_of?, filters{min_conf, include_static, daynight}, baseline_years?}` → `{summary, calendar_monthly, calendar_daily?, climatology, peaks, current_vs_median, anomalies, counts, sensor_diff, provenance_legend}` |
| POST | `/api/events` | events in AOI + current-event comparison |
| POST | `/api/replay` | `{aoi, as_of}` → same as query but truncated at as_of + alert timeline |
| GET | `/api/backtest/corrientes-2022` | precomputed §7.3 |
| GET | `/api/methods` | calibration factors, CIs, validation metrics, alert rule |
| POST | `/api/export/hotspots.csv` | hotspots in AOI/date range with columns: sensor, platform, lat, lon, acq_utc, solar_date, conf_class, frp, cell_id, in_overlap_cell (bool) |
| POST | `/api/export/summary.csv` | monthly calendar + climatology + anomalies for the AOI |

`aoi` accepts either GeoJSON Polygon/MultiPolygon **or** `{lat, lon, radius_km}` (convert to a circle polygon server-side). Reject AOIs fully outside coverage with a clear message; clip partial ones and report the clipped fraction.

### 8.3 Performance
Point-in-polygon on cell centroids (shapely prepared geometry, or DuckDB spatial), then aggregate `cell_day`. Target < 1 s per query. Cache responses by (aoi hash, params).

### 8.4 Demo fallbacks
Precompute `/api/query`, `/api/events`, `/api/replay` (for a few as-of dates), and the backtest for the preset AOIs; write to `frontend/public/fallback/*.json`. Frontend uses them on API timeout (4 s) and shows a small "cached" badge.

---

## 9. Frontend — functional requirements (visual design comes in FRONTEND.md)

### 9.1 Audience lenses ("communities")
Same AOI, same data, different default views:

| Lens | Audience | Default panels |
|---|---|---|
| **Response Station** | early-warning, emergency responders, firefighters | Activity status badge (§6.9), now vs normal (§6.3), upcoming critical window (§6.8), current fire vs previous (§6.6), map of last 7 days, export card |
| **Research Lab** | scientists | Raw vs harmonized toggle + seam test, sensor differences (§6.7), calibration & validation (§5.4), CSV exports |
| **Ranger Post** | land managers | Burning calendar (§6.1), seasonal climatology & peaks (§6.2), multi-year anomalies (§6.4) |

### 9.2 Shared controls
- Area of interest: draw rectangle/polygon on the map, **or** enter lat/lon (+ radius), **or** pick a preset. Show the coverage boundary on the map.
- Date range: start/end inputs + timeline scrubber.
- As-of date (replay) with play/pause.
- Filters: confidence (include low?), include static sources, day/night.

### 9.3 Linked interactions
- Click a calendar cell → map shows that month's detections; timeline jumps there.
- Hover a calendar cell → exact value, provenance, coverage %.
- Raw ↔ harmonized toggle updates every chart.

### 9.4 Accessibility & honesty
- Colorblind-safe sequential ramp for the calendar (cividis/viridis-style); diverging colorblind-safe ramp for anomalies. Always show numbers on hover; legend with units ("burning cells per month").
- Estimated values visibly different (hatch/opacity) from observed; no-data cells hatched grey.
- Every panel has a one-line plain-language summary sentence generated from the numbers (template strings, not an LLM).

### 9.5 Exports (R11, R12)
CSV hotspots, CSV summary, PNG of calendar and charts (`html-to-image`), and a one-page PNG "field card" (AOI name, now vs normal, peak season, top years, current fire rank, data provenance).

---

## 10. Repo structure
```
emberline/
  CLAUDE.md
  FRONTEND.md                 # added later
  .env.example                # FIRMS_MAP_KEY=
  README.md                   # what, why, how to run, data credits, AI-use disclosure
  docs/METHODS.md             # harmonization, validation results, alert rule (pre-registered)
  pipeline/
    config.py                 # bbox, CELL_DEG, sources, dates, thresholds
    fetch_firms.py            # §4.2 resumable throttled fetcher
    fetch_boundaries.py
    normalize.py              # §4.3
    grid.py                   # §5.2 cell_day + coverage
    calibrate.py              # §5.4 factors, bootstrap, hold-out, stability, seam test
    events.py                 # §6.6
    backtest.py               # §7
    build_fallbacks.py        # §8.4
    run_all.py                # runs the whole pipeline in order, idempotent
  backend/
    app/main.py, app/analytics.py, app/aoi.py, app/models.py
    tests/
    Dockerfile
  frontend/
    (Vite React TS app)
    public/fallback/
  data/                       # git-ignored except small processed artifacts needed for deploy
```

---

## 11. Facts & sources for the problem statement (verify before the pitch)

| Fact | Source | Status |
|---|---|---|
| Province declared *emergencia ígnea* by Decree 167/2022 (6 months) | DNU 335/2022 text (Microjuris summary) | date reported as 1 Feb 2022 by press — **verify in Boletín Oficial** |
| Province declared agricultural emergency/disaster by Decree 200/2022, signed 7 Feb 2022, B.O. 9 Feb 2022, effective from 1 Jan 2022 | Microjuris LEG119492; Bichos de Campo | verified via 2 secondary sources |
| Province declared ecological & environmental disaster zone, DNU 335/2022, B.O. 22 Feb 2022 | Microjuris LEG119763 | verify primary |
| INTA Corrientes report (18 Feb 2022): burned area growing ~30,000 ha per day in recent days | cited inside DNU 335/2022 | verify primary |
| National *emergencia ígnea* across Argentina, Decree 6/2022, January 2022 (1 year); COFEMA declaration Dec 2021 | argentina.gob.ar fire reports (May/Dec 2022) | verify exact date |

Links:
- https://aldiaargentina.microjuris.com/2022/02/24/legislacion-incendios-se-declara-a-la-provincia-de-corrientes-zona-de-desastre-ecologico-y-ambiental-debido-a-los-estragos-ocasionados-en-la-fauna-la-flora-y-la-biodiversidad/
- https://aldiaargentina.microjuris.com/2022/02/11/legislacion-incendios-rurales-corrientes-declara-el-estado-de-emergencia-y-o-desastre-agropecuario-por-6-meses/
- https://bichosdecampo.com/?p=92816
- https://www.argentina.gob.ar/sites/default/files/2022/12/2_de_diciembre_-_reporte.pdf

Store verified markers in `pipeline/config.py` as `OFFICIAL_MARKERS = [{date, label, source_url, verified: bool}]`. The UI shows unverified markers with a dashed line and "(unverified)".

---

## 11b. Official references to use while building (from the challenge Resources link)
Challenge Resources tab → https://www.earthdata.nasa.gov/data/tools/firms . Use these to get the details right:
- Attribute tables (column meanings for the normalizer): https://www.earthdata.nasa.gov/data/tools/firms/active-fire-data-attributes-modis-viirs
- VIIRS 375 m Active Fire User Guide: https://viirsland.gsfc.nasa.gov/PDF/VIIRS_activefire_User_Guide.pdf
- MODIS C6/C6.1 Active Fire User Guide 1.0: https://www.earthdata.nasa.gov/s3fs-public/2023-09/MODIS_C6_C6.1_Fire_User_Guide_1.0.pdf
- Archive Download (fallback): https://firms.modaps.eosdis.nasa.gov/download/ · Web services: https://firms.modaps.eosdis.nasa.gov/web-services/
- Cite in METHODS/README: Giglio, Schroeder & Justice 2016 (MODIS C6 algorithm, doi:10.1016/j.rse.2016.02.054); Schroeder et al. 2014 (VIIRS 375 m algorithm, doi:10.1016/j.rse.2013.12.008); Davies et al. 2009 (FIRMS, doi:10.1109/TGRS.2008.2002076).
- Optional stretch only: HLS (Harmonized Landsat Sentinel-2) imagery for a visual burn-scar check of the Corrientes 2022 event. Not on the critical path.

## 12. Data credits (README + app footer + submission)
- NASA FIRMS — "We acknowledge the use of data and/or imagery from NASA's Fire Information for Resource Management System (FIRMS), part of NASA's Earth Science Data and Information System (ESDIS)." Verify current wording on the FIRMS site.
- MODIS Collection 6.1 Hotspot/Active Fire Detections MCD14ML — doi:10.5067/FIRMS/MODIS/MCD14ML
- MODIS C6.1 NRT MCD14DL — doi:10.5067/FIRMS/MODIS/MCD14DL.NRT.0061
- VIIRS 375 m S-NPP NRT VNP14IMGT — doi:10.5067/FIRMS/VIIRS/VNP14IMGT_NRT.002
- VIIRS 375 m NOAA-20 NRT VJ114IMGT — doi:10.5067/FIRMS/VIIRS/VJ114IMGT_NRT.002
- (Add the SP archive DOIs as listed on FIRMS for the products actually used.)
- Boundaries: geoBoundaries (CC BY 4.0). Basemap: OpenStreetMap contributors / CARTO.
- Disclose AI assistance in the submission form as required.

---

## 13. Milestones (in order; timebox in brackets)

| M | Deliverable | Done when |
|---|---|---|
| M0 [0.5 h] | Repo scaffold, `.env`, config, **start `fetch_firms.py` running** | fetch is running and resumable |
| M1 [1 h] | Boundaries + normalizer on first chunks | `detections.parquet` schema validated on partial data |
| M2 [1.5 h] | Grid, coverage, cell_day | tests pass: no dup keys, row conservation, missing≠zero |
| M3 [2 h] | Calibration + hold-out + stability + seam test | metrics written to METHODS.md; `calibration.json` |
| M4 [1.5 h] | Analytics module (§6.1–6.5, 6.7) + `/api/query`, exports | query on Corrientes returns full payload < 1 s |
| M5 [1.5 h] | Events (§6.6) + `/api/events` | ranking sentence produced for Corrientes 2022 |
| M6 [1.5 h] | Pre-register rule → backtest (§7) + `/api/replay` | backtest JSON incl. 2003–2021 honesty table |
| M7 [4 h] | Frontend functional build (§9) | all lenses, AOI draw + lat/lon, calendar, linked map, exports, replay |
| M8 [1 h] | Fallback JSON, deploy backend (HF Spaces) + frontend (Vercel), local backup | public URLs work in incognito + phone |
| M9 [1.5 h] | FRONTEND.md visual pass, README, METHODS, demo script, submission | submitted before deadline |

If time runs short, cut in this order: daily strip (6.1) → field card → events ranking pre-computation for ADM2 → NOAA-21 gap-fill. **Never cut:** harmonization checks, missing≠zero, calendar, current-vs-median, CSV export, backtest honesty table.

---

## 14. Tests (pytest, `backend/tests/` and `pipeline/tests/`)
- Normalizer: conf mapping, platform mapping, solar_date math (lon −58 → UTC−3h52m).
- Dedup: duplicate rows across chunks collapse to one.
- cell_day: unique (cell_id, solar_date); `Σ n_modis + Σ n_viirs` equals filtered detection count.
- Coverage: a day marked missing yields `null`, not 0, in calendar output.
- Calibration: factors are finite and > 0 for all 12 months; bootstrap CI contains point estimate.
- Analytics: month-to-date comparison uses equal day spans; ranks are 1-based and consistent.
- Events: two adjacent cells on consecutive days → one event; a 2-day gap → two events.
- API: AOI outside coverage → 400 with message; lat/lon+radius path works.

---

## 15. Demo script (3 minutes)
1. **Hook (20 s):** Corrientes, early 2022 — decrees and dates on screen (§11).
2. **Problem (20 s):** Research Lab → raw vs harmonized toggle: the naive record jumps when VIIRS arrives; harmonized does not. Sensor-difference panel shows why.
3. **Calendar (40 s):** Ranger Post → 25-year calendar, peak season, top years — 2022 stands out.
4. **Edge (60 s):** Response Station → "Replay Corrientes 2022": timeline plays from Dec 2021; alert fires on date X; decrees appear on dates Y, Z. Show the honesty table (how often the rule fired in other years).
5. **Any area (20 s):** draw a new AOI or type lat/lon → instant calendar, CSV + field card download.
6. **Close (20 s):** consistent, sensor-independent, honest about uncertainty; built entirely on open NASA FIRMS data.
