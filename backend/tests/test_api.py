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
