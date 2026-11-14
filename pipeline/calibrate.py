"""§5.4 calibration factors, bootstrap CIs, hold-out test, stability check, seam test.

Writes data/processed/calibration.json and the auto-generated block of docs/METHODS.md.
"""
from __future__ import annotations

import json

import numpy as np
import pandas as pd

from pipeline import config as C
from pipeline.grid import DEFAULT_VARIANT, VARIANTS
from pipeline.harmonize import (bootstrap_k, daily_components, fill_k, fit_k, harmonize, monthly_sums)

MIN_OBS_FOR_MAPE = 20     # monthly union cells; smaller months make MAPE meaningless
COMPLETE_B_DAYS = 300     # an overlap year counts as "complete" with ≥ 300 era-B days
DRIFT_TOL = 0.10


def load(variant: str = DEFAULT_VARIANT):
    cells = pd.read_parquet(C.PROCESSED / "cells.parquet")
    cov = pd.read_parquet(C.PROCESSED / "coverage.parquet")
    cd = pd.read_parquet(C.PROCESSED / "cell_day" / f"{variant}.parquet")
    region = set(cells.loc[cells.in_region, "cell_id"])
    return daily_components(cd[cd["cell_id"].isin(region)], cov)


def overlap_years(daily: pd.DataFrame) -> list[int]:
    n = daily[daily.era == "B"].groupby("year").size()
    return sorted(int(y) for y, c in n.items() if c >= COMPLETE_B_DAYS)


def ci_from_draws(draws: np.ndarray, point: dict) -> dict:
    lo = np.nanpercentile(draws, 5, axis=0)
    hi = np.nanpercentile(draws, 95, axis=0)
    # guarantee the interval contains the point estimate (bootstrap percentiles can exclude it on tiny samples)
    return {m: (float(min(lo[m - 1], point[m])), float(max(hi[m - 1], point[m]))) for m in range(1, 13)}


def factors(ms: pd.DataFrame, years_M: list[int], years_V: list[int], draws=C.BOOTSTRAP_DRAWS,
            seed=C.BOOTSTRAP_SEED) -> dict:
    kM, _ = fit_k(ms, years_M)
    _, kV = fit_k(ms, years_V)
    tot = ms[ms.year.isin(years_M)][["Us", "M"]].sum()
    totV = ms[ms.year.isin(years_V)][["Us", "Vs"]].sum()
    pooled_M = float(tot.Us / tot.M) if tot.M else 1.0
    pooled_V = float(totV.Us / totV.Vs) if totV.Vs else 1.0
    filled = {"k_M": [m for m, v in kM.items() if not np.isfinite(v)],
              "k_V": [m for m, v in kV.items() if not np.isfinite(v)]}
    kM, kV = fill_k(kM, pooled_M), fill_k(kV, pooled_V)
    bM, _ = bootstrap_k(ms, years_M, draws, seed)
    _, bV = bootstrap_k(ms, years_V, draws, seed + 1)
    bM = np.where(np.isfinite(bM), bM, pooled_M)
    bV = np.where(np.isfinite(bV), bV, pooled_V)
    return {"k_M": kM, "k_V": kV, "k_M_ci": ci_from_draws(bM, kM), "k_V_ci": ci_from_draws(bV, kV),
            "pooled_k_M": pooled_M, "pooled_k_V": pooled_V, "months_filled_with_pooled": filled}


def stability(ms: pd.DataFrame, years: list[int]) -> dict:
    y = ms[ms.year.isin(years)].groupby("year")[["Us", "M", "Vs"]].sum()
    kM = (y.Us / y.M).round(4)
    kV = (y.Us / y.Vs).round(4)
    early = kM[(kM.index >= 2012) & (kM.index <= 2019)].mean()
    late = kM[kM.index >= 2020].mean()
    drift = bool(np.isfinite(late) and abs(late / early - 1) > DRIFT_TOL)
    slope = float(np.polyfit(kM.index, kM.values, 1)[0]) if len(kM) > 2 else None
    return {"k_M_by_year": {int(k): float(v) for k, v in kM.items()},
            "k_V_by_year": {int(k): float(v) for k, v in kV.items()},
            "k_M_mean_2012_2019": float(early), "k_M_mean_2020_on": float(late) if np.isfinite(late) else None,
            "k_M_slope_per_year": slope, "drift_flag": drift}


def holdout(ms: pd.DataFrame, years: list[int], which: str) -> dict:
    col = "M" if which == "k_M" else "Vs"
    rows = []
    for Y in years:
        train = [y for y in years if y != Y]
        kM, kV = fit_k(ms, train)
        k = kM if which == "k_M" else kV
        bM, bV = bootstrap_k(ms, train, C.BOOTSTRAP_DRAWS, C.BOOTSTRAP_SEED + Y)
        b = bM if which == "k_M" else bV
        lo, hi = np.nanpercentile(b, 5, axis=0), np.nanpercentile(b, 95, axis=0)
        for _, r in ms[ms.year == Y].iterrows():
            m = int(r.month)
            if not np.isfinite(k[m]):
                continue
            rows.append({"year": Y, "month": m, "obs": r.Us, "pred": k[m] * r[col],
                         "lo": lo[m - 1] * r[col], "hi": hi[m - 1] * r[col]})
    df = pd.DataFrame(rows)
    big = df[df.obs >= MIN_OBS_FOR_MAPE]
    return {
        "n_months": int(len(df)), "n_months_for_mape": int(len(big)),
        "mape_pct": float((abs(big.pred - big.obs) / big.obs).mean() * 100) if len(big) else None,
        "bias_pct": float((df.pred.sum() / df.obs.sum() - 1) * 100),
        "pearson_r": float(np.corrcoef(df.pred, df.obs)[0, 1]),
        "interval_coverage_pct": float(((df.obs >= df.lo) & (df.obs <= df.hi)).mean() * 100),
        "by_year": df.groupby("year").apply(
            lambda g: {"obs": float(g.obs.sum()), "pred": float(g.pred.sum())}, include_groups=False).to_dict(),
    }


def seam_test(daily_h: pd.DataFrame) -> dict:
    """Naive splice vs harmonized across the 2012 VIIRS seam (annual, complete years)."""
    d = daily_h[(daily_h.year >= 2001) & (daily_h.year < pd.Timestamp.today().year)]
    viirs_year = 2012
    naive = d.groupby("year").apply(
        lambda g: float(g.hot_modis.sum() + (g.hot_viirs.sum() if g.name >= viirs_year else 0)),
        include_groups=False)
    harm = d.groupby("year")["H"].sum()
    modis_cells = d.groupby("year")["M"].sum()

    def step(s):
        before = s[(s.index >= 2007) & (s.index <= 2011)].mean()
        after = s[(s.index >= 2012) & (s.index <= 2016)].mean()
        return float(after / before) if before else None

    return {
        "annual": {int(y): {"naive_hotspots": naive[y], "harmonized_cells": float(harm[y]),
                            "modis_cells": float(modis_cells[y])} for y in harm.index},
        "step_ratio_2012_16_vs_2007_11": {"naive_hotspots": step(naive), "harmonized_cells": step(harm),
                                          "modis_only_cells (consistent sensor)": step(modis_cells)},
        "interpretation": ("A naive splice should jump at 2012 relative to the MODIS-only series "
                           "(the one sensor that is consistent across the seam); the harmonized series "
                           "should track the MODIS-only ratio."),
    }


def write_methods(cal: dict, iv: dict) -> None:
    from pipeline.methods_doc import update_methods

    update_methods(cal, iv)


def main() -> dict:
    daily = load()
    ms = monthly_sums(daily, "B")
    years = overlap_years(daily)
    stab = stability(ms, years)
    years_M = [y for y in years if y <= 2019] if stab["drift_flag"] else years
    f = factors(ms, years_M, years)
    dh = harmonize(daily, f["k_M"], f["k_V"], f["k_M_ci"], f["k_V_ci"])
    cal = {
        "variant": DEFAULT_VARIANT,
        "overlap_years": years,
        "fit_years_k_M": years_M,
        "fit_years_k_V": years,
        "fit_note": ("k_M fitted on 2012–2019 only because k_M drifted after 2020 (Terra orbit drift)"
                     if stab["drift_flag"] else "k_M and k_V fitted on all complete overlap years"),
        **f,
        "stability": stab,
        "holdout": {"k_M": holdout(ms, years_M, "k_M"), "k_V": holdout(ms, years, "k_V")},
        "seam_test": seam_test(dh),
        "variants": {},
        "eras": {e: {"days": int((daily.era == e).sum()),
                     "first": str(daily.loc[daily.era == e, "solar_date"].min()) if (daily.era == e).any() else None,
                     "last": str(daily.loc[daily.era == e, "solar_date"].max()) if (daily.era == e).any() else None}
                 for e in ["A", "B", "C", "none"]},
    }
    for v in VARIANTS:
        if v == DEFAULT_VARIANT:
            cal["variants"][v] = {k: f[k] for k in ["k_M", "k_V", "k_M_ci", "k_V_ci"]}
            continue
        dv = load(v)
        msv = monthly_sums(dv, "B")
        fv = factors(msv, years_M, years, draws=200)
        cal["variants"][v] = {k: fv[k] for k in ["k_M", "k_V", "k_M_ci", "k_V_ci"]}
    (C.PROCESSED / "calibration.json").write_text(json.dumps(cal, indent=2, default=float))
    iv = json.loads((C.PROCESSED / "inter_viirs.json").read_text())
    write_methods(cal, iv)
    print("overlap years:", years, "| drift:", stab["drift_flag"])
    print("k_M:", {m: round(v, 3) for m, v in f["k_M"].items()})
    print("k_V:", {m: round(v, 3) for m, v in f["k_V"].items()})
    for k in ["k_M", "k_V"]:
        h = cal["holdout"][k]
        print(f"holdout {k}: MAPE {h['mape_pct']:.1f}% bias {h['bias_pct']:.1f}% r {h['pearson_r']:.3f} "
              f"cov90 {h['interval_coverage_pct']:.0f}%")
    print("seam:", cal["seam_test"]["step_ratio_2012_16_vs_2007_11"])
    return cal


if __name__ == "__main__":
    main()
