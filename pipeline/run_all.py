"""Run the whole pipeline in order. Idempotent: the fetcher skips cached chunks; later steps rebuild outputs.

    python -m pipeline.run_all            # full
    python -m pipeline.run_all --no-fetch # rebuild from cached raw data only
"""
from __future__ import annotations

import argparse
import sys
import time


def step(name, fn):
    t = time.time()
    print(f"\n=== {name} ===", flush=True)
    fn()
    print(f"--- {name} done in {time.time() - t:.0f}s", flush=True)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-fetch", action="store_true")
    ap.add_argument("--no-fallbacks", action="store_true")
    a = ap.parse_args()
    from pipeline import (backtest, build_fallbacks, calibrate, events, fetch_boundaries, fetch_firms, fetch_missing,
                          grid, normalize)

    step("boundaries", fetch_boundaries.main)
    if not a.no_fetch:
        sys.argv = [sys.argv[0]]
        step("fetch FIRMS", fetch_firms.main)
        step("missing days", fetch_missing.main)
    step("normalize", normalize.main)
    step("grid + coverage", grid.main)
    step("calibrate", calibrate.main)
    step("events", events.main)
    step("backtest (pre-registered rule)", backtest.main)
    if not a.no_fallbacks:
        step("fallbacks", build_fallbacks.main)


if __name__ == "__main__":
    main()
