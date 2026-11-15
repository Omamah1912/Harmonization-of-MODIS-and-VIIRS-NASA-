"""§4.2 step 5: FIRMS missing-data dates per platform → data/raw/missing_days.csv.

The FIRMS page https://firms.modaps.eosdis.nasa.gov/api/missing_data/ loads its table from
`?action=fetch_data` (JSON with an HTML <tbody>). Each <tr> holds two (date, satellite) pairs:
left = Standard Processing table, right = Near Real Time table.
"""
from __future__ import annotations

import json
import re

import pandas as pd
import requests

from pipeline import config as C

URL = f"{C.FIRMS_BASE}/api/missing_data/?action=fetch_data"
SAT = {
    "Terra (MODIS)": "Terra", "Aqua (MODIS)": "Aqua", "Suomi NPP (VIIRS)": "SNPP",
    "NOAA-20 (VIIRS)": "NOAA20", "NOAA-21 (VIIRS)": "NOAA21",
}


def parse(html: str) -> pd.DataFrame:
    rows = []
    for tr in re.findall(r"<tr>(.*?)</tr>", html, re.S):
        td = [t.strip() for t in re.findall(r"<td>(.*?)</td>", tr, re.S)]
        for i, product in ((0, "SP"), (2, "NRT")):
            if len(td) > i + 1 and td[i] and td[i + 1]:
                plat = SAT.get(td[i + 1])
                if plat is None:
                    print(f"[warn] unknown satellite label {td[i + 1]!r}")
                    continue
                rows.append({"date": td[i], "platform": plat, "processing": product})
    return pd.DataFrame(rows, columns=["date", "platform", "processing"]).drop_duplicates()


def main() -> pd.DataFrame:
    r = requests.get(URL, headers={"X-Requested-With": "XMLHttpRequest"}, timeout=60)
    r.raise_for_status()
    d = r.json()
    (C.RAW / "missing_data_raw.json").write_text(json.dumps(d), encoding="utf-8")
    df = parse(d["html"]).sort_values(["platform", "date"])
    df.to_csv(C.RAW / "missing_days.csv", index=False)
    print(df.groupby(["platform", "processing"]).size().to_string())
    return df


if __name__ == "__main__":
    main()
