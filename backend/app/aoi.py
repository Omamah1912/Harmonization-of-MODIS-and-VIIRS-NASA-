"""AOI parsing: GeoJSON Polygon/MultiPolygon/Feature, or {lat, lon, radius_km}. Clip to coverage."""
from __future__ import annotations

import hashlib
import json
import math

import numpy as np
import shapely
from shapely.geometry import Polygon, mapping, shape
from shapely.ops import unary_union


class AOIError(ValueError):
    pass


def circle(lat: float, lon: float, radius_km: float, n: int = 64) -> Polygon:
    if not (0 < radius_km <= 500):
        raise AOIError("radius_km must be between 0 and 500")
    if not (-90 <= lat <= 90 and -180 <= lon <= 180):
        raise AOIError("lat/lon out of range")
    dlat = radius_km / 111.32
    dlon = radius_km / (111.32 * max(math.cos(math.radians(lat)), 1e-6))
    t = np.linspace(0, 2 * np.pi, n, endpoint=False)
    return Polygon(zip(lon + dlon * np.cos(t), lat + dlat * np.sin(t)))


def parse(aoi: dict):
    if not isinstance(aoi, dict):
        raise AOIError("aoi must be an object")
    if {"lat", "lon", "radius_km"} <= aoi.keys():
        return circle(float(aoi["lat"]), float(aoi["lon"]), float(aoi["radius_km"]))
    g = aoi
    if g.get("type") == "FeatureCollection":
        geoms = [shape(f["geometry"]) for f in g.get("features", [])]
        if not geoms:
            raise AOIError("empty FeatureCollection")
        geom = unary_union(geoms)
    else:
        if g.get("type") == "Feature":
            g = g.get("geometry") or {}
        if g.get("type") not in ("Polygon", "MultiPolygon"):
            raise AOIError("aoi must be a GeoJSON Polygon/MultiPolygon or {lat, lon, radius_km}")
        try:
            geom = shape(g)
        except Exception as e:  # noqa: BLE001
            raise AOIError(f"invalid geometry: {e}") from e
    if not geom.is_valid:
        geom = geom.buffer(0)
    if geom.is_empty:
        raise AOIError("empty geometry")
    return geom


def clip(geom, coverage):
    """Returns (clipped_geom, clipped_fraction). Raises if fully outside coverage."""
    inter = geom.intersection(coverage)
    if inter.is_empty or inter.area == 0:
        raise AOIError("The selected area is outside the coverage region (Corrientes, Argentina). "
                       "Draw or enter an area inside the outlined province.")
    frac = 1 - inter.area / geom.area if geom.area else 0.0
    return inter, round(float(frac), 4)


def cells_in(geom, cells) -> np.ndarray:
    """cell_ids whose centroid is inside geom."""
    inside = shapely.contains_xy(geom, cells["lon_c"].to_numpy(), cells["lat_c"].to_numpy())
    return cells["cell_id"].to_numpy()[inside]


def aoi_hash(aoi: dict) -> str:
    return hashlib.sha1(json.dumps(aoi, sort_keys=True).encode()).hexdigest()[:16]


def to_geojson(geom) -> dict:
    return mapping(geom)
