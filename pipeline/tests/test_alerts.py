from datetime import date, timedelta

import numpy as np
import pandas as pd

from pipeline.alerts import doy365, evaluate, signal, thresholds


def dh(values, start=date(2003, 1, 1)):
    return pd.DataFrame({"solar_date": [start + timedelta(days=i) for i in range(len(values))], "H": values})


def test_signal_is_trailing_7day_sum_and_nan_on_missing():
    s = signal(dh([1.0] * 10 + [np.nan] + [1.0] * 10))
    assert np.isnan(s.S.iloc[5]) and s.S.iloc[6] == 7
    assert np.isnan(s.S.iloc[10]) and np.isnan(s.S.iloc[16]) and s.S.iloc[17] == 7


def test_alert_needs_three_consecutive_days_above_p90():
    # baseline years 2003–2021 of constant 1/day → S = 7 everywhere → P90 = P99 = 7
    days = (date(2022, 1, 1) - date(2003, 1, 1)).days
    vals = [1.0] * days + [1.0] * 10 + [5.0, 5.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 5.0, 5.0, 5.0]
    d = dh(vals)
    ev = evaluate(signal(d), thresholds(signal(d)))
    tail = ev[ev.solar_date >= date(2022, 1, 1)].reset_index(drop=True)
    # two-day spike: S above P90 for 7 days after the spike? S stays elevated while the spike is in the window
    first = tail.loc[tail.alert, "solar_date"].iloc[0]
    over = tail.loc[tail.over_p90, "solar_date"]
    assert first == over.iloc[2]   # alert date = 3rd consecutive exceedance day
    assert (tail.status[tail.alert & ~tail.severe] == "Elevated").all()


def test_no_baseline_means_no_data_status():
    d = dh([1.0] * 30, start=date(2024, 1, 1))  # no 2003–2021 data
    ev = evaluate(signal(d), thresholds(signal(d)))
    assert (ev.status == "No data").all()


def test_doy365_leap_day():
    assert list(doy365([date(2024, 2, 28), date(2024, 2, 29), date(2024, 3, 1), date(2023, 3, 1)])) == [59, 59, 60, 60]
