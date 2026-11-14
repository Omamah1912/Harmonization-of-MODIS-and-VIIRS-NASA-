from datetime import date

import pandas as pd

from pipeline.events import link_events


def cd(rows):
    return pd.DataFrame(rows, columns=["cell_id", "solar_date"])


def test_adjacent_consecutive_days_one_event():
    e = link_events(cd([("0_0", date(2022, 1, 1)), ("1_1", date(2022, 1, 2))]))
    assert e["event_id"].nunique() == 1


def test_two_day_gap_two_events():
    e = link_events(cd([("0_0", date(2022, 1, 1)), ("0_0", date(2022, 1, 3))]))
    assert e["event_id"].nunique() == 2


def test_non_adjacent_same_day_two_events():
    e = link_events(cd([("0_0", date(2022, 1, 1)), ("0_2", date(2022, 1, 1))]))
    assert e["event_id"].nunique() == 2


def test_chain_transitive_and_negative_ids():
    e = link_events(cd([("-1400_-2900", date(2022, 1, 1)), ("-1400_-2899", date(2022, 1, 1)),
                        ("-1400_-2898", date(2022, 1, 2)), ("-1500_-2900", date(2022, 1, 1))]))
    assert e["event_id"].nunique() == 2
    assert e.sort_values("solar_date")["event_id"].iloc[0] == 0
