"""§4.2 Resumable, throttled FIRMS area-API fetcher.

Usage:
    python -m pipeline.fetch_firms              # fetch everything
    python -m pipeline.fetch_firms --plan       # print plan only
    python -m pipeline.fetch_firms --only MODIS_SP --start 2021-11-01 --end 2022-03-31

Each chunk is cached as data/raw/{SOURCE}/{start_date}.csv (header-only files are valid:
they mean "no detections", which is different from "not fetched"). Re-running skips cached chunks.
The MAP_KEY is never printed: URLs are redacted in every log line.
"""
from __future__ import annotations

import argparse
import csv
import io
import threading
import time
from collections import deque
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timedelta

import pandas as pd
import requests

from pipeline import config as C

SESSION = requests.Session()
SESSION.headers["User-Agent"] = "emberline-spaceapps/0.1"


def redact(text: str, key: str) -> str:
    return text.replace(key, "***") if key else text


# ---------------------------------------------------------------- throttle
class DayBudget:
    """Sliding 10-minute window limiter, counted in day-transactions."""

    def __init__(self, max_days: int, window_s: int = 600):
        self.max_days, self.window_s = max_days, window_s
        self.events: deque[tuple[float, int]] = deque()
        self.lock = threading.Lock()

    def acquire(self, days: int) -> None:
        while True:
            with self.lock:
                now = time.time()
                while self.events and now - self.events[0][0] > self.window_s:
                    self.events.popleft()
                used = sum(d for _, d in self.events)
                if used + days <= self.max_days:
                    self.events.append((now, days))
                    return
                wait = self.window_s - (now - self.events[0][0]) + 1
            time.sleep(min(max(wait, 1), 30))


class ServerGate:
    """Second safety net: FIRMS's own transaction counter (mapkey_status). FIRMS charges ~2 transactions
    per requested day, so the local budget alone is not trusted. Blocks while usage is near the limit."""

    def __init__(self, key: str, ceiling: int, poll_s: int = 15):
        self.key, self.ceiling, self.poll_s = key, ceiling, poll_s
        self.lock = threading.Lock()
        self.last_t, self.last_used = 0.0, 0

    def wait(self) -> None:
        while True:
            with self.lock:
                if time.time() - self.last_t > self.poll_s:
                    try:
                        self.last_used = int(key_status(self.key).get("current_transactions", 0))
                    except Exception:
                        pass
                    self.last_t = time.time()
                if self.last_used < self.ceiling:
                    return
            time.sleep(20)


# ---------------------------------------------------------------- API helpers
def key_status(key: str) -> dict:
    r = SESSION.get(f"{C.FIRMS_BASE}/mapserver/mapkey_status/", params={"MAP_KEY": key}, timeout=30)
    r.raise_for_status()
    return r.json()


def availability(key: str) -> pd.DataFrame:
    r = SESSION.get(f"{C.FIRMS_BASE}/api/data_availability/csv/{key}/ALL", timeout=60)
    r.raise_for_status()
    df = pd.read_csv(io.StringIO(r.text))
    df.to_csv(C.RAW / "data_availability.csv", index=False)
    return df


def _d(s) -> date:
    return datetime.strptime(str(s)[:10], "%Y-%m-%d").date()


def plan_ranges(avail: pd.DataFrame) -> list[tuple[str, date, date]]:
    """SP up to its max date, NRT strictly after it (never double-load a date)."""
    a = avail.set_index("data_id")
    out = []
    for _, (sp, nrt) in C.SOURCES.items():
        sp_end = None
        if sp and sp in a.index:
            lo, hi = _d(a.loc[sp, "min_date"]), _d(a.loc[sp, "max_date"])
            out.append((sp, lo, hi))
            sp_end = hi
        if nrt and nrt in a.index:
            lo, hi = _d(a.loc[nrt, "min_date"]), _d(a.loc[nrt, "max_date"])
            if sp_end is not None:
                if lo > sp_end + timedelta(days=1):
                    print(f"[warn] gap between {sp} end {sp_end} and {nrt} start {lo}")
                lo = max(lo, sp_end + timedelta(days=1))
            if lo <= hi:
                out.append((nrt, lo, hi))
    return out


def chunks(source: str, lo: date, hi: date, step: int):
    d = lo
    while d <= hi:
        n = min(step, (hi - d).days + 1)
        yield source, d, n
        d += timedelta(days=n)


def chunk_path(source: str, start: date):
    return C.RAW / source / f"{start.isoformat()}.csv"


FAIL_LOCK = threading.Lock()


def log_failure(source: str, start: date, n: int, err: str) -> None:
    path = C.RAW / "failures.csv"
    with FAIL_LOCK:
        new = not path.exists()
        with open(path, "a", newline="", encoding="utf-8") as f:
            w = csv.writer(f)
            if new:
                w.writerow(["logged_utc", "source", "start_date", "day_range", "error"])
            w.writerow([datetime.utcnow().isoformat(timespec="seconds"), source, start, n, err[:300]])


GATE: ServerGate | None = None


def fetch_chunk(key: str, budget: DayBudget, source: str, start: date, n: int) -> str:
    path = chunk_path(source, start)
    if path.exists():
        return "cached"
    bbox = ",".join(str(x) for x in C.BBOX)
    url = f"{C.FIRMS_BASE}/api/area/csv/{key}/{source}/{bbox}/{n}/{start.isoformat()}"
    delay = 5
    last = ""
    attempt = 0
    while attempt < 5:
        budget.acquire(n * C.TRANSACTIONS_PER_DAY)
        if GATE:
            GATE.wait()
        try:
            r = SESSION.get(url, timeout=120)
            text = r.text
            if r.status_code >= 500:
                raise requests.HTTPError(f"HTTP {r.status_code}")
            if r.status_code != 200 or not text.lstrip().lower().startswith("latitude"):
                # FIRMS reports some errors as 200 + plain text (e.g. bad key, invalid range)
                last = f"HTTP {r.status_code}: {text.strip()[:200]}"
                if "exceed" in text.lower() or "limit" in text.lower():
                    time.sleep(60)  # rate limited: wait, does not count as an attempt
                    continue
                log_failure(source, start, n, redact(last, key))
                return "rejected"
            path.parent.mkdir(parents=True, exist_ok=True)
            tmp = path.with_suffix(".part")
            tmp.write_text(text, encoding="utf-8")
            tmp.replace(path)
            return "ok"
        except (requests.RequestException, OSError) as e:
            attempt += 1
            last = redact(str(e), key)
            time.sleep(delay)
            delay *= 2
    log_failure(source, start, n, last)
    return "failed"


def order_tasks(tasks):
    """Fetch the Corrientes 2021-22 season first (so M1+ can start), then the rest newest→oldest."""
    s0, s1 = (_d(x) for x in C.BACKTEST_SEASON)
    return sorted(tasks, key=lambda t: (not (s0 - timedelta(days=60) <= t[1] <= s1), -t[1].toordinal()))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--plan", action="store_true")
    ap.add_argument("--only", nargs="*")
    ap.add_argument("--start")
    ap.add_argument("--end")
    ap.add_argument("--day-range", type=int, default=C.DAY_RANGE)
    args = ap.parse_args()

    key = C.map_key()
    C.RAW.mkdir(parents=True, exist_ok=True)
    st = key_status(key)
    print("key status:", {k: v for k, v in st.items() if "key" not in k.lower()})
    avail = availability(key)
    ranges = plan_ranges(avail)
    for s, lo, hi in ranges:
        print(f"  {s:20s} {lo} -> {hi}  ({(hi - lo).days + 1} days)")
    if args.only:
        ranges = [r for r in ranges if r[0] in args.only]
    if args.start or args.end:
        lo_f = _d(args.start) if args.start else date.min
        hi_f = _d(args.end) if args.end else date.max
        ranges = [(s, max(lo, lo_f), min(hi, hi_f)) for s, lo, hi in ranges if max(lo, lo_f) <= min(hi, hi_f)]

    tasks = [t for s, lo, hi in ranges for t in chunks(s, lo, hi, args.day_range)]
    todo = [t for t in tasks if not chunk_path(t[0], t[1]).exists()]
    print(f"chunks: {len(tasks)} total, {len(todo)} to fetch, {sum(t[2] for t in todo)} day-transactions")
    if args.plan or not todo:
        return

    global GATE
    budget = DayBudget(C.MAX_TRANSACTIONS_PER_10MIN)
    GATE = ServerGate(key, C.SERVER_TX_CEILING)
    counts: dict[str, int] = {}
    rejected = []
    t0 = time.time()
    with ThreadPoolExecutor(C.FETCH_WORKERS) as ex:
        futs = {ex.submit(fetch_chunk, key, budget, *t): t for t in order_tasks(todo)}
        for i, f in enumerate(as_completed(futs), 1):
            res = f.result()
            counts[res] = counts.get(res, 0) + 1
            if res == "rejected" and futs[f][2] > 1:
                rejected.append(futs[f])
            if i % 50 == 0 or i == len(futs):
                print(f"[{i}/{len(futs)}] {counts} {time.time() - t0:.0f}s", flush=True)

    # fall back to DAY_RANGE=1 for rejected multi-day chunks
    if rejected:
        print(f"retrying {len(rejected)} rejected chunks with day_range=1")
        singles = [t for s, d, n in rejected for t in chunks(s, d, d + timedelta(days=n - 1), 1)]
        with ThreadPoolExecutor(C.FETCH_WORKERS) as ex:
            res = list(ex.map(lambda t: fetch_chunk(key, budget, *t), singles))
        print("single-day retry:", {r: res.count(r) for r in set(res)})


if __name__ == "__main__":
    main()
