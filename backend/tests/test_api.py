"""API tests against the real processed data (skipped if the pipeline has not been run)."""
import pytest

from pipeline import config as C

pytestmark = pytest.mark.skipif(not (C.PROCESSED / "calibration.json").exists(), reason="pipeline not run")


@pytest.fixture(scope="module")
def client():
    from fastapi.testclient import TestClient

    from backend.app.main import app

    return TestClient(app)


def test_health(client):
    r = client.get("/api/health")
    assert r.status_code == 200 and r.json()["ok"]


def test_aoi_outside_coverage_400(client):
    r = client.post("/api/query", json={"aoi": {"lat": -34.6, "lon": -58.4, "radius_km": 20}})  # Buenos Aires
    assert r.status_code == 400
    assert "outside the coverage" in r.json()["detail"]


def test_latlon_radius_query(client):
    r = client.post("/api/query", json={"aoi": {"lat": -28.5, "lon": -57.2, "radius_km": 25}})
    assert r.status_code == 200
    j = r.json()
    assert j["summary"]["cells_in_aoi"] > 100
    assert len(j["calendar_monthly"]) > 100
    assert j["current_vs_median"]["sentence"]


def test_partial_aoi_reports_clipped_fraction(client):
    r = client.post("/api/query", json={"aoi": {"lat": -27.3, "lon": -55.6, "radius_km": 40}})
    assert r.status_code == 200
    assert 0 < r.json()["summary"]["clipped_fraction"] < 1


def test_invalid_aoi_400(client):
    assert client.post("/api/query", json={"aoi": {"type": "Point", "coordinates": [0, 0]}}).status_code == 400


def test_province_query_fast(client):
    import time

    presets = client.get("/api/presets").json()["presets"]
    body = {"aoi": presets[0]["geometry"], "end": "2022-03-31", "as_of": "2022-03-31"}
    t = time.time()
    r = client.post("/api/query", json=body)
    assert r.status_code == 200
    assert time.time() - t < 3.0  # generous on CI; target < 1 s locally


def test_exports(client):
    body = {"aoi": {"lat": -28.5, "lon": -57.2, "radius_km": 25}, "start": "2022-02-01", "end": "2022-02-07"}
    r = client.post("/api/export/hotspots.csv", json=body)
    assert r.status_code == 200 and r.text.startswith("sensor,platform,lat,lon")
    r = client.post("/api/export/summary.csv", json=body)
    assert r.status_code == 200 and "unit" in r.text.splitlines()[0]


def test_events_and_replay(client):
    presets = client.get("/api/presets").json()["presets"]
    g = presets[0]["geometry"]
    r = client.post("/api/events", json={"aoi": g, "as_of": "2022-02-20"})
    assert r.status_code == 200
    j = r.json()
    assert j["n_events"] > 0 and j["current"] and "since 2012" in j["sentence"]
    r = client.post("/api/replay", json={"aoi": g, "as_of": "2022-02-20"})
    assert r.status_code == 200
    j = r.json()
    assert j["summary"]["as_of"] == "2022-02-20"
    assert all(t["date"] <= "2022-02-20" for t in j["replay"]["alert_timeline"])  # nothing after as_of
    assert j["timeline"]["date"][-1] <= "2022-02-20"


def test_methods_and_backtest(client):
    m = client.get("/api/methods").json()
    assert set(m["holdout"]) == {"k_M", "k_V"}
    r = client.get("/api/backtest/corrientes-2022")
    if r.status_code == 200:
        b = r.json()
        assert b["honesty"]["n_seasons"] == 19
        assert len(b["markers"]) == 4


def test_no_data_months_are_null_not_zero(client):
    j = client.post("/api/query", json={"aoi": {"lat": -28.5, "lon": -57.2, "radius_km": 25}}).json()
    for c in j["calendar_monthly"]:
        if c["provenance"] == "no data":
            assert c["value"] is None
