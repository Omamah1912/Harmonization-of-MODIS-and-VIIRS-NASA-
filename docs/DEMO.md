# Demo script (3 minutes)

Before going on stage: open the app once (warms the API), check the **cached** badge is *not* showing, and
keep the local backup ready (`uvicorn backend.app.main:app --port 8000` serving `frontend/dist`).
Numbers in brackets come from the live app / `docs/METHODS.md`: read them off the screen, don't memorize.

1. **Hook (20 s).** "Corrientes, Argentina, summer 2021–22: drought, and fires through grasslands, palm groves
   and the Iberá wetlands. The province declared an agricultural emergency on 7 Feb 2022 and an ecological
   disaster zone on 22 Feb." (Response Station → backtest panel shows the decree dates; unverified ones are
   dashed and labelled.)
2. **Problem (20 s).** Research Lab → *Raw vs harmonized*. Toggle "show raw": the naive hotspot record jumps in
   2012 when VIIRS arrives, which is a sensor artefact and not more fire. The harmonized line follows the MODIS-only
   reference. Sensor-differences panel: "VIIRS also saw [x]% of MODIS cells and [n] cells MODIS missed. That's
   why we never add the two counts."
3. **Calendar (40 s).** Ranger Post → 25-year calendar. Point out: hatched = estimated before 2012 (MODIS
   only, bridged), grey hatch = no data (never zero). Peak season sentence, top years. 2022 stands out.
   Click Feb 2022: map shows that month's detections, timeline jumps there.
4. **Edge (60 s).** Response Station → **Replay Corrientes 2022**. The timeline plays from 1 Dec 2021; status
   badge changes from Normal → Elevated → Extreme. "Our pre-registered rule, fixed using 2003–2021 data only, first
   alerted on [first alert date], [n] days before the agricultural-emergency decree." Then the honesty table:
   "the same rule fired in [X of 19] past seasons; Severe in [Y]. You can see how often it cries wolf."
5. **Any area (20 s).** Type lat/lon (e.g. −28.5, −57.2, 25 km) or draw a rectangle → instant calendar,
   now-vs-normal sentence; download hotspots CSV and the field card PNG.
6. **Close (20 s).** "Consistent across sensors, honest about uncertainty and missing data, tested against a
   real disaster, and built entirely on open NASA FIRMS data."
