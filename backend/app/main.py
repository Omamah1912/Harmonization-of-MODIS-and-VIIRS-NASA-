"""Emberline API (§8). Read-only over precomputed Parquet/JSON in data/processed."""
from __future__ import annotations

import io
import json
import threading
import time
from collections import OrderedDict
from datetime import date
from functools import lru_cache

import duckdb
import geopandas as gpd
import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from backend.app import aoi as A
from backend.app.analytics import MONTHS, _f, ordinal, run_query
from pipeline import config as C
from pipeline.events import summarize
from pipeline.grid import DEFAULT_VARIANT, variant_id

def clean(o):
    """NaN/inf → null (missing ≠ zero), numpy/date types → JSON types."""
    if isinstance(o, dict):
        return {str(k): clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [clean(v) for v in o]
    if isinstance(o, (np.bool_,)):
        return bool(o)
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (float, np.floating)):
        return float(o) if np.isfinite(o) else None
    if isinstance(o, (date, pd.Timestamp)):
        return str(o)[:10]
    if o is pd.NA or o is pd.NaT:
        return None
    return o


class SafeJSON(JSONResponse):
    def render(self, content) -> bytes:
        return json.dumps(clean(content), ensure_ascii=False, separators=(",", ":")).encode("utf-8")


app = FastAPI(title="Emberline API", version="0.1", default_response_class=SafeJSON)
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


# ------------------------------------------------------------------ data
class Store:
    def __init__(self):
        P = C.PROCESSED
        self.cells = pd.read_parquet(P / "cells.parquet")
        self.cov = pd.read_parquet(P / "coverage.parquet")
        self.cal = json.loads((P / "calibration.json").read_text())
        self.iv = json.loads((P / "inter_viirs.json").read_text())
        self.cell_index = pd.Index(self.cells["cell_id"])
        self.members = self._with_cidx(pd.read_parquet(P / "event_cells.parquet"))
        self.events = pd.read_parquet(P / "events.parquet").set_index("event_id", drop=False)
        self.n_event_members = np.bincount(self.members["event_id"].to_numpy(), minlength=len(self.events))
        self.bt_path = P / "backtest_corrientes_2022.json"
        self.province = gpd.read_file(C.BOUNDARIES / "corrientes_adm1.geojson")
        self.deps = gpd.read_file(C.BOUNDARIES / "corrientes_adm2.geojson")
        self.coverage_geom = self.province.geometry.iloc[0].buffer(C.COVERAGE_BUFFER_DEG)
        self.det_path = (P / "detections.parquet").as_posix()
        self._cd: dict[str, pd.DataFrame] = {}
        self.last_day = self.cov.loc[self.cov.era != "none", "solar_date"].max()
        self.loaded_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    def _with_cidx(self, df: pd.DataFrame) -> pd.DataFrame:
        """Integer cell index → AOI selection by boolean mask instead of string isin (much faster)."""
        df = df.copy()
        df["cidx"] = self.cell_index.get_indexer(df["cell_id"]).astype(np.int32)
        return df

    def cell_day(self, variant: str) -> pd.DataFrame:
        if variant not in self._cd:
            p = C.PROCESSED / "cell_day" / f"{variant}.parquet"
            if not p.exists():
                raise HTTPException(400, f"unknown filter combination {variant}")
            self._cd[variant] = self._with_cidx(pd.read_parquet(p))
        return self._cd[variant]

    def mask(self, ids: set) -> np.ndarray:
        m = np.zeros(len(self.cells) + 1, dtype=bool)   # last slot = "not in grid" (cidx -1)
        m[self.cell_index.get_indexer(list(ids))] = True
        m[-1] = False
        return m


def select(df: pd.DataFrame, mask: np.ndarray) -> pd.DataFrame:
    return df[mask[df["cidx"].to_numpy()]]


@lru_cache(maxsize=1)
def store() -> Store:
    return Store()


# ------------------------------------------------------------------ models
class Filters(BaseModel):
    min_conf: str = Field("nominal", pattern="^(nominal|all)$")
    include_static: bool = False
    daynight: str = Field("all", pattern="^(all|D|N)$")


class QueryBody(BaseModel):
    aoi: dict
    start: date | None = None
    end: date | None = None
    as_of: date | None = None
    filters: Filters = Filters()
    baseline_years: list[int] | None = None


class ReplayBody(BaseModel):
    aoi: dict
    as_of: date
    filters: Filters = Filters()
    window_days: int = 150


# ------------------------------------------------------------------ helpers
_CACHE: OrderedDict[str, dict] = OrderedDict()


def _cache_get(key):
    if key in _CACHE:
        _CACHE.move_to_end(key)
        return _CACHE[key]
    return None


def _cache_put(key, val):
    _CACHE[key] = val
    while len(_CACHE) > 64:
        _CACHE.popitem(last=False)


def resolve_aoi(aoi: dict):
    s = store()
    try:
        geom = A.parse(aoi)
        clipped, frac = A.clip(geom, s.coverage_geom)
    except A.AOIError as e:
        raise HTTPException(400, str(e)) from e
    ids = A.cells_in(clipped, s.cells)
    if len(ids) == 0:
        raise HTTPException(400, "The area is too small: no 0.02° grid cell centre falls inside it. "
                                 "Draw a larger area (at least ~3 km across).")
    lat = clipped.centroid.y
    area = clipped.area * (111.32 ** 2) * np.cos(np.radians(lat))
    return clipped, set(ids), {"n_cells": int(len(ids)), "clipped_fraction": frac, "area_km2": round(float(area), 1)}


def _variant_cal(v: str) -> dict:
    s = store()
    return s.cal["variants"].get(v) or s.cal["variants"][DEFAULT_VARIANT]


_LOCK = threading.Lock()


def compute(body: QueryBody) -> dict:
    with _LOCK:   # one computation at a time; concurrent identical requests then hit the cache
        return _compute(body)


def _compute(body: QueryBody) -> dict:
    s = store()
    v = variant_id(body.filters.min_conf, body.filters.include_static, body.filters.daynight)
    as_of = min(body.as_of or s.last_day, s.last_day)
    end = min(body.end or as_of, as_of)
    start = body.start or date(2000, 11, 1)
    if start > end:
        raise HTTPException(400, "start must be before end")
    key = json.dumps({"a": A.aoi_hash(body.aoi), "v": v, "as_of": str(as_of), "s": str(start), "e": str(end),
                      "b": body.baseline_years})
    hit = _cache_get(key)
    if hit:
        return hit
    geom, ids, detail = resolve_aoi(body.aoi)
    cd_aoi = select(s.cell_day(v), s.mask(ids))
    res = run_query(cd_aoi=cd_aoi, cov=s.cov, cal=s.cal, variant_cal=_variant_cal(v), as_of=as_of, start=start,
                    end=end, baseline_years=body.baseline_years, detail={**detail, "variant": v})
    res["_ids"], res["_v"] = ids, v
    _cache_put(key, res)
    return res


def public(res: dict) -> dict:
    return {k: v for k, v in res.items() if not k.startswith("_")}


def events_for(ids: set, v: str, as_of: date, start: date | None = None, end: date | None = None) -> dict:
    s = store()
    inside = s.mask(ids)[s.members["cidx"].to_numpy()]
    eid = s.members["event_id"].to_numpy()
    n_in = np.bincount(eid[inside], minlength=len(s.n_event_members))
    ev_all = s.events
    started = (pd.to_datetime(ev_all["start"]) <= pd.Timestamp(as_of)).to_numpy()
    ended = (pd.to_datetime(ev_all["end"]) <= pd.Timestamp(as_of)).to_numpy()
    full = (n_in == s.n_event_members) & (n_in > 0) & ended          # precomputed stats are exact
    redo = (n_in > 0) & started & ~full                              # cut by the AOI edge or by as_of
    mem = s.members[inside & redo[eid]]
    mem = mem[mem.solar_date <= as_of].drop(columns="cidx")
    ev = pd.concat([ev_all[full].reset_index(drop=True),
                    summarize(mem, s.cell_day(DEFAULT_VARIANT), s.cells)], ignore_index=True)
    out = {"n_events": int(len(ev)), "since": "2012-01-20",
           "note": "Events are computed in the VIIRS era only (2012 →); MODIS-only footprints before 2012 are not "
                   "comparable. Footprint = area of ~2.2 km cells with detections, NOT burned area.",
           "filter_note": "Events always use the default filter (nominal+high confidence, vegetation fires)."}
    if ev.empty:
        out.update({"current": None, "top": [], "in_range": [], "sentence": "No fire events recorded here since 2012."})
        return out
    ev = ev.sort_values("footprint_cells", ascending=False).reset_index(drop=True)
    ev["rank_footprint"] = ev.footprint_cells.rank(ascending=False, method="min").astype(int)
    ev["rank_duration"] = ev.duration_days.rank(ascending=False, method="min").astype(int)
    # "current fire" = the largest event active during the last 7 days before as_of
    active = ev[pd.to_datetime(ev.end) >= pd.Timestamp(as_of) - pd.Timedelta(days=6)]
    if len(active):
        cur, kind = active.iloc[0], "largest recent (last 7 days)"
    else:
        cur, kind = ev.sort_values(["end", "footprint_cells"], ascending=[False, False]).iloc[0], "most recent"

    def row(r):
        return {k: (str(v) if isinstance(v, (date, pd.Timestamp)) else (_f(v, 4) if isinstance(v, float) else
                                                                         int(v) if isinstance(v, (np.integer,)) else v))
                for k, v in r.items()}

    rf = int(cur.rank_footprint)
    word = "largest" if rf == 1 else f"{ordinal(rf)} largest"
    out.update({
        "current": {**row(cur), "kind": kind},
        "sentence": (f"The {kind} fire event ({cur.start} → {cur.end}, footprint ≈ {cur.footprint_km2:,.0f} km²) is the "
                     f"{word} of {len(ev):,} fire events recorded here since 2012, and ranks "
                     f"{ordinal(int(cur.rank_duration))} by duration ({int(cur.duration_days)} "
                     f"day{'s' if int(cur.duration_days) != 1 else ''})."),
        "top": [row(r) for _, r in ev.head(20).iterrows()],
    })
    if start and end:
        rng = ev[(pd.to_datetime(ev.end) >= pd.Timestamp(start)) & (pd.to_datetime(ev.start) <= pd.Timestamp(end))]
        out["in_range"] = [row(r) for _, r in rng.head(200).iterrows()]
        out["n_in_range"] = int(len(rng))
    return out


# ------------------------------------------------------------------ endpoints
@app.get("/api/health")
def health():
    s = store()
    return {"ok": True, "last_data_day": str(s.last_day), "loaded_at": s.loaded_at, "region": C.REGION_NAME}


@app.get("/api/coverage")
def coverage():
    s = store()
    cov = s.cov
    span = {}
    for p in ["terra", "aqua", "snpp", "noaa20", "noaa21"]:
        d = cov.loc[cov[p], "solar_date"]
        span[p] = {"first": str(d.min()) if len(d) else None, "last": str(d.max()) if len(d) else None,
                   "observed_days": int(len(d))}
    return {
        "region": C.REGION_NAME, "bbox": C.BBOX,
        "polygon": json.loads(s.province.to_json()),
        "platforms": span, "last_data_day": str(s.last_day),
        "days_no_data": int((cov.era == "none").sum()),
        "days_modis_missing": int((~cov.modis_obs).sum()), "days_viirs_missing": int((~cov.viirs_obs).sum()),
        "eras": s.cal["eras"],
    }


@app.on_event("startup")
def warm() -> None:
    def _w():
        try:
            s = store()
            presets()
            geom = json.loads(s.province.to_json())["features"][0]["geometry"]
            compute(QueryBody(aoi=geom, start=date(2001, 1, 1)))
        except Exception as e:  # noqa: BLE001
            print("warm-up failed:", e)
    threading.Thread(target=_w, daemon=True).start()


@app.get("/api/presets")
@lru_cache(maxsize=1)
def presets():
    s = store()
    out = [{"id": "corrientes", "name": "Corrientes province", "kind": "province",
            "geometry": json.loads(s.province.to_json())["features"][0]["geometry"]}]
    for _, r in s.deps.iterrows():
        out.append({"id": "dep-" + r["name"].lower().replace(" ", "-"), "name": r["name"], "kind": "department",
                    "geometry": json.loads(gpd.GeoSeries([r.geometry]).simplify(0.002).to_json())["features"][0]["geometry"]})
    return {"presets": out, "note": "Department boundaries: geoBoundaries ARG ADM2 (San Luis del Palmar is missing "
                                    "from that dataset)."}


@app.post("/api/query")
def query(body: QueryBody):
    return public(compute(body))


@app.post("/api/events")
def events(body: QueryBody):
    s = store()
    res = compute(body)
    as_of = date.fromisoformat(res["summary"]["as_of"])
    return events_for(res["_ids"], res["_v"], as_of, date.fromisoformat(res["summary"]["start"]),
                      date.fromisoformat(res["summary"]["end"]))


@app.post("/api/replay")
def replay(body: ReplayBody):
    s = store()
    as_of = min(body.as_of, s.last_day)
    start = date.fromordinal(as_of.toordinal() - body.window_days)
    q = QueryBody(aoi=body.aoi, start=date(2000, 11, 1), end=as_of, as_of=as_of, filters=body.filters)
    res = compute(q)
    ev = res["_ev"]
    w = ev[(ev.solar_date >= start) & (ev.solar_date <= as_of)]
    fa = w.loc[w.alert, "solar_date"]
    fs = w.loc[w.severe, "solar_date"]
    out = public(res)
    out["replay"] = {
        "as_of": str(as_of), "window_start": str(start),
        "first_alert": str(fa.iloc[0]) if len(fa) else None, "first_severe": str(fs.iloc[0]) if len(fs) else None,
        "alert_timeline": [{"date": str(r.solar_date), "S": _f(r.S), "P90": _f(r.P90), "P99": _f(r.P99),
                            "status": r.status} for r in w.itertuples()],
        "markers": C.OFFICIAL_MARKERS,
    }
    out["events"] = events_for(res["_ids"], res["_v"], as_of)
    return out


@app.get("/api/backtest/corrientes-2022")
def backtest():
    s = store()
    if not s.bt_path.exists():
        raise HTTPException(503, "backtest not computed yet")
    return json.loads(s.bt_path.read_text(encoding="utf-8"))


@app.get("/api/methods")
def methods():
    s = store()
    c = s.cal
    return {"calibration": {k: c[k] for k in ["variant", "overlap_years", "fit_years_k_M", "fit_years_k_V", "fit_note",
                                              "k_M", "k_V", "k_M_ci", "k_V_ci", "pooled_k_M", "pooled_k_V",
                                              "months_filled_with_pooled", "eras"]},
            "holdout": c["holdout"], "stability": c["stability"], "seam_test": c["seam_test"],
            "inter_viirs": s.iv, "alert_rule": C.ALERT_RULE, "cell_deg": C.CELL_DEG, "shrink_n0": C.SHRINK_N0,
            "markers": C.OFFICIAL_MARKERS}


def _csv_response(df: pd.DataFrame, name: str):
    buf = io.StringIO()
    df.to_csv(buf, index=False)
    buf.seek(0)
    return StreamingResponse(iter([buf.getvalue()]), media_type="text/csv",
                             headers={"Content-Disposition": f'attachment; filename="{name}"'})


@app.post("/api/export/hotspots.csv")
def export_hotspots(body: QueryBody):
    s = store()
    _, ids, _ = resolve_aoi(body.aoi)
    as_of = min(body.as_of or s.last_day, s.last_day)
    end = min(body.end or as_of, as_of)
    start = body.start or date(2000, 11, 1)
    f = body.filters
    conf = ("'nominal','high'" if f.min_conf == "nominal" else "'low','nominal','high'")
    where = [f"conf_class IN ({conf})", "solar_date BETWEEN ? AND ?"]
    if not f.include_static:
        where.append("(type IS NULL OR type = 0)")
    if f.daynight != "all":
        where.append(f"daynight = '{f.daynight}'")
    cdv = s.cell_day(variant_id(f.min_conf, f.include_static, f.daynight))
    con = duckdb.connect()
    con.register("aoi_cells", pd.DataFrame({"cell_id": list(ids)}))
    con.register("cd", select(cdv, s.mask(ids))[["cell_id", "solar_date", "m", "v"]])
    sql = f"""
      WITH d AS (
        SELECT *, CAST(floor(lat / {C.CELL_DEG}) AS BIGINT) || '_' || CAST(floor(lon / {C.CELL_DEG}) AS BIGINT) AS cell_id
        FROM read_parquet('{s.det_path}') WHERE {' AND '.join(where)})
      SELECT d.sensor, d.platform, d.lat, d.lon, d.acq_utc, d.solar_date, d.daynight, d.conf_class, d.frp,
             d.source_product, d.cell_id, coalesce(cd.m AND cd.v, false) AS in_overlap_cell
      FROM d JOIN aoi_cells USING (cell_id)
      LEFT JOIN cd ON cd.cell_id = d.cell_id AND cd.solar_date = d.solar_date
      ORDER BY d.acq_utc"""
    df = con.execute(sql, [start, end]).df()
    return _csv_response(df, f"emberline_hotspots_{start}_{end}.csv")


MAX_POINTS = 15000


@app.post("/api/detections")
def detections(body: QueryBody):
    """Detections in the AOI for a (short) date range as GeoJSON, for the map. Capped at MAX_POINTS."""
    s = store()
    _, ids, _ = resolve_aoi(body.aoi)
    end = min(body.end or s.last_day, s.last_day)
    start = body.start or date.fromordinal(end.toordinal() - 6)
    if body.as_of:
        end = min(end, body.as_of)
    f = body.filters
    conf = ("'nominal','high'" if f.min_conf == "nominal" else "'low','nominal','high'")
    where = [f"conf_class IN ({conf})", "solar_date BETWEEN ? AND ?"]
    if not f.include_static:
        where.append("(type IS NULL OR type = 0)")
    if f.daynight != "all":
        where.append(f"daynight = '{f.daynight}'")
    con = duckdb.connect()
    con.register("aoi_cells", pd.DataFrame({"cell_id": list(ids)}))
    df = con.execute(f"""
      WITH d AS (SELECT sensor, platform, lat, lon, solar_date, frp,
          CAST(floor(lat / {C.CELL_DEG}) AS BIGINT) || '_' || CAST(floor(lon / {C.CELL_DEG}) AS BIGINT) AS cell_id
        FROM read_parquet('{s.det_path}') WHERE {' AND '.join(where)})
      SELECT d.* FROM d JOIN aoi_cells USING (cell_id) ORDER BY solar_date DESC LIMIT {MAX_POINTS + 1}""",
                     [start, end]).df()
    truncated = len(df) > MAX_POINTS
    df = df.head(MAX_POINTS)
    feats = [{"type": "Feature", "geometry": {"type": "Point", "coordinates": [round(r.lon, 4), round(r.lat, 4)]},
              "properties": {"sensor": r.sensor, "platform": r.platform, "date": str(r.solar_date),
                             "frp": _f(r.frp, 1)}} for r in df.itertuples()]
    return {"type": "FeatureCollection", "features": feats, "start": str(start), "end": str(end),
            "truncated": truncated, "n": len(feats)}


@app.post("/api/export/summary.csv")
def export_summary(body: QueryBody):
    res = compute(body)
    cal = pd.DataFrame(res["calendar_monthly"])
    clim = pd.DataFrame(res["climatology"]).rename(columns={"median": "clim_median", "p25": "clim_p25",
                                                            "p75": "clim_p75", "mean": "clim_mean"})
    an = pd.DataFrame(res["anomalies"]["monthly"])
    df = cal.merge(clim.drop(columns=["name"]), on="month", how="left")
    if len(an):
        df = df.merge(an, on=["year", "month"], how="left")
    df.insert(2, "month_name", df.month.map(lambda m: MONTHS[m - 1]))
    df["unit"] = "burning cells per month (0.02° cells with ≥1 active-fire detection, summed over days)"
    return _csv_response(df, "emberline_summary.csv")
