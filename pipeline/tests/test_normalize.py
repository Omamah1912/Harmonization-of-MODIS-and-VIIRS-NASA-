import datetime as dt

import pandas as pd

from pipeline.normalize import dedup, normalize_frame, solar_date


def modis_raw():
    return pd.DataFrame({
        "latitude": [-28.5, -28.5, -29.0], "longitude": [-58.0, -58.0, -57.0],
        "brightness": [320.1, 320.1, 310.0], "scan": [1.0, 1.0, 2.0], "track": [1.0, 1.0, 1.5],
        "acq_date": ["2022-01-10", "2022-01-10", "2022-01-11"], "acq_time": ["0155", "0155", "1410"],
        "satellite": ["Terra", "Terra", "A"], "instrument": "MODIS", "confidence": ["29", "29", "85"],
        "version": "6.1", "bright_t31": 290.0, "frp": [10.0, 10.0, 25.0], "daynight": ["N", "N", "D"],
        "type": [0, 0, 2],
    })


def viirs_raw():
    return pd.DataFrame({
        "latitude": [-28.6], "longitude": [-58.1], "bright_ti4": [330.0], "scan": [0.4], "track": [0.4],
        "acq_date": ["2022-01-10"], "acq_time": ["1700"], "satellite": ["N"], "instrument": "VIIRS",
        "confidence": ["n"], "version": "2", "bright_ti5": 295.0, "frp": [5.0], "daynight": ["D"],
    })


def test_conf_and_platform_mapping():
    m = normalize_frame(modis_raw(), "MODIS_SP")
    assert list(m["conf_class"]) == ["low", "low", "high"]
    assert list(m["platform"]) == ["Terra", "Terra", "Aqua"]
    assert set(m["sensor"]) == {"MODIS"}
    v = normalize_frame(viirs_raw(), "VIIRS_SNPP_NRT")
    assert v["conf_class"].iloc[0] == "nominal"
    assert v["platform"].iloc[0] == "SNPP" and v["processing"].iloc[0] == "NRT"
    assert v["type"].isna().all()
    n20 = normalize_frame(viirs_raw().assign(satellite="N20"), "VIIRS_NOAA20_SP")
    assert n20["platform"].iloc[0] == "NOAA20"


def test_modis_conf_boundaries():
    raw = modis_raw().iloc[[0, 0, 0, 0]].assign(confidence=["0", "30", "79", "80"])
    assert list(normalize_frame(raw, "MODIS_SP")["conf_class"]) == ["low", "nominal", "nominal", "high"]


def test_solar_date_math():
    # lon -58 → offset -3h52m. 03:51 UTC → previous solar day; 03:53 UTC → same day.
    t = pd.Series(pd.to_datetime(["2022-01-10 03:51", "2022-01-10 03:53"]))
    lon = pd.Series([-58.0, -58.0])
    assert list(solar_date(t, lon)) == [dt.date(2022, 1, 9), dt.date(2022, 1, 10)]


def test_acq_utc_parsing():
    m = normalize_frame(modis_raw(), "MODIS_SP")
    assert m["acq_utc"].iloc[0] == pd.Timestamp("2022-01-10 01:55")
    assert m["solar_date"].iloc[0] == dt.date(2022, 1, 9)  # 01:55 UTC − 3h52 → 9 Jan
    assert m["pixel_km2"].iloc[2] == 3.0


def test_dedup_across_chunks_and_sp_nrt():
    a = normalize_frame(modis_raw(), "MODIS_SP")
    b = normalize_frame(modis_raw().iloc[[2]], "MODIS_NRT")
    d = dedup(pd.concat([a, b]))
    assert len(d) == 2
    assert (d["processing"] == "SP").all()
    assert d["det_id"].is_unique
