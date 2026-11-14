"""§6.6 Fire events (overlap level L4): link burning cell-days that are 8-neighbour adjacent and ≤ 1 day apart.

VIIRS era only (2012 →) so footprints are comparable. Uses harmonized presence (m ∨ v) on observed days.
Outputs
  data/processed/event_cells.parquet   cell_id, solar_date, event_id   (membership; AOI stats at query time)
  data/processed/events.parquet        whole-region event table
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from scipy.sparse import coo_matrix
from scipy.sparse.csgraph import connected_components

from pipeline import config as C

VIIRS_ERA_START = pd.Timestamp("2012-01-20").date()
OFFSETS = [(dr, dc, dt) for dt in (0, 1) for dr in (-1, 0, 1) for dc in (-1, 0, 1)
           if (dt, dr, dc) > (0, 0, 0)]  # half-neighbourhood: each pair is linked once


def _rc(cell_id: pd.Series):
    rc = cell_id.str.split("_", expand=True).astype(int)
    return rc[0].to_numpy(), rc[1].to_numpy()


def link_events(cd: pd.DataFrame) -> pd.DataFrame:
    """cd needs cell_id, solar_date. Returns cd[cell_id, solar_date] + event_id (0-based, by start date)."""
    cd = cd[["cell_id", "solar_date"]].drop_duplicates().reset_index(drop=True)
    if cd.empty:
        return cd.assign(event_id=pd.Series(dtype=int))
    r, c = _rc(cd["cell_id"])
    t = (pd.to_datetime(cd["solar_date"]) - pd.Timestamp("2000-01-01")).dt.days.to_numpy()
    # pack (r, c, t) into one int64 key; offsets keep values positive
    R, Cc = r + 10_000, c + 20_000
    key = (R.astype(np.int64) * 40_000 + Cc) * 20_000 + t
    index = pd.Series(np.arange(len(cd)), index=key)
    src, dst = [], []
    for dr, dc, dt in OFFSETS:
        k2 = ((R + dr).astype(np.int64) * 40_000 + (Cc + dc)) * 20_000 + (t + dt)
        hit = index.reindex(k2).to_numpy()
        ok = ~np.isnan(hit)
        src.append(np.nonzero(ok)[0])
        dst.append(hit[ok].astype(int))
    src, dst = np.concatenate(src), np.concatenate(dst)
    g = coo_matrix((np.ones(len(src)), (src, dst)), shape=(len(cd), len(cd)))
    _, labels = connected_components(g, directed=False)
    cd["event_id"] = labels
    # renumber by (start date, label) so ids are stable and chronological
    first = cd.groupby("event_id")["solar_date"].min().sort_values(kind="stable")
    remap = {old: new for new, old in enumerate(first.index)}
    cd["event_id"] = cd["event_id"].map(remap)
    return cd


def summarize(members: pd.DataFrame, cell_day: pd.DataFrame, cells: pd.DataFrame) -> pd.DataFrame:
    """Per-event stats from membership rows (optionally pre-filtered to an AOI / as-of date)."""
    cols = ["event_id", "start", "end", "duration_days", "peak_day", "peak_cells", "total_cell_days",
            "footprint_cells", "footprint_km2", "centroid_lat", "centroid_lon", "max_frp"]
    if members.empty:
        return pd.DataFrame(columns=cols)
    m = members.merge(cell_day[["cell_id", "solar_date", "frp_max"]], on=["cell_id", "solar_date"], how="left")
    m = m.merge(cells[["cell_id", "lat_c", "lon_c"]], on="cell_id", how="left")
    # approx cell area (km²) at the cell's latitude; this is a detection FOOTPRINT, not burned area
    m["area"] = (C.CELL_DEG * 111.32) ** 2 * np.cos(np.radians(m["lat_c"]))
    daily = m.groupby(["event_id", "solar_date"]).size().rename("n").reset_index()
    peak = daily.sort_values(["event_id", "n", "solar_date"], ascending=[True, False, True]) \
        .drop_duplicates("event_id").set_index("event_id")
    uniq = m.drop_duplicates(["event_id", "cell_id"])
    g = m.groupby("event_id")
    out = pd.DataFrame({
        "start": g["solar_date"].min(), "end": g["solar_date"].max(),
        "total_cell_days": g.size(), "max_frp": g["frp_max"].max(),
    })
    u = uniq.groupby("event_id")
    out["footprint_cells"] = u.size()
    out["footprint_km2"] = u["area"].sum().round(1)
    out["centroid_lat"] = u["lat_c"].mean().round(4)
    out["centroid_lon"] = u["lon_c"].mean().round(4)
    out["duration_days"] = (pd.to_datetime(out["end"]) - pd.to_datetime(out["start"])).dt.days + 1
    out["peak_day"] = peak["solar_date"]
    out["peak_cells"] = peak["n"]
    return out.reset_index()[cols]


def build(cd: pd.DataFrame, cov: pd.DataFrame) -> pd.DataFrame:
    obs = set(cov.loc[cov["era"] != "none", "solar_date"])
    x = cd[(cd["m"] | cd["v"]) & (cd["solar_date"] >= VIIRS_ERA_START) & cd["solar_date"].isin(obs)]
    return link_events(x)


def main() -> None:
    cd = pd.read_parquet(C.PROCESSED / "cell_day.parquet")
    cov = pd.read_parquet(C.PROCESSED / "coverage.parquet")
    cells = pd.read_parquet(C.PROCESSED / "cells.parquet")
    members = build(cd, cov)
    members.to_parquet(C.PROCESSED / "event_cells.parquet", index=False)
    ev = summarize(members, cd, cells)
    ev.to_parquet(C.PROCESSED / "events.parquet", index=False)
    print(f"{len(ev)} events from {len(members)} cell-days")
    print(ev.sort_values("footprint_cells", ascending=False).head(5).to_string(index=False))


if __name__ == "__main__":
    main()
