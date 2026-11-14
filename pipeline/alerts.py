"""§7.2 pre-registered alert rule — shared by backtest, replay and the activity-status badge (§6.9).

Parameters come ONLY from config.ALERT_RULE. Do not tune.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from pipeline import config as C

R = C.ALERT_RULE


def doy365(dates) -> np.ndarray:
    """Day of a 365-day year (Feb 29 shares Feb 28's slot)."""
    d = pd.to_datetime(pd.Series(dates))
    doy = d.dt.day_of_year.to_numpy()
    leap = d.dt.is_leap_year.to_numpy()
    return np.where(leap & (doy > 59), doy - 1, doy)


def signal(daily_h: pd.DataFrame) -> pd.DataFrame:
    """S_d = trailing 7-day sum of H. NaN if any day in the window has no data (missing ≠ zero)."""
    d = daily_h[["solar_date", "H"]].sort_values("solar_date").reset_index(drop=True)
    w = R["window_days"]
    d["S"] = d["H"].rolling(w, min_periods=w).sum()   # any NaN in window → NaN
    d["doy"] = doy365(d["solar_date"])
    d["year"] = pd.to_datetime(d["solar_date"]).dt.year
    return d


def doy_matrix(df: pd.DataFrame, col: str) -> np.ndarray:
    """years × 365 matrix of `col` indexed by doy365 (NaN where missing)."""
    years = np.sort(df["year"].unique())
    M = np.full((len(years), 365), np.nan)
    yi = np.searchsorted(years, df["year"].to_numpy())
    M[yi, df["doy"].to_numpy() - 1] = df[col].to_numpy(dtype=float)
    return M


def pooled(M: np.ndarray, halfwidth: int, q) -> np.ndarray:
    """For each doy, percentile(s) q of all values within ±halfwidth days (circular), ignoring NaN.
    Returns array (len(q), 365)."""
    off = np.arange(-halfwidth, halfwidth + 1)
    idx = (np.arange(365)[:, None] + off[None, :]) % 365          # (365, 2h+1)
    W = M[:, idx]                                                  # (years, 365, 2h+1)
    W = np.transpose(W, (1, 0, 2)).reshape(365, -1)                # (365, years*(2h+1))
    with np.errstate(all="ignore"):
        import warnings

        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            return np.nanpercentile(W, q, axis=1)


def thresholds(sig: pd.DataFrame) -> pd.DataFrame:
    """Per day-of-year P90/P99 of S pooled over baseline years within ±halfwidth days (circular)."""
    y0, y1 = R["baseline_years"]
    base = sig[(sig.year >= y0) & (sig.year <= y1) & sig.S.notna()]
    if base.empty:
        return pd.DataFrame({"doy": np.arange(1, 366), "n": 0, "P90": np.nan, "P99": np.nan, "median": np.nan})
    M = doy_matrix(base, "S")
    hw = R["doy_pool_halfwidth"]
    q = pooled(M, hw, [R["alert_percentile"], R["severe_percentile"], 50])
    off = np.arange(-hw, hw + 1)
    n = (~np.isnan(M[:, (np.arange(365)[:, None] + off[None, :]) % 365])).sum(axis=(0, 2))
    return pd.DataFrame({"doy": np.arange(1, 366), "n": n, "P90": q[0], "P99": q[1], "median": q[2]})


def _run_length(flag: np.ndarray) -> np.ndarray:
    out = np.zeros(len(flag), dtype=int)
    run = 0
    for i, f in enumerate(flag):
        run = run + 1 if f else 0
        out[i] = run
    return out


def evaluate(sig: pd.DataFrame, thr: pd.DataFrame) -> pd.DataFrame:
    """Adds P90/P99, exceedance flags, alert/severe (3 consecutive days) and status per day."""
    d = sig.merge(thr[["doy", "P90", "P99", "median"]], on="doy", how="left")
    k = R["consecutive_days"]
    over90 = (d.S > d.P90).fillna(False).to_numpy()
    over99 = (d.S > d.P99).fillna(False).to_numpy()
    d["over_p90"], d["over_p99"] = over90, over99
    d["alert"] = _run_length(over90) >= k
    d["severe"] = _run_length(over99) >= k
    d["status"] = np.select([d.S.isna() | d.P90.isna(), d.severe, d.alert], ["No data", "Extreme", "Elevated"], default="Normal")
    return d


def first_dates(ev: pd.DataFrame, start, end) -> dict:
    w = ev[(ev.solar_date >= pd.Timestamp(start).date()) & (ev.solar_date <= pd.Timestamp(end).date())]
    fa = w.loc[w.alert, "solar_date"]
    fs = w.loc[w.severe, "solar_date"]
    return {"first_alert": str(fa.iloc[0]) if len(fa) else None,
            "first_severe": str(fs.iloc[0]) if len(fs) else None,
            "alert_days": int(w.alert.sum()), "severe_days": int(w.severe.sum()),
            "no_data_days": int(w.S.isna().sum()), "peak_S": float(w.S.max()) if w.S.notna().any() else None,
            "peak_S_date": str(w.loc[w.S.idxmax(), "solar_date"]) if w.S.notna().any() else None}


STATUS_SENTENCE = {
    "Normal": "Burning over the last 7 days is within the usual range for this time of year (at or below the 90th percentile of 2003–2021).",
    "Elevated": "Burning has been above the 90th percentile for this time of year for at least 3 consecutive days.",
    "Extreme": "Burning has been above the 99th percentile for this time of year for at least 3 consecutive days.",
    "No data": "Satellite coverage is incomplete for the last 7 days (or there is no baseline for this date), so no status can be given.",
}
