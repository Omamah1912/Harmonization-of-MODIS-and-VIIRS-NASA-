"""Unit tests for analytics math on hand-built fixtures (not demo data)."""
from datetime import date

import numpy as np
import pandas as pd

from backend.app.analytics import current_vs_median, monthly_table, ordinal
from pipeline.harmonize import daily_components, harmonize

K1 = {m: 1.0 for m in range(1, 13)}


def dh_from(values: dict[date, float | None]) -> pd.DataFrame:
    days = sorted(values)
    d = pd.DataFrame({"solar_date": days})
    d["H"] = [values[x] for x in days]
    d["H_low"] = d["H"]
    d["H_high"] = d["H"]
    d["provenance"] = np.where(d.H.isna(), "no data", "observed")
    d["year"] = pd.to_datetime(d.solar_date).dt.year
    d["month"] = pd.to_datetime(d.solar_date).dt.month
    for c in ["hot_modis", "hot_viirs", "M", "U"]:
        d[c] = d["H"]
    d["modis_obs"] = d.H.notna()
    d["viirs_obs"] = d.H.notna()
    return d


def test_month_to_date_uses_equal_spans_and_ranks():
    vals = {}
    for y in range(2015, 2021):
        for day in range(1, 31):
            # baseline year y has 1 cell/day on days 1..15 and 100/day afterwards (should be ignored)
            vals[date(y, 11, day)] = 1.0 * (y - 2014) if day <= 15 else 100.0
    for day in range(1, 16):
        vals[date(2021, 11, day)] = 10.0
    r = current_vs_median(dh_from(vals), date(2021, 11, 15), list(range(2015, 2021)))
    assert r["days_compared"] == 15
    assert r["baseline"]["2015"] == 15.0          # only days 1–15 were summed
    assert r["value"] == 150.0
    assert r["rank"] == 1 and r["n"] == 7         # 1-based, current year included
    assert "highest of 7" in r["sentence"]


def test_rank_is_consistent_middle():
    vals = {date(y, 3, 1): float(v) for y, v in zip(range(2010, 2015), [5, 1, 9, 3, 7])}
    vals[date(2015, 3, 1)] = 6.0
    r = current_vs_median(dh_from(vals), date(2015, 3, 1), list(range(2010, 2015)))
    assert r["rank"] == 3 and r["n"] == 6        # 9, 7 above → 3rd highest


def test_missing_day_is_null_not_zero_in_calendar():
    cov = pd.DataFrame({"solar_date": [date(2020, 1, d) for d in range(1, 32)]})
    cov["era"] = ["none"] * 31
    cov["modis_obs"] = cov["viirs_obs"] = False
    cov["viirs_ref"] = None
    cd = pd.DataFrame(columns=["cell_id", "solar_date", "m", "v", "n_modis", "n_viirs", "frp_sum"])
    daily = daily_components(cd, cov)
    dh = harmonize(daily, K1, K1)
    assert dh["H"].isna().all()
    mt = monthly_table(dh, date(2020, 3, 1))
    row = mt.iloc[0]
    assert pd.isna(row["value"]) and row["provenance"] == "no data" and row["coverage_pct"] == 0


def test_partial_coverage_month_flagged_incomplete():
    days = [date(2020, 1, d) for d in range(1, 32)]
    cov = pd.DataFrame({"solar_date": days, "era": ["B"] * 10 + ["none"] * 21})
    cov["modis_obs"] = cov["viirs_obs"] = cov.era == "B"
    cov["viirs_ref"] = np.where(cov.era == "B", "SNPP", None)
    cd = pd.DataFrame({"cell_id": ["0_0"], "solar_date": [date(2020, 1, 2)], "m": [True], "v": [False],
                       "n_modis": [1], "n_viirs": [0], "frp_sum": [1.0]})
    dh = harmonize(daily_components(cd, cov), K1, K1)
    mt = monthly_table(dh, date(2020, 3, 1))
    r = mt.iloc[0]
    assert r["value"] == 1 and bool(r["incomplete"]) and r["obs_days"] == 10


def test_ordinal():
    assert [ordinal(i) for i in (1, 2, 3, 4, 11, 12, 13, 21, 22)] == \
        ["1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd"]
