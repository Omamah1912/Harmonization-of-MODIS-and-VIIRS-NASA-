"""§4.1 Download geoBoundaries ARG ADM1/ADM2, extract Corrientes and its departments."""
from __future__ import annotations

import json

import geopandas as gpd
import requests

from pipeline import config as C

API = "https://www.geoboundaries.org/api/current/gbOpen/ARG/{lvl}/"


def download(lvl: str) -> gpd.GeoDataFrame:
    raw = C.BOUNDARIES / f"geoBoundaries-ARG-{lvl}.geojson"
    if not raw.exists():
        meta = requests.get(API.format(lvl=lvl), timeout=60).json()
        (C.BOUNDARIES / f"geoBoundaries-ARG-{lvl}.meta.json").write_text(json.dumps(meta, indent=2))
        r = requests.get(meta["gjDownloadURL"], timeout=300)
        r.raise_for_status()
        raw.write_bytes(r.content)
    return gpd.read_file(raw)


def main() -> None:
    C.BOUNDARIES.mkdir(parents=True, exist_ok=True)
    adm1 = download("ADM1")
    name_col = "shapeName"
    prov = adm1[adm1[name_col].str.contains("Corrientes", case=False)]
    if len(prov) != 1:
        raise SystemExit(f"expected one Corrientes ADM1 feature, got {list(prov[name_col])}")
    prov = prov[[name_col, "geometry"]].rename(columns={name_col: "name"})
    prov.to_file(C.BOUNDARIES / "corrientes_adm1.geojson", driver="GeoJSON")

    adm2 = download("ADM2")
    poly = prov.geometry.iloc[0]
    # department belongs to Corrientes if its representative point falls inside the province
    inside = adm2[adm2.geometry.representative_point().within(poly)]
    deps = inside[[name_col, "geometry"]].rename(columns={name_col: "name"}).sort_values("name")
    deps.to_file(C.BOUNDARIES / "corrientes_adm2.geojson", driver="GeoJSON")

    minx, miny, maxx, maxy = poly.bounds
    W, S, E, N = C.BBOX
    clipped = minx < W or miny < S or maxx > E or maxy > N
    print(f"Corrientes bounds W={minx:.3f} S={miny:.3f} E={maxx:.3f} N={maxy:.3f}")
    print(f"download bbox {C.BBOX} -> {'CLIPS THE PROVINCE: widen BBOX' if clipped else 'covers province'}")
    print(f"{len(deps)} departments: {', '.join(deps['name'])}")


if __name__ == "__main__":
    main()
