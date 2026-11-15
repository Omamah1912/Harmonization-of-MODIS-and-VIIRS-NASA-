import json
import math

import pytest

from pipeline import config as C

P = C.PROCESSED / "calibration.json"
pytestmark = pytest.mark.skipif(not P.exists(), reason="calibration not run")


def test_factors_finite_positive_and_ci_contains_point():
    cal = json.loads(P.read_text(encoding="utf-8"))
    for k in ("k_M", "k_V"):
        for m in range(1, 13):
            v = cal[k][str(m)]
            lo, hi = cal[f"{k}_ci"][str(m)]
            assert math.isfinite(v) and v > 0
            assert lo <= v <= hi
