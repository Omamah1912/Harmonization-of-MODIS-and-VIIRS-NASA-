from datetime import date

import pandas as pd

from pipeline.grid import apply_filters, build_cell_day, build_coverage, cell_ids, cell_rc

AVAIL = pd.DataFrame({
    "data_id": ["MODIS_SP", "VIIRS_SNPP_SP", "VIIRS_NOAA20_SP", "VIIRS_NOAA21_SP"],
    "min_date": ["2022-01-01"] * 4, "max_date": ["2022-01-05"] * 4,
})


def det(rows):
    df = pd.DataFrame(rows, columns=["lat", "lon", "platform", "solar_date", "conf_class", "type", "daynight"])
    df["frp"] = 1.0
    df["solar_date"] = pd.to_datetime(df["solar_date"]).dt.date
    return df


def test_cell_ids_floor_negative():
    r, c = cell_rc([-28.001, -27.999], [-58.001, -57.999])
    assert list(cell_ids(r, c)) == ["-1401_-2901", "-1400_-2900"]


def test_coverage_missing_day_is_unobserved():
    miss = pd.DataFrame({"date": ["2022-01-03"], "platform": ["SNPP"]})
    cov = build_coverage(AVAIL, miss).set_index("solar_date")
    assert not cov.loc[date(2022, 1, 3), "snpp"]
    assert cov.loc[date(2022, 1, 3), "viirs_ref"] == "NOAA20"   # priority fallback
    assert cov.loc[date(2022, 1, 2), "viirs_ref"] == "SNPP"


def test_coverage_unfetched_day_is_unobserved():
    fetched = {"MODIS_SP": {date(2022, 1, 1)}}
    cov = build_coverage(AVAIL, pd.DataFrame(columns=["date", "platform"]), fetched).set_index("solar_date")
    assert cov.loc[date(2022, 1, 1), "modis_obs"]
    assert not cov.loc[date(2022, 1, 2), "modis_obs"]
    assert cov.loc[date(2022, 1, 2), "era"] == "none"


def test_cell_day_unique_and_conservation():
    cov = build_coverage(AVAIL, pd.DataFrame(columns=["date", "platform"]))
    d = det([
        (-28.001, -58.001, "Terra", "2022-01-01", "high", 0, "D"),
        (-28.002, -58.002, "Aqua", "2022-01-01", "nominal", 0, "D"),   # same cell, other platform (L3)
        (-28.0015, -58.0015, "SNPP", "2022-01-01", "nominal", None, "N"),  # same cell, VIIRS
        (-28.001, -58.001, "Terra", "2022-01-02", "high", 0, "D"),
        (-29.5, -57.5, "SNPP", "2022-01-02", "low", None, "N"),          # filtered (low conf)
        (-29.5, -57.5, "Terra", "2022-01-02", "high", 2, "D"),           # filtered (static)
    ])
    f = apply_filters(d)
    cd = build_cell_day(f, cov)
    assert not cd.duplicated(["cell_id", "solar_date"]).any()
    assert cd["n_modis"].sum() + cd["n_viirs"].sum() == len(f) == 4
    first = cd[cd.solar_date == date(2022, 1, 1)].iloc[0]
    assert first.m and first.v and first.n_modis == 2


def test_only_reference_viirs_counts():
    cov = build_coverage(AVAIL, pd.DataFrame(columns=["date", "platform"]))  # SNPP is reference every day
    d = det([(-28.0, -58.0, "NOAA20", "2022-01-01", "high", None, "D")])
    cd = build_cell_day(apply_filters(d), cov)
    assert not cd.v.any() and cd.n_viirs.sum() == 0 and cd.n_noaa20.sum() == 1
