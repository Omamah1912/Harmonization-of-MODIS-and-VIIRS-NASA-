"""Shared harmonization math (§5.3, §5.4). Used by the pipeline AND the backend so both agree.

Daily components for a set of cells (region or AOI):
  M      = Σ m          cells with any MODIS detection
  V      = Σ v          cells seen by that day's VIIRS reference platform
  Monly  = Σ (m ∧ ¬v)
  U      = Σ (m ∨ v)    the union (= V + Monly)
  Vs     = s_d · V      VIIRS cells scaled to the SNPP reference (s_d = 1 unless the inter-VIIRS check failed)
  Us     = Vs + Monly   union with the scaled VIIRS part

Harmonized H_d by era:
  B (both observed)  : Us                       observed (estimated if s_d ≠ 1)
  A (MODIS only)     : k_M(month) · M           estimated
  C (VIIRS only)     : k_V(month) · Vs          estimated
  none               : NaN                      no data   (missing ≠ zero)
"""
from __future__ import annotations

import numpy as np
import pandas as pd


def daily_components(cd: pd.DataFrame, cov: pd.DataFrame) -> pd.DataFrame:
    """cd: cell_day rows already restricted to the cells of interest. Returns one row per coverage day."""
    if len(cd):
        g = cd.assign(monly=cd["m"] & ~cd["v"], u=cd["m"] | cd["v"],
                      n_hot_modis=cd["n_modis"], n_hot_viirs=cd["n_viirs"]).groupby("solar_date").agg(
            M=("m", "sum"), V=("v", "sum"), Monly=("monly", "sum"), U=("u", "sum"),
            hot_modis=("n_hot_modis", "sum"), hot_viirs=("n_hot_viirs", "sum"), frp=("frp_sum", "sum"))
    else:
        g = pd.DataFrame(columns=["M", "V", "Monly", "U", "hot_modis", "hot_viirs", "frp"])
    keep = ["solar_date", "era", "modis_obs", "viirs_obs", "viirs_ref", "viirs_scale", "viirs_scaled"]
    out = cov[[c for c in keep if c in cov.columns]].copy()
    if "viirs_scale" not in out:
        out["viirs_scale"], out["viirs_scaled"] = 1.0, False
    out = out.merge(g, left_on="solar_date", right_index=True, how="left")
    for c in ["M", "V", "Monly", "U", "hot_modis", "hot_viirs", "frp"]:
        out[c] = out[c].fillna(0).astype(float)
    # an unobserved sensor contributes nothing (and must not be read as zero downstream)
    out.loc[~out["modis_obs"], ["M", "hot_modis"]] = np.nan
    out.loc[~out["viirs_obs"], ["V", "hot_viirs"]] = np.nan
    out["Vs"] = out["V"] * out["viirs_scale"]
    out["Us"] = out["Vs"] + out["Monly"]
    out["month"] = pd.to_datetime(out["solar_date"]).dt.month
    out["year"] = pd.to_datetime(out["solar_date"]).dt.year
    return out


def harmonize(daily: pd.DataFrame, k_M: dict, k_V: dict, k_M_ci: dict | None = None,
              k_V_ci: dict | None = None) -> pd.DataFrame:
    """Adds H, H_low, H_high, provenance. k dicts are keyed by month 1..12; ci dicts map month → (lo, hi)."""
    d = daily.copy()
    m = d["month"]
    kM = m.map(lambda x: k_M[x]).astype(float)
    kV = m.map(lambda x: k_V[x]).astype(float)
    kM_lo = m.map(lambda x: (k_M_ci or {}).get(x, (k_M[x], k_M[x]))[0]).astype(float)
    kM_hi = m.map(lambda x: (k_M_ci or {}).get(x, (k_M[x], k_M[x]))[1]).astype(float)
    kV_lo = m.map(lambda x: (k_V_ci or {}).get(x, (k_V[x], k_V[x]))[0]).astype(float)
    kV_hi = m.map(lambda x: (k_V_ci or {}).get(x, (k_V[x], k_V[x]))[1]).astype(float)
    era = d["era"]
    H = np.select([era == "B", era == "A", era == "C"], [d["Us"], kM * d["M"], kV * d["Vs"]], default=np.nan)
    lo = np.select([era == "B", era == "A", era == "C"], [d["Us"], kM_lo * d["M"], kV_lo * d["Vs"]], default=np.nan)
    hi = np.select([era == "B", era == "A", era == "C"], [d["Us"], kM_hi * d["M"], kV_hi * d["Vs"]], default=np.nan)
    d["H"], d["H_low"], d["H_high"] = H, lo, hi
    d["provenance"] = np.select(
        [(era == "B") & ~d["viirs_scaled"].astype(bool), era == "B", era.isin(["A", "C"])],
        ["observed", "estimated", "estimated"], default="no data")
    return d


def monthly_sums(daily: pd.DataFrame, era: str = "B") -> pd.DataFrame:
    """Per (year, month) sums of U/M/V components over days of one era (for calibration)."""
    x = daily[daily["era"] == era]
    return x.groupby(["year", "month"])[["Us", "M", "Vs"]].sum().reset_index()


def fit_k(ms: pd.DataFrame, years=None) -> tuple[dict, dict]:
    """k_M(m) = Σ union / Σ M ;  k_V(m) = Σ union / Σ V over the given years."""
    x = ms if years is None else ms[ms["year"].isin(years)]
    s = x.groupby("month")[["Us", "M", "Vs"]].sum().reindex(range(1, 13), fill_value=0)
    kM = {int(m): (float(r.Us / r.M) if r.M > 0 else np.nan) for m, r in s.iterrows()}
    kV = {int(m): (float(r.Us / r.Vs) if r.Vs > 0 else np.nan) for m, r in s.iterrows()}
    return kM, kV


def fill_k(k: dict, fallback: float) -> dict:
    """Months with no data take the all-months pooled factor (documented)."""
    return {m: (v if v is not None and np.isfinite(v) else fallback) for m, v in k.items()}


def bootstrap_k(ms: pd.DataFrame, years: list[int], draws: int, seed: int) -> tuple[np.ndarray, np.ndarray]:
    """Year-block bootstrap. Returns arrays (draws, 12) for k_M and k_V."""
    rng = np.random.default_rng(seed)
    years = list(years)
    arr = {c: ms.pivot_table(index="year", columns="month", values=c, aggfunc="sum")
           .reindex(index=years, columns=range(1, 13)).fillna(0).to_numpy() for c in ["Us", "M", "Vs"]}
    idx = rng.integers(0, len(years), size=(draws, len(years)))
    U = arr["Us"][idx].sum(axis=1)
    M = arr["M"][idx].sum(axis=1)
    V = arr["Vs"][idx].sum(axis=1)
    with np.errstate(divide="ignore", invalid="ignore"):
        return U / M, U / V
