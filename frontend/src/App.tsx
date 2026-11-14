import { toPng } from 'html-to-image'
import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { downloadCsv, get, post } from './api'
import { AnnualAnomaly, BacktestChart, Calendar, Climatology, MonthlyAnomalyGrid, MONTHS, Seam, SensorDiff, Timeline } from './charts'
import MapView from './MapView'
import type { AOI, Backtest, Detections, EventsResult, Filters, Geometry, Methods, Preset, QueryResult, ReplayResult } from './types'
import './App.css'

type Lens = 'response' | 'research' | 'ranger'
type AoiSel = { kind: 'preset'; id: string } | { kind: 'geom'; geom: Geometry } | { kind: 'circle'; lat: number; lon: number; radius_km: number }

const DEFAULT_FILTERS: Filters = { min_conf: 'nominal', include_static: false, daynight: 'all' }
const REPLAY_START = '2021-12-01'
const REPLAY_END = '2022-03-15'
const REPLAY_STEP_DAYS = 3

const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10)
const fmt = (v: number | null | undefined, d = 0) => (v == null ? '—' : v.toLocaleString(undefined, { maximumFractionDigits: d }))

function circlePolygon(lat: number, lon: number, r: number): Geometry {
  const pts = Array.from({ length: 65 }, (_, i) => {
    const t = (i / 64) * 2 * Math.PI
    return [lon + (r / (111.32 * Math.cos((lat * Math.PI) / 180))) * Math.cos(t), lat + (r / 111.32) * Math.sin(t)]
  })
  return { type: 'Polygon', coordinates: [pts] }
}

export default function App() {
  const [presets, setPresets] = useState<Preset[]>([])
  const [coverage, setCoverage] = useState<any>(null)
  const [methods, setMethods] = useState<Methods | undefined>()
  const [backtest, setBacktest] = useState<Backtest | undefined>()
  const [aoiSel, setAoiSel] = useState<AoiSel>({ kind: 'preset', id: 'corrientes' })
  const [latlon, setLatlon] = useState({ lat: '-28.5', lon: '-57.2', r: '25' })
  const [start, setStart] = useState('2001-01-01')
  const [end, setEnd] = useState('')
  const [asOf, setAsOf] = useState('')
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS)
  const [baseline, setBaseline] = useState<{ from: string; to: string }>({ from: '', to: '' })
  const [lens, setLens] = useState<Lens>('response')
  const [raw, setRaw] = useState(false)
  const [q, setQ] = useState<QueryResult | ReplayResult | null>(null)
  const [ev, setEv] = useState<EventsResult | null>(null)
  const [det, setDet] = useState<Detections | null>(null)
  const [detLabel, setDetLabel] = useState('last 7 days')
  const [cached, setCached] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [replayMode, setReplayMode] = useState(false)
  const playRef = useRef(false)
  const cardRef = useRef<HTMLDivElement>(null)
  const calRef = useRef<HTMLDivElement>(null)

  // ------------------------------------------------------------ static data
  useEffect(() => {
    get<{ presets: Preset[] }>('/api/presets', 'presets', 8000).then(r => setPresets(r.data.presets)).catch(e => setError(String(e.message)))
    get<any>('/api/coverage', 'coverage', 8000).then(r => setCoverage(r.data.polygon)).catch(() => {})
    get<Methods>('/api/methods', 'methods', 8000).then(r => setMethods(r.data)).catch(() => {})
    get<Backtest>('/api/backtest/corrientes-2022', 'backtest', 8000).then(r => setBacktest(r.data)).catch(() => {})
  }, [])

  const aoi: AOI | null = useMemo(() => {
    if (aoiSel.kind === 'preset') return presets.find(p => p.id === aoiSel.id)?.geometry ?? null
    if (aoiSel.kind === 'geom') return aoiSel.geom
    return { lat: aoiSel.lat, lon: aoiSel.lon, radius_km: aoiSel.radius_km }
  }, [aoiSel, presets])
  const aoiGeom: Geometry | null = useMemo(() => {
    if (!aoi) return null
    if ('lat' in aoi) return circlePolygon(aoi.lat, aoi.lon, aoi.radius_km)
    return aoi
  }, [aoi])
  const aoiName = aoiSel.kind === 'preset' ? presets.find(p => p.id === aoiSel.id)?.name ?? '' : aoiSel.kind === 'circle' ? `${aoiSel.radius_km} km around ${aoiSel.lat}, ${aoiSel.lon}` : 'Custom drawn area'

  const isDefault = JSON.stringify(filters) === JSON.stringify(DEFAULT_FILTERS) && !baseline.from && !baseline.to && start === '2001-01-01' && !end
  const fbKey = (kind: string) => (aoiSel.kind === 'preset' && isDefault && !asOf ? `${kind}_${aoiSel.id}` : null)
  const baselineYears = useMemo(() => {
    if (!baseline.from && !baseline.to) return undefined
    const a = Number(baseline.from || 2001), b = Number(baseline.to || 2100)
    return Array.from({ length: Math.max(0, b - a + 1) }, (_, i) => a + i)
  }, [baseline])
  const body = useMemo(() => (aoi ? { aoi, start: start || undefined, end: end || undefined, as_of: asOf || undefined, filters, baseline_years: baselineYears } : null),
    [aoi, start, end, asOf, filters, baselineYears])

  // ------------------------------------------------------------ main query
  useEffect(() => {
    if (!body || replayMode) return
    let stale = false
    setLoading(true)
    setError(null)
    Promise.all([post<QueryResult>('/api/query', body, fbKey('query')), post<EventsResult>('/api/events', body, fbKey('events'))])
      .then(([a, b]) => { if (stale) return; setQ(a.data); setEv(b.data); setCached(a.cached || b.cached) })
      .catch(e => { if (!stale) setError(e.message) })
      .finally(() => { if (!stale) setLoading(false) })
    return () => { stale = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [body, replayMode])

  // detections for the map (last 7 days before as-of/end), unless a calendar month is picked
  const loadDetections = useCallback((s: string, e: string, label: string) => {
    if (!aoi) return
    setDetLabel(label)
    post<Detections>('/api/detections', { aoi, start: s, end: e, filters }, null, 8000).then(r => setDet(r.data)).catch(() => setDet(null))
  }, [aoi, filters])
  useEffect(() => {
    if (!q) return
    const e = q.summary.as_of
    loadDetections(addDays(e, -6), e, 'last 7 days')
  }, [q?.summary.as_of, aoi, filters]) // eslint-disable-line react-hooks/exhaustive-deps

  const pickMonth = (y: number, m: number) => {
    const s = `${y}-${String(m).padStart(2, '0')}-01`
    const e = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)
    loadDetections(s, e, `${MONTHS[m - 1]} ${y}`)
  }

  // ------------------------------------------------------------ replay (§7.1, §7.4)
  const replayAt = useCallback(async (d: string) => {
    const corr = presets.find(p => p.id === 'corrientes')
    if (!corr) return
    const r = await post<ReplayResult>('/api/replay', { aoi: corr.geometry, as_of: d, filters: DEFAULT_FILTERS }, `replay_corrientes_${d}`, 8000)
    setQ(r.data)
    setEv(r.data.events)
    setCached(r.cached)
  }, [presets])

  const startReplay = async () => {
    setAoiSel({ kind: 'preset', id: 'corrientes' })
    setReplayMode(true)
    setLens('response')
    setPlaying(true)
    playRef.current = true
    let d = REPLAY_START
    while (playRef.current && d <= REPLAY_END) {
      setAsOf(d)
      try { await replayAt(d) } catch (e: any) { setError(e.message); break }
      await new Promise(res => setTimeout(res, 350))
      d = addDays(d, REPLAY_STEP_DAYS)
    }
    playRef.current = false
    setPlaying(false)
  }
  const pause = () => { playRef.current = false; setPlaying(false) }
  const exitReplay = () => { pause(); setReplayMode(false); setAsOf('') }

  // ------------------------------------------------------------ exports
  const exportCsv = async (kind: 'hotspots' | 'summary') => {
    if (!body) return
    try {
      await downloadCsv(`/api/export/${kind}.csv`, body, `emberline_${kind}.csv`)
    } catch (e: any) { setError(`CSV export needs the live API: ${e.message}`) }
  }
  const exportPng = async (el: HTMLElement | null, name: string) => {
    if (!el) return
    const url = await toPng(el, { backgroundColor: '#ffffff', pixelRatio: 2 })
    const a = document.createElement('a'); a.href = url; a.download = name; a.click()
  }

  const applyLatLon = () => {
    const lat = Number(latlon.lat), lon = Number(latlon.lon), r = Number(latlon.r)
    if ([lat, lon, r].some(Number.isNaN)) { setError('Enter numeric latitude, longitude and radius.'); return }
    setReplayMode(false)
    setAoiSel({ kind: 'circle', lat, lon, radius_km: r })
  }

  const rq = q as ReplayResult | null
  const status = q?.summary.status

  return (
    <div className="app">
      <header>
        <div>
          <h1>Emberline</h1>
          <span className="sub">Harmonized MODIS + VIIRS burning-activity calendar · Coverage: Corrientes, Argentina</span>
        </div>
        <nav>
          {(['response', 'research', 'ranger'] as Lens[]).map(l => (
            <button key={l} className={lens === l ? 'on' : ''} onClick={() => setLens(l)}>
              {l === 'response' ? 'Response Station' : l === 'research' ? 'Research Lab' : 'Ranger Post'}
            </button>
          ))}
        </nav>
      </header>

      <div className="layout">
        <aside>
          <section>
            <h3>Area of interest</h3>
            <select value={aoiSel.kind === 'preset' ? aoiSel.id : ''} onChange={e => { setReplayMode(false); setAoiSel({ kind: 'preset', id: e.target.value }) }}>
              {aoiSel.kind !== 'preset' && <option value="">{aoiName}</option>}
              {presets.map(p => <option key={p.id} value={p.id}>{p.kind === 'department' ? '— ' : ''}{p.name}</option>)}
            </select>
            <div className="row">
              <label>lat<input value={latlon.lat} onChange={e => setLatlon({ ...latlon, lat: e.target.value })} /></label>
              <label>lon<input value={latlon.lon} onChange={e => setLatlon({ ...latlon, lon: e.target.value })} /></label>
              <label>km<input value={latlon.r} onChange={e => setLatlon({ ...latlon, r: e.target.value })} /></label>
              <button onClick={applyLatLon}>Go</button>
            </div>
            <p className="note">…or draw a rectangle/polygon on the map.</p>
          </section>
          <section>
            <h3>Date range</h3>
            <div className="row">
              <label>from<input type="date" value={start} onChange={e => setStart(e.target.value)} /></label>
              <label>to<input type="date" value={end} onChange={e => setEnd(e.target.value)} /></label>
            </div>
          </section>
          <section>
            <h3>As-of date (replay)</h3>
            <div className="row">
              <input type="date" value={asOf} onChange={e => { setReplayMode(false); setAsOf(e.target.value) }} />
              {asOf && <button onClick={exitReplay}>Today</button>}
            </div>
            <p className="note">Everything is recomputed using only data up to this date.</p>
            <div className="row">
              {!playing ? <button className="primary" onClick={startReplay}>▶ Replay Corrientes 2022</button> : <button onClick={pause}>❚❚ Pause</button>}
            </div>
          </section>
          <section>
            <h3>Filters</h3>
            <label className="chk"><input type="checkbox" checked={filters.min_conf === 'all'} onChange={e => setFilters({ ...filters, min_conf: e.target.checked ? 'all' : 'nominal' })} /> include low-confidence detections</label>
            <label className="chk"><input type="checkbox" checked={filters.include_static} onChange={e => setFilters({ ...filters, include_static: e.target.checked })} /> include static/other sources</label>
            <label>day/night <select value={filters.daynight} onChange={e => setFilters({ ...filters, daynight: e.target.value as Filters['daynight'] })}>
              <option value="all">all</option><option value="D">day only</option><option value="N">night only</option></select></label>
          </section>
          <section>
            <h3>Baseline years</h3>
            <div className="row">
              <label>from<input placeholder="all" value={baseline.from} onChange={e => setBaseline({ ...baseline, from: e.target.value })} /></label>
              <label>to<input placeholder="all" value={baseline.to} onChange={e => setBaseline({ ...baseline, to: e.target.value })} /></label>
            </div>
          </section>
          <section>
            <h3>Display</h3>
            <label className="chk"><input type="checkbox" checked={raw} onChange={e => setRaw(e.target.checked)} /> show raw (naive) hotspot counts</label>
          </section>
        </aside>

        <main>
          <div className="status-line">
            {loading && <span className="badge">loading…</span>}
            {cached && <span className="badge cached">cached — precomputed result, live API unavailable</span>}
            {replayMode && <span className="badge replay">REPLAY · as of {asOf}</span>}
            {q && <span className="muted">{aoiName} · {fmt(q.summary.area_km2)} km² · {q.summary.cells_in_aoi} cells{q.summary.clipped_fraction > 0 ? ` · ${(q.summary.clipped_fraction * 100).toFixed(0)}% outside coverage was clipped` : ''} · data to {q.summary.last_observed_day}</span>}
          </div>
          {error && <div className="error">{error}</div>}

          <MapView coverage={coverage} aoi={aoiGeom} detections={det} onDraw={g => { setReplayMode(false); setAoiSel({ kind: 'geom', geom: g }) }} />
          <p className="note">Map: detections for {detLabel}. Click a calendar cell to show that month.</p>

          {q && lens === 'response' && (
            <div className="panels">
              <div className={`panel status s-${status?.level.replace(' ', '')}`}>
                <h2>Activity status</h2>
                <div className="big">{status?.level}</div>
                <p>{status?.sentence}</p>
                <p className="muted">7-day burning cells {fmt(status?.S, 1)} · P90 {fmt(status?.P90, 1)} · P99 {fmt(status?.P99, 1)} (2003–2021 baseline, same rule as the backtest)</p>
              </div>
              <div className="panel">
                <h2>Now vs normal</h2>
                <div className="big">{q.current_vs_median.ratio != null ? `${q.current_vs_median.ratio.toFixed(1)}×` : '—'}</div>
                <p>{q.current_vs_median.sentence}</p>
                <p className="muted">{fmt(q.current_vs_median.value)} vs median {fmt(q.current_vs_median.median)} burning cells, days 1–{q.current_vs_median.days_compared}{q.current_vs_median.percentile != null ? `, percentile ${q.current_vs_median.percentile}` : ''}</p>
              </div>
              <div className="panel">
                <h2>Critical window</h2>
                <p>{q.upcoming_window?.sentence ?? q.critical_windows.sentence}</p>
                <p className="muted">{q.critical_windows.sentence}</p>
              </div>
              <div className="panel">
                <h2>Current fire vs previous</h2>
                <p>{ev?.sentence ?? '—'}</p>
                <p className="muted">{ev?.note}</p>
              </div>
              <div className="panel wide">
                <h2>Timeline {replayMode ? '(replay)' : ''}</h2>
                <Timeline q={sliceTimeline(q, replayMode ? 150 : 365)} markers={methods?.markers} asOf={replayMode ? asOf : undefined}
                  alertDates={replayMode ? { alert: rq?.replay?.first_alert, severe: rq?.replay?.first_severe } : undefined} />
                <p className="note">Bars: daily burning cells. Lines: 7-day sum vs P90/P99 thresholds. Dashed vertical lines = unverified official dates.</p>
              </div>
              {backtest && (
                <div className="panel wide">
                  <h2>Would we have seen it coming? Corrientes 2021–22 backtest</h2>
                  <BacktestChart bt={backtest} asOf={replayMode ? asOf : undefined} />
                  <p>First Alert: <b>{backtest.result.first_alert ?? 'none'}</b> · First Severe: <b>{backtest.result.first_severe ?? 'none'}</b></p>
                  <table>
                    <thead><tr><th>Official marker</th><th>Date</th><th>Days after our first Alert</th><th>Days after first Severe</th></tr></thead>
                    <tbody>{backtest.markers.map(m => (
                      <tr key={m.date + m.label}><td><a href={m.source_url} target="_blank" rel="noreferrer">{m.label}</a>{m.verified ? '' : ' (unverified)'}</td><td>{m.date}</td>
                        <td>{m.days_after_first_alert ?? '—'}</td><td>{m.days_after_first_severe ?? '—'}</td></tr>))}</tbody>
                  </table>
                  <p><b>Honesty check:</b> {backtest.honesty.sentence} <span className="muted">{backtest.honesty.note}</span></p>
                  <details><summary>Season-by-season</summary>
                    <table><thead><tr><th>Season</th><th>Alert</th><th>Severe</th></tr></thead>
                      <tbody>{backtest.honesty.seasons.map(s => <tr key={s.season}><td>{s.season}</td><td>{s.first_alert ?? 'no'}</td><td>{s.first_severe ?? 'no'}</td></tr>)}</tbody></table>
                  </details>
                  {backtest.reported_official.map(r => <p key={r.fact} className="muted">Reported (official source{r.verified ? '' : ', unverified'}): {r.fact}</p>)}
                </div>
              )}
              <div className="panel wide">
                <h2>Export</h2>
                <div className="row">
                  <button onClick={() => exportCsv('hotspots')}>Hotspots CSV</button>
                  <button onClick={() => exportCsv('summary')}>Summary CSV</button>
                  <button onClick={() => exportPng(cardRef.current, 'emberline_field_card.png')}>Field card PNG</button>
                </div>
                <FieldCard ref={cardRef} q={q} ev={ev} name={aoiName} />
              </div>
            </div>
          )}

          {q && lens === 'ranger' && (
            <div className="panels">
              <div className="panel wide" ref={calRef}>
                <h2>Burning activity calendar {raw ? '(raw hotspots — naive)' : '(harmonized burning cells)'}</h2>
                <p>{q.peaks.sentence}</p>
                <Calendar cells={q.calendar_monthly} raw={raw} onPick={pickMonth} windows={q.critical_windows.windows} />
                <div className="row"><button onClick={() => exportPng(calRef.current, 'emberline_calendar.png')}>Calendar PNG</button></div>
              </div>
              <div className="panel">
                <h2>Seasonal climatology</h2>
                <p>{q.peaks.sentence}</p>
                <Climatology q={q} />
              </div>
              <div className="panel">
                <h2>Peaks</h2>
                <p><b>Top months of year:</b> {q.peaks.top_months_of_year.map(m => `${m.name} (${fmt(m.median)})`).join(', ')}</p>
                <p><b>Top years:</b> {q.peaks.top_years.map(y => `${y.year} (${fmt(y.total)})`).join(', ')}</p>
                <p><b>Top single months:</b> {q.peaks.top_single_months.map(m => `${m.name} (${fmt(m.value)}, ${m.provenance})`).join(', ')}</p>
              </div>
              <div className="panel">
                <h2>Annual anomaly vs multi-year mean</h2>
                <p>{annualSentence(q)}</p>
                <AnnualAnomaly q={q} />
              </div>
              <div className="panel">
                <h2>Monthly anomalies (× monthly median)</h2>
                <MonthlyAnomalyGrid q={q} />
              </div>
            </div>
          )}

          {q && lens === 'research' && (
            <div className="panels">
              <div className="panel wide">
                <h2>Raw vs harmonized — the 2012 seam</h2>
                <p>{raw ? 'Showing the naive splice emphasised: raw hotspot counts jump when VIIRS (375 m) joins MODIS (1 km) in 2012.' : 'The harmonized series counts burning cells and bridges sensors with calibration factors, so it does not jump at 2012.'}</p>
                <Seam q={q} methods={methods} raw={raw} />
              </div>
              <div className="panel wide">
                <h2>Sensor differences (overlap era)</h2>
                <p>{q.sensor_diff.sentence}</p>
                <SensorDiff q={q} />
              </div>
              <div className="panel">
                <h2>Calibration (this AOI, shrunk toward region, n0 = {q.summary.calibration_used.n0})</h2>
                <table><thead><tr><th>Month</th><th>k_M</th><th>n MODIS cell-days</th><th>k_V</th><th>n VIIRS</th></tr></thead>
                  <tbody>{MONTHS.map((m, i) => <tr key={m}><td>{m}</td><td>{q.summary.calibration_used.k_M[i + 1]?.toFixed(3)}</td><td>{q.summary.calibration_used.n_aoi_M[i + 1]}</td>
                    <td>{q.summary.calibration_used.k_V[i + 1]?.toFixed(3)}</td><td>{q.summary.calibration_used.n_aoi_V[i + 1]}</td></tr>)}</tbody></table>
              </div>
              {methods && (
                <div className="panel">
                  <h2>Validation (region)</h2>
                  <p>{methods.calibration.fit_note}.</p>
                  <table><thead><tr><th>Hold-out</th><th>MAPE</th><th>Bias</th><th>r</th><th>90% cov.</th></tr></thead>
                    <tbody>{(['k_M', 'k_V'] as const).map(k => <tr key={k}><td>{k}</td><td>{fmt(methods.holdout[k].mape_pct, 1)}%</td><td>{fmt(methods.holdout[k].bias_pct, 1)}%</td>
                      <td>{fmt(methods.holdout[k].pearson_r, 3)}</td><td>{fmt(methods.holdout[k].interval_coverage_pct, 0)}%</td></tr>)}</tbody></table>
                  <p className="muted">Stability drift flag: {String(methods.stability.drift_flag)}. Inter-VIIRS: {Object.entries(methods.inter_viirs).map(([k, v]) => `${k} ${v.overall?.toFixed(3) ?? '—'} (${v.apply ? 'scaled' : 'observed'})`).join(', ')}.</p>
                  <p className="muted">VIIRS reference handover: SNPP last data {q.summary.viirs_handover.snpp_last_data ?? '—'}; NOAA-20 reference from {q.summary.viirs_handover.noaa20_reference_from ?? '—'}.</p>
                </div>
              )}
              <div className="panel">
                <h2>Detected counts ({q.summary.start} → {q.summary.end})</h2>
                <p>Harmonized burning cell-days: <b>{fmt(q.counts.burning_cell_days_harmonized)}</b></p>
                <p>Raw hotspots — MODIS: {fmt(q.counts.raw_hotspots.MODIS)}, VIIRS (reference): {fmt(q.counts.raw_hotspots.VIIRS_reference)}</p>
                <p className="muted">By platform: {Object.entries(q.counts.raw_hotspots.by_platform).map(([k, v]) => `${k} ${fmt(v)}`).join(' · ')}</p>
                <p>Fire events (2012 →): {fmt(ev?.n_events)}{ev?.n_in_range != null ? `, ${fmt(ev.n_in_range)} in range` : ''}</p>
                <p className="muted">{q.counts.note} No-data days in range: {q.counts.no_data_days}.</p>
              </div>
              <div className="panel">
                <h2>Exports</h2>
                <div className="row"><button onClick={() => exportCsv('hotspots')}>Hotspots CSV</button><button onClick={() => exportCsv('summary')}>Summary CSV</button></div>
              </div>
            </div>
          )}

          <footer>
            We acknowledge the use of data and/or imagery from NASA's Fire Information for Resource Management System (FIRMS), part of NASA's Earth Science Data and Information System (ESDIS).
            MODIS C6.1 (MCD14ML / MCD14DL) and VIIRS 375 m (VNP14IMG, VJ114IMG, VJ214IMG) active fire products. Boundaries: geoBoundaries (CC BY 4.0). Basemap: OpenFreeMap © OpenMapTiles © OpenStreetMap contributors.
            {q && <> Provenance: {Object.entries(q.provenance_legend).map(([k, v]) => `${k} — ${v}`).join(' · ')}</>}
          </footer>
        </main>
      </div>
    </div>
  )
}

function sliceTimeline(q: QueryResult, days: number): QueryResult {
  const t = q.timeline
  const n = t.date.length
  const s = Math.max(0, n - days)
  const sl = <T,>(a: T[]) => a.slice(s)
  return { ...q, timeline: { date: sl(t.date), H: sl(t.H), S: sl(t.S), P90: sl(t.P90), P99: sl(t.P99), status: sl(t.status), provenance: sl(t.provenance), H_low: sl(t.H_low), H_high: sl(t.H_high) } }
}

function annualSentence(q: QueryResult) {
  const a = q.anomalies.annual.filter(r => r.complete && r.vs_mean_ratio != null)
  if (!a.length) return 'Not enough complete years.'
  const top = a.reduce((x, y) => ((y.vs_mean_ratio ?? 0) > (x.vs_mean_ratio ?? 0) ? y : x))
  return `${top.year} was the most anomalous complete year: ${top.vs_mean_ratio!.toFixed(1)}× the multi-year mean of ${fmt(q.anomalies.annual_mean)} burning cells.`
}


const FieldCard = forwardRef<HTMLDivElement, { q: QueryResult; ev: EventsResult | null; name: string }>(({ q, ev, name }, ref) => (
  <div ref={ref} className="field-card">
    <h3>EMBERLINE FIELD CARD — {name}</h3>
    <p className="muted">As of {q.summary.as_of} · {fmt(q.summary.area_km2)} km² · NASA FIRMS MODIS + VIIRS, harmonized</p>
    <p><b>Status:</b> {q.summary.status.level} — {q.summary.status.sentence}</p>
    <p><b>Now vs normal:</b> {q.current_vs_median.sentence}</p>
    <p><b>Peak season:</b> {q.peaks.sentence} {q.critical_windows.sentence}</p>
    <p><b>Top years:</b> {q.peaks.top_years.map(y => `${y.year} (${fmt(y.total)})`).join(', ')}</p>
    <p><b>Current fire:</b> {ev?.sentence ?? '—'}</p>
    <p className="muted">Unit: burning cells = ~2.2 km grid cells with ≥1 active-fire detection per day (overlapping detections from both sensors counted once). Values before 2012 are estimated from MODIS via calibration; no-data days are excluded, not counted as zero.</p>
  </div>
))
