"""§6 analytics for one AOI. Everything is derived from harmonized daily burning cells H_d.

Conventions
  * calendar / counts / sensor_diff / timeline are restricted to [start, end];
    climatology, baselines, thresholds and critical windows use the full history ≤ as_of.
  * as_of truncates ALL inputs (replay): nothing after as_of is used.
  * Missing ≠ zero: days with no coverage are NaN and are never summed as zero; months/periods report coverage.
"""
from __future__ import annotations

import calendar as cal_mod
from datetime import date, timedelta

import numpy as np
import pandas as pd

from pipeline import config as C
from pipeline.alerts import STATUS_SENTENCE, doy365, doy_matrix, evaluate, pooled, signal, thresholds
from pipeline.harmonize import daily_components, harmonize

MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split()
MERGE_GAP = 14     # critical windows: merge spans separated by ≤ 14 days
MIN_WINDOW = 10    # and drop spans shorter than 10 days (unless nothing else remains)


def _f(x, nd=2):
    if x is None or (isinstance(x, float) and not np.isfinite(x)) or pd.isna(x):
        return None
    return round(float(x), nd)


def ordinal(n: int) -> str:
    suf = "th" if 10 <= n % 100 <= 20 else {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")
    return f"{n}{suf}"


# ------------------------------------------------------------------ calibration for the AOI
def aoi_factors(daily: pd.DataFrame, cal: dict, variant_cal: dict) -> dict:
    """Shrink AOI factors toward the region: k = (n_aoi·k_aoi + n0·k_region)/(n_aoi + n0).

    n_aoi = MODIS (or VIIRS) cell-days in the AOI for that month over the fit years; k_aoi = Σ union / Σ cells.
    The region 90% CI is rescaled by k/k_region (documented approximation).
    """
    n0 = C.SHRINK_N0
    out = {"k_M": {}, "k_V": {}, "k_M_ci": {}, "k_V_ci": {}, "n_aoi_M": {}, "n_aoi_V": {}}
    b = daily[daily.era == "B"]
    for kind, col, years in (("M", "M", cal["fit_years_k_M"]), ("V", "Vs", cal["fit_years_k_V"])):
        x = b[b.year.isin(years)].groupby("month")[["Us", col]].sum().reindex(range(1, 13), fill_value=0)
        for m in range(1, 13):
            k_reg = float(variant_cal[f"k_{kind}"][str(m)] if str(m) in variant_cal[f"k_{kind}"]
                          else variant_cal[f"k_{kind}"][m])
            ci = variant_cal[f"k_{kind}_ci"].get(str(m), variant_cal[f"k_{kind}_ci"].get(m))
            n = float(x.loc[m, col])
            k = (float(x.loc[m, "Us"]) + n0 * k_reg) / (n + n0)
            s = k / k_reg if k_reg else 1.0
            out[f"k_{kind}"][m] = k
            out[f"k_{kind}_ci"][m] = (ci[0] * s, ci[1] * s)
            out[f"n_aoi_{kind}"][m] = int(n)
    return out


# ------------------------------------------------------------------ calendar
def monthly_table(dh: pd.DataFrame, as_of: date) -> pd.DataFrame:
    d = dh.copy()
    d["obs"] = d["H"].notna()
    d["est"] = d["provenance"].eq("estimated")
    g = d.groupby(["year", "month"])
    t = pd.DataFrame({
        "value": g["H"].sum(min_count=1), "low": g["H_low"].sum(min_count=1), "high": g["H_high"].sum(min_count=1),
        "obs_days": g["obs"].sum(), "est_days": g["est"].sum(),
        "hot_modis": g["hot_modis"].sum(min_count=1), "hot_viirs": g["hot_viirs"].sum(min_count=1),
        "modis_cells": g["M"].sum(min_count=1), "union_cells": g["U"].sum(min_count=1),
        "modis_days": g["modis_obs"].sum(), "viirs_days": g["viirs_obs"].sum(),
    }).reset_index()
    t["days_in_month"] = [cal_mod.monthrange(y, m)[1] for y, m in zip(t.year, t.month)]
    cur = (t.year == as_of.year) & (t.month == as_of.month)
    # in-progress month: coverage measured against days elapsed
    elapsed = np.where(cur, as_of.day, t["days_in_month"])
    t["coverage_pct"] = (t["obs_days"] / t["days_in_month"] * 100).round(1)
    t["coverage_elapsed_pct"] = (t["obs_days"] / elapsed * 100).round(1)
    t["in_progress"] = cur
    t["incomplete"] = (t["coverage_pct"] < C.INCOMPLETE_COVERAGE * 100) & ~cur
    t["provenance"] = np.select(
        [t.obs_days == 0, t.est_days == 0, t.est_days == t.obs_days], ["no data", "observed", "estimated"], "mixed")
    t.loc[t.obs_days == 0, ["value", "low", "high"]] = np.nan
    # naive raw series (for the raw ↔ harmonized toggle): MODIS hotspots, plus VIIRS hotspots once VIIRS exists
    t["raw_naive_hotspots"] = t["hot_modis"].fillna(0) + t["hot_viirs"].fillna(0)
    t.loc[t.hot_modis.isna() & t.hot_viirs.isna(), "raw_naive_hotspots"] = np.nan
    return t


def complete_years(mt: pd.DataFrame, as_of: date) -> list[int]:
    ok = mt[(mt.coverage_pct >= C.INCOMPLETE_COVERAGE * 100) & ~mt.in_progress].groupby("year").size()
    return sorted(int(y) for y, n in ok.items() if n == 12 and y < as_of.year)


def climatology(mt: pd.DataFrame, years: list[int]) -> pd.DataFrame:
    x = mt[mt.year.isin(years) & ~mt.incomplete]
    g = x.groupby("month")["value"]
    c = pd.DataFrame({"median": g.median(), "p25": g.quantile(0.25), "p75": g.quantile(0.75), "mean": g.mean(),
                      "n_years": g.count()}).reindex(range(1, 13))
    return c


def peaks(mt: pd.DataFrame, clim: pd.DataFrame, years: list[int]) -> dict:
    annual = mt[mt.year.isin(years)].groupby("year")["value"].sum(min_count=1).dropna()
    single = mt[~mt.incomplete & ~mt.in_progress & mt.value.notna()].nlargest(5, "value")
    moy = clim["median"].dropna().sort_values(ascending=False).head(5)
    return {
        "top_months_of_year": [{"month": int(m), "name": MONTHS[m - 1], "median": _f(v)} for m, v in moy.items()],
        "top_years": [{"year": int(y), "total": _f(v)} for y, v in annual.sort_values(ascending=False).head(5).items()],
        "top_single_months": [{"year": int(r.year), "month": int(r.month), "name": f"{MONTHS[r.month - 1]} {r.year}",
                               "value": _f(r.value), "provenance": r.provenance} for r in single.itertuples()],
        "sentence": (f"Peak season: {', '.join(MONTHS[m - 1] for m in moy.index[:3])} (highest median burning). "
                     f"Most active year: {int(annual.idxmax())}." if len(annual) and len(moy) else
                     "Not enough complete years to rank peaks."),
    }


# ------------------------------------------------------------------ month-to-date vs median
def current_vs_median(dh: pd.DataFrame, as_of: date, baseline_years: list[int]) -> dict:
    D = as_of.day
    month = as_of.month

    def mtd(y):
        last = min(D, cal_mod.monthrange(y, month)[1])
        s, e = date(y, month, 1), date(y, month, last)
        w = dh[(dh.solar_date >= s) & (dh.solar_date <= e)]
        n_obs = int(w.H.notna().sum())
        return (float(w.H.sum()) if n_obs else np.nan), n_obs, last

    val, n_obs, _ = mtd(as_of.year)
    base = {}
    for y in baseline_years:
        if y == as_of.year:
            continue
        v, n, last = mtd(y)
        if n >= C.INCOMPLETE_COVERAGE * last:
            base[y] = v
    out = {"as_of": str(as_of), "month": MONTHS[month - 1], "days_compared": D, "value": _f(val),
           "observed_days": n_obs, "baseline_years": sorted(base), "baseline": {str(k): _f(v) for k, v in base.items()}}
    if not base or np.isnan(val):
        out.update({"median": None, "ratio": None, "percentile": None, "rank": None, "n": None,
                    "sentence": f"Not enough data to compare {MONTHS[month - 1]} {as_of.year} with previous years."})
        return out
    vals = np.array(list(base.values()))
    med = float(np.median(vals))
    ratio = val / med if med > 0 else None
    rank = int(1 + (vals > val).sum())       # 1 = highest, ties share the better rank
    n = len(vals) + 1
    pct = float((vals <= val).mean() * 100)
    if ratio is None:
        level = "above a usual level of zero" if val > 0 else "at the usual level (none)"
    elif ratio >= 1.15:
        level = f"{ratio:.1f}× the usual level"
    elif ratio <= 0.85:
        level = f"{ratio:.1f}× the usual level (below normal)"
    else:
        level = "about the usual level"
    tail = "highest" if rank == 1 else ("lowest" if rank == n else f"{ordinal(rank)} highest")
    out.update({"median": _f(med), "ratio": _f(ratio), "percentile": _f(pct, 1), "rank": rank, "n": n,
                "sentence": f"So far this {MONTHS[month - 1]} (days 1–{D}): {level} — {tail} of {n} years."})
    return out


# ------------------------------------------------------------------ anomalies
def anomalies(mt: pd.DataFrame, clim: pd.DataFrame, years: list[int]) -> dict:
    x = mt.merge(clim[["median", "p25", "p75"]], left_on="month", right_index=True, how="left")
    iqr = (x.p75 - x.p25).replace(0, np.nan)
    x["ratio"] = np.where(x["median"] > 0, x.value / x["median"], np.nan)
    x["diff"] = x.value - x["median"]
    x["robust_z"] = (x.value - x["median"]) / iqr
    annual = mt.groupby("year").agg(total=("value", lambda v: v.sum(min_count=1)), months=("value", "count"),
                                    incomplete=("incomplete", "any"), in_progress=("in_progress", "any"))
    ref = annual.loc[annual.index.isin(years), "total"]
    mean = float(ref.mean()) if len(ref) else np.nan
    return {
        "monthly": [{"year": int(r.year), "month": int(r.month), "ratio": _f(r.ratio), "diff": _f(r.diff),
                     "robust_z": _f(r.robust_z)} for r in x.itertuples() if pd.notna(r.value)],
        "annual": [{"year": int(y), "total": _f(r.total), "vs_mean_ratio": _f(r.total / mean) if mean else None,
                    "vs_mean_diff": _f(r.total - mean), "complete": bool(y in years)}
                   for y, r in annual.iterrows()],
        "annual_mean": _f(mean), "reference_years": years,
    }


# ------------------------------------------------------------------ critical windows (§6.8)
def critical_windows(dh: pd.DataFrame, years: list[int]) -> dict:
    x = dh[dh.year.isin(years)][["solar_date", "H", "year"]].copy()
    if x.empty:
        return {"windows": [], "sentence": "Not enough complete years to find critical windows."}
    x["doy"] = doy365(x.solar_date)
    x = x.drop_duplicates(["year", "doy"])          # Feb 29 shares Feb 28's slot
    med = pooled(doy_matrix(x, "H"), 7, 50)
    p75 = float(np.nanpercentile(med, 75))
    hot = med > p75
    if p75 <= 0 or not hot.any():
        return {"windows": [], "curve": [_f(v) for v in med], "threshold": _f(p75),
                "sentence": "Burning here is too sparse to define a critical window."}
    # contiguous runs, wrapping around the new year
    runs, start = [], None
    for d in range(365):
        if hot[d] and start is None:
            start = d
        if not hot[d] and start is not None:
            runs.append([start, d - 1])
            start = None
    if start is not None:
        runs.append([start, 364])
    if len(runs) > 1 and runs[0][0] == 0 and runs[-1][1] == 364:
        runs[0][0] = runs[-1][0] - 365
        runs.pop()
    # merge spans separated by short dips (≤ MERGE_GAP days), then drop very short spans (noise)
    runs.sort()
    merged = []
    for r in runs:
        if merged and r[0] - merged[-1][1] - 1 <= MERGE_GAP:
            merged[-1][1] = max(merged[-1][1], r[1])
        else:
            merged.append(list(r))
    if len(merged) > 1 and (merged[0][0] + 365) - merged[-1][1] - 1 <= MERGE_GAP:  # wrap-around gap
        merged[0][0] = merged[-1][0] - 365
        merged.pop()
    long_ = [r for r in merged if r[1] - r[0] + 1 >= MIN_WINDOW]
    runs = long_ or merged
    total = x.groupby("doy")["H"].sum()
    tot = float(total.sum())
    ref = date(2001, 1, 1)
    wins = []
    for a, b in runs:
        doys = [((d % 365) + 1) for d in range(a, b + 1)]
        share = float(total.reindex(doys).sum() / tot) if tot else 0.0
        s = ref + timedelta(days=a % 365)
        e = ref + timedelta(days=b % 365)
        wins.append({"start_doy": (a % 365) + 1, "end_doy": (b % 365) + 1, "length_days": b - a + 1,
                     "start": s.strftime("%d %b"), "end": e.strftime("%d %b"), "share_of_annual": _f(share * 100, 1)})
    wins.sort(key=lambda w: -w["share_of_annual"])
    top = wins[0]
    return {"windows": wins, "threshold": _f(p75), "curve": [_f(v, 3) for v in med],
            "sentence": f"Critical window for this area: {top['start']} – {top['end']} "
                        f"(historically {top['share_of_annual']:.0f}% of yearly burning)."}


def upcoming_window(cw: dict, as_of: date) -> dict | None:
    if not cw.get("windows"):
        return None
    today = int(doy365([as_of])[0])
    best = None
    for w in cw["windows"]:
        s, e = w["start_doy"], w["end_doy"]
        inside = (s <= today <= e) if s <= e else (today >= s or today <= e)
        days_until = 0 if inside else (s - today) % 365
        cand = {**w, "active_now": inside, "days_until": days_until}
        if best is None or days_until < best["days_until"]:
            best = cand
    if best["active_now"]:
        best["sentence"] = f"We are inside this area's critical window ({best['start']} – {best['end']})."
    else:
        best["sentence"] = f"Next critical window starts in {best['days_until']} days ({best['start']} – {best['end']})."
    return best


# ------------------------------------------------------------------ sensor differences (§6.7)
def sensor_diff(cd_aoi: pd.DataFrame, dh: pd.DataFrame, start: date, end: date) -> dict:
    bdays = set(dh.loc[(dh.era == "B") & (dh.solar_date >= start) & (dh.solar_date <= end), "solar_date"])
    x = cd_aoi[cd_aoi.solar_date.isin(bdays)]
    both = x.m & x.v
    d = pd.DataFrame({"solar_date": x.solar_date, "both": both, "modis_only": x.m & ~x.v, "viirs_only": x.v & ~x.m})
    d["ym"] = pd.to_datetime(d.solar_date).dt.strftime("%Y-%m")
    monthly = d.groupby("ym")[["both", "modis_only", "viirs_only"]].sum().reset_index()
    tot = d[["both", "modis_only", "viirs_only"]].sum()
    m_tot = tot.both + tot.modis_only
    v_tot = tot.both + tot.viirs_only
    share = float(tot.both / m_tot) if m_tot else None
    return {
        "days_compared": len(bdays),
        "totals": {k: int(v) for k, v in tot.items()},
        "share_modis_cells_seen_by_viirs": _f(share * 100 if share is not None else None, 1),
        "share_viirs_cells_seen_by_modis": _f(tot.both / v_tot * 100 if v_tot else None, 1),
        "monthly": [{"month": r.ym, "both": int(r.both), "modis_only": int(r.modis_only),
                     "viirs_only": int(r.viirs_only)} for r in monthly.itertuples()],
        "sentence": (f"On days both sensors observed, VIIRS also saw {share * 100:.0f}% of MODIS burning cells, "
                     f"and saw {tot.viirs_only:,} cells MODIS missed — which is why raw counts can't simply be added."
                     if share is not None else "No days with both sensors in the selected range."),
    }


# ------------------------------------------------------------------ full query
def run_query(*, cd_aoi: pd.DataFrame, cov: pd.DataFrame, cal: dict, variant_cal: dict, as_of: date,
              start: date, end: date, baseline_years: list[int] | None, detail: dict) -> dict:
    cov = cov[cov.solar_date <= as_of]
    cd_aoi = cd_aoi[cd_aoi.solar_date <= as_of]
    daily = daily_components(cd_aoi, cov)
    k = aoi_factors(daily, cal, variant_cal)
    dh = harmonize(daily, k["k_M"], k["k_V"], k["k_M_ci"], k["k_V_ci"])
    mt = monthly_table(dh, as_of)
    years_all = complete_years(mt, as_of)
    years = [y for y in years_all if y in baseline_years] if baseline_years else years_all
    clim = climatology(mt, years)
    an = anomalies(mt, clim, years)
    in_range = (mt.year * 100 + mt.month >= start.year * 100 + start.month) & \
               (mt.year * 100 + mt.month <= end.year * 100 + end.month)
    cal_rows = []
    for r in mt[in_range].itertuples():
        cal_rows.append({"year": int(r.year), "month": int(r.month), "value": _f(r.value), "low": _f(r.low),
                         "high": _f(r.high), "provenance": r.provenance, "coverage_pct": _f(r.coverage_pct, 1),
                         "incomplete": bool(r.incomplete), "in_progress": bool(r.in_progress),
                         "raw_naive_hotspots": _f(r.raw_naive_hotspots, 0), "raw_modis_hotspots": _f(r.hot_modis, 0),
                         "raw_viirs_hotspots": _f(r.hot_viirs, 0), "modis_cells": _f(r.modis_cells, 0)})
    # alert rule for this AOI (same code as the backtest)
    sig = signal(dh)
    thr = thresholds(sig)
    ev = evaluate(sig, thr)
    now = ev[ev.solar_date <= as_of].tail(1)
    status = now.status.iloc[0] if len(now) else "No data"
    cw = critical_windows(dh, years)
    rng = dh[(dh.solar_date >= start) & (dh.solar_date <= end)]
    cdr = cd_aoi[(cd_aoi.solar_date >= start) & (cd_aoi.solar_date <= end)]
    counts = {
        "raw_hotspots": {"MODIS": int(cdr.n_modis.sum()), "VIIRS_reference": int(cdr.n_viirs.sum()),
                         "by_platform": {p: int(cdr[f"n_{p.lower()}"].sum())
                                         for p in ["Terra", "Aqua", "SNPP", "NOAA20", "NOAA21"]}},
        "burning_cell_days_harmonized": _f(rng.H.sum(), 1),
        "burning_cell_days_observed_union": int((cdr.m | cdr.v).sum()),
        "observed_days": int(rng.H.notna().sum()), "no_data_days": int(rng.H.isna().sum()),
        "note": "Raw hotspot counts are per sensor and are never added together; the harmonized count is burning "
                "cell-days (~2.2 km cells with a detection).",
    }
    tl = ev[(ev.solar_date >= start) & (ev.solar_date <= end)].merge(
        dh[["solar_date", "provenance", "H_low", "H_high"]], on="solar_date", how="left")
    r2 = lambda c: np.round(tl[c].to_numpy(dtype=float), 2).tolist()  # noqa: E731  (NaN → null in the JSON layer)
    timeline = {
        "date": [str(d) for d in tl.solar_date], "H": r2("H"), "S": r2("S"), "P90": r2("P90"), "P99": r2("P99"),
        "status": tl.status.tolist(), "provenance": tl.provenance.tolist(), "H_low": r2("H_low"), "H_high": r2("H_high"),
    }
    last_obs = dh.loc[dh.H.notna(), "solar_date"].max()
    eras = dh.groupby("era").solar_date.agg(["min", "max", "count"])
    handover = cov.loc[cov.viirs_ref.isin(["NOAA20", "NOAA21"]) & (cov.solar_date > date(2026, 1, 1)), "solar_date"]
    return {
        "summary": {
            "as_of": str(as_of), "start": str(start), "end": str(end), "last_observed_day": str(last_obs),
            "cells_in_aoi": detail.get("n_cells"), "area_km2": detail.get("area_km2"),
            "clipped_fraction": detail.get("clipped_fraction"), "complete_years": years_all,
            "baseline_years": years, "variant": detail.get("variant"),
            "status": {"level": status, "sentence": STATUS_SENTENCE[status],
                       "S": _f(now.S.iloc[0]) if len(now) else None, "P90": _f(now.P90.iloc[0]) if len(now) else None,
                       "P99": _f(now.P99.iloc[0]) if len(now) else None},
            "calibration_used": {"k_M": {m: _f(v, 3) for m, v in k["k_M"].items()},
                                 "k_V": {m: _f(v, 3) for m, v in k["k_V"].items()},
                                 "n_aoi_M": k["n_aoi_M"], "n_aoi_V": k["n_aoi_V"], "n0": C.SHRINK_N0},
            "eras": {e: {"first": str(r["min"]), "last": str(r["max"]), "days": int(r["count"])} for e, r in eras.iterrows()},
            "viirs_handover": {"snpp_last_data": str(cov.loc[cov.snpp, "solar_date"].max()) if cov.snpp.any() else None,
                               "noaa20_reference_from": str(handover.min()) if len(handover) else None},
        },
        "calendar_monthly": cal_rows,
        "climatology": [{"month": m, "name": MONTHS[m - 1], **{kk: _f(vv) for kk, vv in r.items()}}
                        for m, r in clim.iterrows()],
        "peaks": peaks(mt, clim, years),
        "current_vs_median": current_vs_median(dh, as_of, years),
        "anomalies": an,
        "counts": counts,
        "sensor_diff": sensor_diff(cd_aoi, dh, start, end),
        "critical_windows": cw,
        "upcoming_window": upcoming_window(cw, as_of),
        "timeline": timeline,
        "provenance_legend": {
            "observed": "Both MODIS and VIIRS observed the day; value = union of burning cells.",
            "estimated": "Only one sensor observed; value bridged with the calibration factor (band = 90% CI).",
            "mixed": "Month contains both observed and estimated days.",
            "no data": "No satellite coverage — not zero.",
            "cached": "Precomputed result shown because the live API did not respond.",
        },
        "_dh": dh, "_ev": ev,   # stripped before JSON; used by events/replay
    }
