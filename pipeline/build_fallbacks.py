"""§8.4 Precompute API responses for preset AOIs → frontend/public/fallback/*.json (real output, labelled cached)."""
from __future__ import annotations

import json
from datetime import date, timedelta

from fastapi.testclient import TestClient

from backend.app.main import app
from pipeline import config as C

OUT = C.ROOT / "frontend" / "public" / "fallback"
REPLAY_DATES = [date(2021, 12, 1) + timedelta(days=3 * i) for i in range(35)]  # matches the frontend replay stepping


def dump(name: str, obj) -> None:
    (OUT / f"{name}.json").write_text(json.dumps(obj, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def main(all_departments: bool = True) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    c = TestClient(app)
    for name, path in [("presets", "/api/presets"), ("coverage", "/api/coverage"), ("methods", "/api/methods"),
                       ("backtest", "/api/backtest/corrientes-2022")]:
        r = c.get(path)
        r.raise_for_status()
        dump(name, r.json())
    presets = c.get("/api/presets").json()["presets"]
    targets = presets if all_departments else presets[:1]
    for p in targets:
        body = {"aoi": p["geometry"], "start": "2001-01-01"}
        for kind in ("query", "events"):
            r = c.post(f"/api/{kind}", json=body)
            if r.status_code == 200:
                dump(f"{kind}_{p['id']}", r.json())
            else:
                print(f"[warn] {kind} {p['id']}: {r.status_code} {r.text[:120]}")
        print("fallback:", p["id"])
    corr = presets[0]["geometry"]
    for d in REPLAY_DATES:
        r = c.post("/api/replay", json={"aoi": corr, "as_of": str(d)})
        r.raise_for_status()
        dump(f"replay_corrientes_{d}", r.json())
    print(f"replay fallbacks: {len(REPLAY_DATES)} dates")


if __name__ == "__main__":
    main()
