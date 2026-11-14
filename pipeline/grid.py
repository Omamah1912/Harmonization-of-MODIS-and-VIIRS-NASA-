"""§5.1 coverage mask, §5.2 grid + cell_day, inter-VIIRS check.

Outputs
  data/processed/cells.parquet                 cell_id,row,col,lat_c,lon_c,in_region
  data/processed/coverage.parquet              per solar_date: platform observed flags, VIIRS reference
  data/processed/cell_day/{variant}.parquet    per cell × solar_date (filtered detections)
  data/processed/inter_viirs.json              k_N20, k_N21 per month + decision
"""
from __future__ import annotations

import json
from datetime import date, timedelta
from itertools import product

import numpy as np
import pandas as pd
import shapely

from pipeline import config as C

PLATFORMS = ["Terra", "Aqua", "SNPP", "NOAA20", "NOAA21"]
PLATFORM_SOURCES = {
    "Terra": ("MODIS_SP", "MODIS_NRT"), "Aqua": ("MODIS_SP", "MODIS_NRT"),
    "SNPP": ("VIIRS_SNPP_SP", "VIIRS_SNPP_NRT"), "NOAA20": ("VIIRS_NOAA20_SP", "VIIRS_NOAA20_NRT"),
    "NOAA21": ("VIIRS_NOAA21_SP", "VIIRS_NOAA21_NRT"),
}
# Mission start dates where the FIRMS product range starts earlier than the platform
# (MODIS_SP begins with Terra in Nov 2000; Aqua MODIS data begin July 2002).
PLATFORM_START = {"Aqua": date(2002, 7, 4)}

# ------------------------------------------------------------------ variants
CONF = {"nominal": ("nominal", "high"), "all": ("low", "nominal", "high")}
DAYNIGHT = ("all", "D", "N")


def variant_id(min_conf: str = "nominal", include_static: bool = False, daynight: str = "all") -> str:
    return f"conf-{min_conf}_static-{int(include_static)}_dn-{daynight}"


DEFAULT_VARIANT = variant_id()
VARIANTS = [variant_id(c, s, d) for c, s, d in product(CONF, (False, True), DAYNIGHT)]


def apply_filters(det: pd.DataFrame, min_conf="nominal", include_static=False, daynight="all") -> pd.DataFrame:
    keep = det["conf_class"].isin(CONF[min_conf])
    if not include_static:
        keep &= det["type"].isna() | (det["type"] == 0)
    if daynight != "all":
        keep &= det["daynight"] == daynight
    return det[keep]


def parse_variant(v: str) -> dict:
    c, s, d = (p.split("-", 1)[1] for p in v.split("_"))
    return {"min_conf": c, "include_static": bool(int(s)), "daynight": d}


# ------------------------------------------------------------------ grid
def cell_rc(lat, lon, cell_deg=C.CELL_DEG):
    return np.floor(np.asarray(lat) / cell_deg).astype(int), np.floor(np.asarray(lon) / cell_deg).astype(int)


def cell_ids(rows, cols) -> np.ndarray:
    return np.char.add(np.char.add(np.asarray(rows).astype(str), "_"), np.asarray(cols).astype(str))


def build_cells(region_geom, cell_deg=C.CELL_DEG) -> pd.DataFrame:
    W, S, E, N = C.BBOX
    r0, c0 = cell_rc(S, W, cell_deg)
    r1, c1 = cell_rc(N, E, cell_deg)
    rr, cc = np.meshgrid(np.arange(r0, r1 + 1), np.arange(c0, c1 + 1), indexing="ij")
    rr, cc = rr.ravel(), cc.ravel()
    lat_c, lon_c = (rr + 0.5) * cell_deg, (cc + 0.5) * cell_deg
    df = pd.DataFrame({"cell_id": cell_ids(rr, cc), "row": rr, "col": cc, "lat_c": lat_c, "lon_c": lon_c})
    df["in_region"] = shapely.contains_xy(region_geom, lon_c, lat_c)
    return df


# ------------------------------------------------------------------ coverage
def fetched_days(source: str, src_max: date | None, manifest: dict | None = None) -> set[date]:
    """Dates covered by an INGESTED chunk of `source` (a header-only chunk still counts).
    Uses the normalizer's manifest so coverage and detections come from the same snapshot."""
    if manifest is not None:
        starts = sorted(date.fromisoformat(s) for s in manifest.get(source, []))
    else:
        d = C.RAW / source
        if not d.exists():
            return set()
        starts = sorted(date.fromisoformat(p.stem) for p in d.glob("*.csv"))
    out = set()
    for i, s in enumerate(starts):
        end = s + timedelta(days=C.DAY_RANGE - 1)
        if i + 1 < len(starts):
            end = min(end, starts[i + 1] - timedelta(days=1))
        if src_max:
            end = min(end, src_max)
        out.update(s + timedelta(days=k) for k in range((end - s).days + 1))
    return out


def build_coverage(avail: pd.DataFrame, missing: pd.DataFrame, fetched: dict[str, set[date]] | None = None,
                   end: date | None = None) -> pd.DataFrame:
    """Per solar_date: is each platform observed? (in mission range AND fetched AND not listed missing).

    Note: FIRMS missing-data dates are UTC dates; we apply them to the same solar date
    (≤ 4 h shift in this region) — documented approximation.
    """
    a = avail.set_index("data_id")
    rng = {}
    for p, srcs in PLATFORM_SOURCES.items():
        present = [s for s in srcs if s in a.index]
        lo = min(pd.Timestamp(a.loc[s, "min_date"]).date() for s in present)
        hi = max(pd.Timestamp(a.loc[s, "max_date"]).date() for s in present)
        rng[p] = (max(lo, PLATFORM_START.get(p, lo)), hi)
    start = min(lo for lo, _ in rng.values())
    end = end or max(hi for _, hi in rng.values())
    days = pd.date_range(start, end, freq="D").date
    cov = pd.DataFrame({"solar_date": days})
    miss = set(zip(pd.to_datetime(missing["date"]).dt.date, missing["platform"])) if len(missing) else set()
    for p in PLATFORMS:
        lo, hi = rng[p]
        f = None
        if fetched is not None:
            f = set().union(*(fetched.get(s, set()) for s in PLATFORM_SOURCES[p]))
        cov[p.lower()] = [
            (lo <= d <= hi) and (d, p) not in miss and (f is None or d in f) for d in days
        ]
    cov["modis_obs"] = cov["terra"] | cov["aqua"]
    cov["viirs_ref"] = np.select([cov["snpp"], cov["noaa20"], cov["noaa21"]], ["SNPP", "NOAA20", "NOAA21"],
                                 default=None)
    cov["viirs_obs"] = cov["viirs_ref"].notna()
    cov["era"] = np.select(
        [cov.modis_obs & cov.viirs_obs, cov.modis_obs, cov.viirs_obs], ["B", "A", "C"], default="none")
    return cov


# ------------------------------------------------------------------ cell_day
def build_cell_day(det: pd.DataFrame, cov: pd.DataFrame) -> pd.DataFrame:
    """One row per cell × solar_date with ≥1 (already filtered) detection.

    m = any MODIS detection; v = any detection by THAT day's VIIRS reference platform only.
    Per-platform counts are kept so the inter-VIIRS check and the Scientist lens can use them.
    """
    cols = ["cell_id", "solar_date", "m", "v", "n_modis", "n_viirs", "n_terra", "n_aqua", "n_snpp",
            "n_noaa20", "n_noaa21", "frp_sum", "frp_max"]
    if det.empty:
        return pd.DataFrame(columns=cols)
    r, c = cell_rc(det["lat"].to_numpy(), det["lon"].to_numpy())
    d = pd.DataFrame({"cell_id": cell_ids(r, c), "solar_date": det["solar_date"].to_numpy(),
                      "platform": det["platform"].to_numpy(), "frp": det["frp"].to_numpy()})
    for p in PLATFORMS:
        d[f"n_{p.lower()}"] = (d["platform"] == p).astype(np.int32)
    g = d.groupby(["cell_id", "solar_date"], sort=False).agg(
        n_terra=("n_terra", "sum"), n_aqua=("n_aqua", "sum"), n_snpp=("n_snpp", "sum"),
        n_noaa20=("n_noaa20", "sum"), n_noaa21=("n_noaa21", "sum"),
        frp_sum=("frp", "sum"), frp_max=("frp", "max")).reset_index()
    ref = cov.set_index("solar_date")["viirs_ref"]
    day_ref = g["solar_date"].map(ref)
    g["n_modis"] = g["n_terra"] + g["n_aqua"]
    g["n_viirs"] = np.select([day_ref == "SNPP", day_ref == "NOAA20", day_ref == "NOAA21"],
                             [g["n_snpp"], g["n_noaa20"], g["n_noaa21"]], default=0)
    g["m"] = g["n_modis"] > 0
    g["v"] = g["n_viirs"] > 0
    # drop cell-days that only exist because of a non-reference VIIRS platform
    g = g[g["m"] | g["v"] | (g[["n_snpp", "n_noaa20", "n_noaa21"]].sum(axis=1) > 0)]
    return g[cols].sort_values(["solar_date", "cell_id"]).reset_index(drop=True)


def inter_viirs(cd: pd.DataFrame, cov: pd.DataFrame, region_cells: set[str]) -> dict:
    """k = Σ higher-priority cells / Σ lower-priority cells per calendar month over shared observed days."""
    cd = cd[cd["cell_id"].isin(region_cells)]
    out = {}
    for name, hi, lo in (("k_N20", "snpp", "noaa20"), ("k_N21", "noaa20", "noaa21")):
        both = set(cov.loc[cov[hi] & cov[lo], "solar_date"])
        x = cd[cd["solar_date"].isin(both)]
        if x.empty:
            out[name] = {"months": {}, "apply": False, "note": "no overlap days with data"}
            continue
        month = pd.to_datetime(x["solar_date"]).dt.month
        hi_c = (x[f"n_{hi}"] > 0).groupby(month).sum()
        lo_c = (x[f"n_{lo}"] > 0).groupby(month).sum()
        k = {int(m): (float(hi_c[m] / lo_c[m]) if lo_c.get(m, 0) > 0 else None) for m in range(1, 13)
             if m in hi_c.index}
        vals = [v for v in k.values() if v is not None]
        overall = float(hi_c.sum() / lo_c.sum()) if lo_c.sum() else None
        # only months with enough cells decide (sparse months are dominated by noise)
        decisive = [k[m] for m in k if k[m] is not None and lo_c.get(m, 0) >= C.INTER_VIIRS_MIN_CELLS]
        apply = any(abs(v - 1) > C.INTER_VIIRS_TOLERANCE for v in decisive)
        days = sorted(both)
        out[name] = {"months": k, "overall": overall, "apply": apply, "overlap_days": len(days),
                     "overlap_start": str(days[0]) if days else None, "overlap_end": str(days[-1]) if days else None,
                     "cells_hi": int(hi_c.sum()), "cells_lo": int(lo_c.sum()),
                     "decisive_months": [m for m in k if lo_c.get(m, 0) >= C.INTER_VIIRS_MIN_CELLS],
                     "cells_lo_by_month": {int(m): int(lo_c.get(m, 0)) for m in k}}
    return out


def viirs_scale(cov: pd.DataFrame, iv: dict) -> pd.DataFrame:
    """Per-day multiplier for the VIIRS reference cells (1 for SNPP; k for NOAA-20/21 if the check failed)."""
    month = pd.to_datetime(cov["solar_date"]).dt.month
    scale = np.ones(len(cov))
    est = np.zeros(len(cov), dtype=bool)
    k20 = iv.get("k_N20", {})
    k21 = iv.get("k_N21", {})
    for i, (ref, m) in enumerate(zip(cov["viirs_ref"], month)):
        if ref == "NOAA20" and k20.get("apply"):
            scale[i] = k20["months"].get(m) or k20["overall"]
            est[i] = True
        elif ref == "NOAA21":
            f = 1.0
            if k21.get("apply"):
                f = k21["months"].get(m) or k21["overall"]
            if k20.get("apply"):
                f *= k20["months"].get(m) or k20["overall"]
            scale[i] = f
            est[i] = bool(k21.get("apply") or k20.get("apply"))
    cov = cov.copy()
    cov["viirs_scale"] = scale
    cov["viirs_scaled"] = est
    return cov


def main() -> None:
    import geopandas as gpd

    region = gpd.read_file(C.BOUNDARIES / "corrientes_adm1.geojson").geometry.iloc[0]
    cells = build_cells(region)
    cells.to_parquet(C.PROCESSED / "cells.parquet", index=False)
    region_cells = set(cells.loc[cells.in_region, "cell_id"])

    avail = pd.read_csv(C.RAW / "data_availability.csv")
    missing = pd.read_csv(C.RAW / "missing_days.csv")
    a = avail.set_index("data_id")
    manifest = json.loads((C.PROCESSED / "ingested_chunks.json").read_text())
    fetched = {s: fetched_days(s, pd.Timestamp(a.loc[s, "max_date"]).date() if s in a.index else None, manifest)
               for srcs in PLATFORM_SOURCES.values() for s in srcs}
    cov = build_coverage(avail, missing, fetched)

    det = pd.read_parquet(C.PROCESSED / "detections.parquet")
    out_dir = C.PROCESSED / "cell_day"
    out_dir.mkdir(exist_ok=True)
    for v in VARIANTS:
        cd = build_cell_day(apply_filters(det, **parse_variant(v)), cov)
        cd.to_parquet(out_dir / f"{v}.parquet", index=False)
        if v == DEFAULT_VARIANT:
            iv = inter_viirs(cd, cov, region_cells)
            cd.to_parquet(C.PROCESSED / "cell_day.parquet", index=False)
            print(f"default cell_day rows: {len(cd)}")
    cov = viirs_scale(cov, iv)
    cov.to_parquet(C.PROCESSED / "coverage.parquet", index=False)
    (C.PROCESSED / "inter_viirs.json").write_text(json.dumps(iv, indent=2))
    print("coverage eras:", cov["era"].value_counts().to_dict())
    print("VIIRS reference:", cov["viirs_ref"].value_counts(dropna=False).to_dict())
    for k, v in iv.items():
        print(k, {kk: vv for kk, vv in v.items() if kk != "months"})


if __name__ == "__main__":
    main()
