"""§4.3 Normalize raw FIRMS CSVs (area API chunks or archive downloads) → detections.parquet."""
from __future__ import annotations

import hashlib
from pathlib import Path

import geopandas as gpd
import numpy as np
import pandas as pd

from pipeline import config as C

SCHEMA = [
    "det_id", "sensor", "platform", "lat", "lon", "acq_utc", "solar_date", "daynight",
    "conf_class", "conf_raw", "frp", "bright", "pixel_km2", "type", "source_product", "processing",
]

SOURCE_PLATFORM = {"VIIRS_SNPP": "SNPP", "VIIRS_NOAA20": "NOAA20", "VIIRS_NOAA21": "NOAA21"}
MODIS_SAT = {"T": "Terra", "TERRA": "Terra", "A": "Aqua", "AQUA": "Aqua"}
VIIRS_SAT = {"N": "SNPP", "NPP": "SNPP", "SNPP": "SNPP", "SUOMI NPP": "SNPP", "1": "NOAA20",
             "N20": "NOAA20", "NOAA20": "NOAA20", "NOAA-20": "NOAA20", "J1": "NOAA20",
             "N21": "NOAA21", "NOAA21": "NOAA21", "NOAA-21": "NOAA21", "J2": "NOAA21"}


def modis_conf(x: pd.Series) -> pd.Series:
    v = pd.to_numeric(x, errors="coerce")
    return pd.Series(np.select([v < 30, v < 80, v >= 80], ["low", "nominal", "high"], default=None),
                     index=x.index)


def viirs_conf(x: pd.Series) -> pd.Series:
    m = {"l": "low", "low": "low", "n": "nominal", "nominal": "nominal", "h": "high", "high": "high"}
    return x.astype(str).str.strip().str.lower().map(m)


def solar_date(acq_utc: pd.Series, lon: pd.Series) -> pd.Series:
    """Local solar date: acq_utc + lon/15 hours (lon −58 → UTC −3h52m)."""
    return (acq_utc + pd.to_timedelta(lon / 15.0, unit="h")).dt.date


def det_ids(df: pd.DataFrame) -> pd.Series:
    keys = (df["platform"] + "|" + df["lat"].round(5).astype(str) + "|" + df["lon"].round(5).astype(str)
            + "|" + df["acq_utc"].dt.strftime("%Y%m%dT%H%M"))
    return keys.map(lambda k: hashlib.sha1(k.encode()).hexdigest()[:16])


def normalize_frame(raw: pd.DataFrame, source_product: str) -> pd.DataFrame:
    """Map one raw FIRMS frame (any sensor) into the common schema. No dedup/clipping here."""
    raw = raw.rename(columns=str.lower)
    if raw.empty:
        return pd.DataFrame(columns=SCHEMA)
    sp = source_product.upper()
    is_modis = sp.startswith("MODIS") or "brightness" in raw.columns
    out = pd.DataFrame(index=raw.index)
    out["sensor"] = "MODIS" if is_modis else "VIIRS"
    sat = raw.get("satellite", pd.Series("", index=raw.index)).astype(str).str.strip().str.upper()
    if is_modis:
        out["platform"] = sat.map(MODIS_SAT)
    else:
        fixed = next((p for k, p in SOURCE_PLATFORM.items() if sp.startswith(k)), None)
        out["platform"] = fixed if fixed else sat.map(VIIRS_SAT)
    out["lat"] = pd.to_numeric(raw["latitude"], errors="coerce")
    out["lon"] = pd.to_numeric(raw["longitude"], errors="coerce")
    t = pd.to_numeric(raw["acq_time"], errors="coerce").fillna(0).astype(int)
    out["acq_utc"] = (pd.to_datetime(raw["acq_date"].astype(str).str[:10])
                      + pd.to_timedelta(t // 100, unit="h") + pd.to_timedelta(t % 100, unit="m"))
    out["solar_date"] = solar_date(out["acq_utc"], out["lon"])
    out["daynight"] = raw.get("daynight", pd.Series(None, index=raw.index))
    out["conf_raw"] = raw["confidence"].astype(str)
    out["conf_class"] = modis_conf(raw["confidence"]) if is_modis else viirs_conf(raw["confidence"])
    out["frp"] = pd.to_numeric(raw.get("frp"), errors="coerce")
    out["bright"] = pd.to_numeric(raw["brightness"] if is_modis else raw["bright_ti4"], errors="coerce")
    out["pixel_km2"] = pd.to_numeric(raw["scan"], errors="coerce") * pd.to_numeric(raw["track"], errors="coerce")
    out["type"] = pd.to_numeric(raw["type"], errors="coerce").astype("Int8") if "type" in raw else pd.array(
        [pd.NA] * len(raw), dtype="Int8")
    out["source_product"] = sp
    out["processing"] = "NRT" if sp.endswith("NRT") else "SP"
    bad = out["platform"].isna()
    if bad.any():
        print(f"[warn] {source_product}: {bad.sum()} rows with unmapped satellite {sorted(sat[bad].unique())[:5]}")
        out = out[~bad]
    out["det_id"] = det_ids(out)
    return out[SCHEMA]


def dedup(df: pd.DataFrame) -> pd.DataFrame:
    """L1 overlap: exact duplicates on (platform, lat, lon, acq_utc). SP wins over NRT."""
    df = df.sort_values("processing", key=lambda s: s.map({"SP": 0, "NRT": 1}))
    return df.drop_duplicates(subset=["platform", "lat", "lon", "acq_utc"], keep="first")


def province_geometry():
    g = gpd.read_file(C.BOUNDARIES / "corrientes_adm1.geojson").geometry.iloc[0]
    return g.buffer(C.COVERAGE_BUFFER_DEG)


def clip(df: pd.DataFrame, geom) -> pd.DataFrame:
    import shapely

    inside = shapely.contains_xy(geom, df["lon"].to_numpy(), df["lat"].to_numpy())
    return df[inside]


MANIFEST = "ingested_chunks.json"


def read_raw_dir(raw_dir: Path, manifest: dict | None = None) -> list[pd.DataFrame]:
    """Reads every cached chunk. Records which chunk files were ingested so the coverage mask is built
    from exactly the same snapshot (a chunk downloaded later must not count as observed-with-zero)."""
    frames = []
    for src_dir in sorted(p for p in raw_dir.iterdir() if p.is_dir()):
        files = sorted(src_dir.glob("*.csv"))
        if manifest is not None:
            manifest[src_dir.name] = [f.stem for f in files]
        parts = [pd.read_csv(f, dtype={"confidence": str, "acq_time": str}) for f in files if f.stat().st_size]
        parts = [p for p in parts if not p.empty]
        if parts:
            frames.append(normalize_frame(pd.concat(parts, ignore_index=True), src_dir.name))
        print(f"  {src_dir.name}: {len(files)} files")
    return frames


def main() -> pd.DataFrame:
    manifest: dict = {}
    frames = read_raw_dir(C.RAW, manifest)
    if not frames:
        raise SystemExit("no raw data yet")
    df = pd.concat(frames, ignore_index=True)
    n0 = len(df)
    df = dedup(df)
    n1 = len(df)
    df = clip(df, province_geometry())
    df = df.sort_values(["acq_utc", "platform"]).reset_index(drop=True)
    C.PROCESSED.mkdir(parents=True, exist_ok=True)
    df.to_parquet(C.PROCESSED / "detections.parquet", index=False)
    import json

    (C.PROCESSED / MANIFEST).write_text(json.dumps(manifest))
    print(f"detections: raw {n0}, after dedup {n1}, after clip {len(df)}")
    print(df.groupby(["sensor", "platform", "processing"]).size().to_string())
    return df


if __name__ == "__main__":
    main()
