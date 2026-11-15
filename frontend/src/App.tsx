import { toPng } from 'html-to-image'
import { Component, forwardRef, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ApiError, downloadCsv, get, post } from './api'
import { AnnualAnomaly, BridgeFactors, ember, EmberCalendar, FireClock, fmt, MonthlyAnomalyGrid, MONTHS, SeamSplitter, SeasonBars, WhoSawWhat } from './charts'
import { MainDock, ReplayDock } from './Dock'
import Intro from './Intro'
import { Corners, RingButton, Topo } from './Hud'
import MapView, { type DrawMode } from './MapView'
import type { AOI, Backtest, Detections, EventsResult, Filters, Geometry, Methods, Preset, QueryResult, ReplayResult, Status } from './types'
import './App.css'
import './blueprint.css'

type Lens = 'response' | 'ranger' | 'research'
type AoiSel = { kind: 'preset'; id: string } | { kind: 'geom'; geom: Geometry } | { kind: 'circle'; lat: number; lon: number; radius_km: number }
type Pop = null | 'pin' | 'presets' | 'filters'

const DEFAULT_FILTERS: Filters = { min_conf: 'nominal', include_static: false, daynight: 'all' }
const REPLAY_START = '2021-12-01'
const REPLAY_END = '2022-03-15'
const REPLAY_STEP_DAYS = 3
const LENSES: { id: Lens; name: string; role: string; color: string }[] = [
  { id: 'response', name: 'Response Station', role: 'Act now', color: '#4FD1C5' },
  { id: 'ranger', name: 'Ranger Post', role: 'Know the seasons', color: '#A3E635' },
  { id: 'research', name: 'Research Lab', role: 'Check the science', color: '#8AB4F8' },
]

const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10)
const niceDate = (d: string, year = true) => { const x = new Date(Date.parse(d + 'T00:00:00Z')); return `${x.getUTCDate()} ${MONTHS[x.getUTCMonth()]}${year ? ' ' + x.getUTCFullYear() : ''}` }
const partOfMonth = (d: string) => { const x = new Date(Date.parse(d + 'T00:00:00Z')); const day = x.getUTCDate(); return `${day <= 10 ? 'early' : day <= 20 ? 'mid' : 'late'}-${['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][x.getUTCMonth()]}` }
const lvlKey = (s?: Status['level']) => (s ?? 'No data').replace(' ', '')
const LEVEL_ICON: Record<string, string> = { Normal: '○', Elevated: '▲', Extreme: '◆', 'No data': '⊘' }
const LEVEL_HEAD: Record<string, string> = { Normal: 'Within the usual range', Elevated: 'Above normal', Extreme: 'Far above normal', 'No data': 'No data' }
const store = { get: (k: string) => { try { return localStorage.getItem(k) } catch { return null } }, set: (k: string, v: string) => { try { localStorage.setItem(k, v) } catch { /* private mode */ } } }

function circlePolygon(lat: number, lon: number, r: number): Geometry {
  const pts = Array.from({ length: 65 }, (_, i) => {
    const t = (i / 64) * 2 * Math.PI
    return [lon + (r / (111.32 * Math.cos((lat * Math.PI) / 180))) * Math.cos(t), lat + (r / 111.32) * Math.sin(t)]
  })
  return { type: 'Polygon', coordinates: [pts] }
}

class Boundary extends Component<{ children: ReactNode; resetKey: string }, { err: string | null; key: string }> {
  state = { err: null as string | null, key: '' }
  static getDerivedStateFromError(e: Error) { return { err: e.message } }
  static getDerivedStateFromProps(p: { resetKey: string }, s: { err: string | null; key: string }) { return p.resetKey !== s.key ? { err: null, key: p.resetKey } : null }
  render() { return this.state.err ? <div className="panel"><div className="card"><h3 style={{ margin: 0 }}>This view hit a problem</h3><p className="note">{this.state.err}</p></div></div> : this.props.children }
}

// crisp data motion: numbers count up (FRONTEND.md §2 motion)
function CountUp({ value, digits = 0, prefix = '', suffix = '' }: { value: number | null | undefined; digits?: number; prefix?: string; suffix?: string }) {
  const [v, setV] = useState(value ?? 0)
  const from = useRef(value ?? 0)
  useEffect(() => {
    if (value == null) return
    const a = from.current, b = value, t0 = performance.now(), dur = 650
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { setV(b); from.current = b; return }
    let raf = 0
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3)
      setV(a + (b - a) * e)
      if (k < 1) raf = requestAnimationFrame(step); else from.current = b
    }
    raf = requestAnimationFrame(step)
    return () => { cancelAnimationFrame(raf); from.current = b }
  }, [value])
  if (value == null) return <>—</>
  return <>{prefix}{v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}{suffix}</>
}

// sliding pill behind the active lens tab
function Tabs({ lens, setLens }: { lens: Lens; setLens: (l: Lens) => void }) {
  const ref = useRef<HTMLElement>(null)
  const [pill, setPill] = useState<{ x: number; w: number } | null>(null)
  useEffect(() => {
    const place = () => {
      const b = ref.current?.querySelector<HTMLButtonElement>(`button[data-l="${lens}"]`)
      if (b) setPill({ x: b.offsetLeft, w: b.offsetWidth })
    }
    place()
    const ro = new ResizeObserver(place); if (ref.current) ro.observe(ref.current)
    return () => ro.disconnect()
  }, [lens])
  const c = LENSES.find(l => l.id === lens)!.color
  return (
    <nav className="tabs" aria-label="Lens" ref={ref}>
      {pill && <span className="tab-pill" style={{ transform: `translateX(${pill.x - 4}px)`, width: pill.w, ['--c' as any]: c }} />}
      {LENSES.map(l => (
        <button key={l.id} data-l={l.id} className={lens === l.id ? 'on' : ''} style={{ ['--c' as any]: l.color }} onClick={() => setLens(l.id)} aria-pressed={lens === l.id}>
          <i className="dot" />{l.name}
        </button>
      ))}
    </nav>
  )
}

// ---------------------------------------------------------------- icons (2 px rounded strokes)
const I = ({ d, size = 18 }: { d: string; size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
)
const IC = {
  poly: 'M12 3l8 6-3 11H7L4 9z', rect: 'M4 6h16v12H4z', pin: 'M12 21s-7-6.2-7-12a7 7 0 0 1 14 0c0 5.8-7 12-7 12zM12 11.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  layers: 'M12 3l9 5-9 5-9-5 9-5zM3 13l9 5 9-5', filter: 'M4 6h16M7 12h10M10 18h4', dl: 'M12 4v11M7 10l5 5 5-5M5 20h14',
  info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-4M12 8h.01', play: 'M7 4l13 8-13 8z', pause: 'M7 4h3v16H7zM14 4h3v16h-3z', x: 'M6 6l12 12M18 6L6 18',
  tower: 'M12 10v11M8 21h8M5 7a9 9 0 0 1 14 0M8 9.5a5 5 0 0 1 8 0M12 10a1 1 0 1 0 0-2 1 1 0 0 0 0 2z', watch: 'M8 21l2-11h4l2 11M6 10h12M7 10l5-6 5 6M10 15h4',
  dome: 'M4 20h16M5 20v-6a7 7 0 0 1 14 0v6M12 7v4M9 20v-4h6v4',
}

function Logo({ size = 18 }: { size?: number }) {
  return (
    <svg width={size * 1.6} height={size} viewBox="0 0 38 24" aria-hidden="true">
      <defs><linearGradient id="lg" gradientUnits="userSpaceOnUse" x1="1" y1="16" x2="23" y2="16"><stop offset="0" stopColor="#4A0C6B" /><stop offset=".6" stopColor="#ED6925" /><stop offset="1" stopColor="#FCFFA4" /></linearGradient></defs>
      <path d="M1 16h22" stroke="url(#lg)" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M30 3c2.6 3.6 6 6.4 6 10.2A6 6 0 0 1 24 13.2C24 9.4 27.4 6.6 30 3z" fill="#FB9B06" />
      <circle cx="30" cy="14.5" r="2.6" fill="#FCFFA4" />
    </svg>
  )
}

export default function App() {
  const [presets, setPresets] = useState<Preset[]>([])
  const [coverage, setCoverage] = useState<any>(null)
  const [methods, setMethods] = useState<Methods | undefined>()
  const [backtest, setBacktest] = useState<Backtest | undefined>()
  const [aoiSel, setAoiSel] = useState<AoiSel>({ kind: 'preset', id: 'corrientes' })
  const lastGood = useRef<AoiSel>({ kind: 'preset', id: 'corrientes' })
  const [pin, setPin] = useState({ lat: '-28.5', lon: '-57.2', r: 25 })
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
  const [selMonth, setSelMonth] = useState<[number, number] | null>(null)
  const [cached, setCached] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [drawMode, setDrawMode] = useState<DrawMode>('none')
  const [pop, setPop] = useState<Pop>(null)
  const [modal, setModal] = useState<null | 'card' | 'methods'>(null)
  const [intro, setIntro] = useState(() => store.get('emberline_intro') !== 'seen' || new URLSearchParams(location.search).has('intro'))
  const [entering, setEntering] = useState(false)
  const [cine, setCine] = useState(false)   // replay title card
  // replay
  const [replayMode, setReplayMode] = useState(false)
  const [playing, setPlaying] = useState(false)
  const [replayDate, setReplayDate] = useState(REPLAY_START)
  const [replayDone, setReplayDone] = useState(false)
  const [shock, setShock] = useState<{ key: number; sev: boolean } | null>(null)
  const [flag, setFlag] = useState<string | null>(null)
  const playRef = useRef(false)
  const cardRef = useRef<HTMLDivElement>(null)
  const calRef = useRef<HTMLDivElement>(null)

  const say = useCallback((m: string) => { setToast(m); window.setTimeout(() => setToast(t => (t === m ? null : t)), 6000) }, [])

  // ------------------------------------------------------------ static data
  useEffect(() => {
    get<{ presets: Preset[] }>('/api/presets', 'presets', 8000).then(r => setPresets(r.data.presets)).catch(e => say(String(e.message)))
    get<any>('/api/coverage', 'coverage', 8000).then(r => setCoverage(r.data.polygon)).catch(() => {})
    get<Methods>('/api/methods', 'methods', 8000).then(r => setMethods(r.data)).catch(() => {})
    get<Backtest>('/api/backtest/corrientes-2022', 'backtest', 8000).then(r => setBacktest(r.data)).catch(() => {})
  }, [say])

  const aoi: AOI | null = useMemo(() => {
    if (aoiSel.kind === 'preset') return presets.find(p => p.id === aoiSel.id)?.geometry ?? null
    if (aoiSel.kind === 'geom') return aoiSel.geom
    return { lat: aoiSel.lat, lon: aoiSel.lon, radius_km: aoiSel.radius_km }
  }, [aoiSel, presets])
  const aoiGeom: Geometry | null = useMemo(() => (!aoi ? null : 'lat' in aoi ? circlePolygon(aoi.lat, aoi.lon, aoi.radius_km) : aoi), [aoi])
  const aoiName = aoiSel.kind === 'preset' ? presets.find(p => p.id === aoiSel.id)?.name ?? 'Corrientes' : aoiSel.kind === 'circle' ? `${aoiSel.radius_km} km · ${aoiSel.lat}, ${aoiSel.lon}` : 'Drawn area'
  const fitKey = JSON.stringify(aoiSel).slice(0, 200)

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
    Promise.all([post<QueryResult>('/api/query', body, fbKey('query')), post<EventsResult>('/api/events', body, fbKey('events'))])
      .then(([a, b]) => { if (stale) return; setQ(a.data); setEv(b.data); setCached(a.cached || b.cached); lastGood.current = aoiSel })
      .catch(e => {
        if (stale) return
        if (e instanceof ApiError && e.status === 400) { say(e.message.includes('outside') ? 'Outside coverage: Emberline covers Corrientes, Argentina.' : e.message); setAoiSel(lastGood.current) }
        else say(e.message)
      })
      .finally(() => { if (!stale) setLoading(false) })
    return () => { stale = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [body, replayMode])

  const loadDetections = useCallback((s: string, e: string) => {
    if (!aoi) return
    post<Detections>('/api/detections', { aoi, start: s, end: e, filters }, null, 10000).then(r => setDet(r.data)).catch(() => setDet(null))
  }, [aoi, filters])
  useEffect(() => {
    if (!q || selMonth) return
    loadDetections(addDays(q.summary.as_of, -6), q.summary.as_of)
  }, [q?.summary.as_of, aoi, filters]) // eslint-disable-line react-hooks/exhaustive-deps

  const pickMonth = (y: number, m: number) => {
    const s = `${y}-${String(m).padStart(2, '0')}-01`
    const e = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)
    setSelMonth([y, m])
    loadDetections(s, e)
  }
  const clearMonth = () => { setSelMonth(null); if (q) loadDetections(addDays(q.summary.as_of, -6), q.summary.as_of) }

  // ------------------------------------------------------------ replay (§7.1, §7.4; FRONTEND.md frame 07)
  const prevLevel = useRef<string>('Normal')
  const seenFlags = useRef<Set<string>>(new Set())
  const detBusy = useRef(false)
  const replayAt = useCallback(async (d: string) => {
    const corr = presets.find(p => p.id === 'corrientes')
    if (!corr) return
    const r = await post<ReplayResult>('/api/replay', { aoi: corr.geometry, as_of: d, filters: DEFAULT_FILTERS }, `replay_corrientes_${d}`, 8000)
    setQ(r.data); setEv(r.data.events); setCached(r.cached); setReplayDate(d)
    const lvl = r.data.summary.status.level
    if ((lvl === 'Elevated' || lvl === 'Extreme') && lvl !== prevLevel.current && !(prevLevel.current === 'Extreme' && lvl === 'Elevated'))
      setShock({ key: Date.now(), sev: lvl === 'Extreme' })
    prevLevel.current = lvl
    const passed = (backtest?.markers ?? []).filter(m => m.date <= d && !seenFlags.current.has(m.date + m.label))
    passed.forEach(m => seenFlags.current.add(m.date + m.label))
    if (passed.length) { const m = passed[passed.length - 1]; setFlag(`${m.label.split(',')[0]} · ${niceDate(m.date)}${m.verified ? '' : ' (unverified)'}`); window.setTimeout(() => setFlag(null), 2600) }
    if (!detBusy.current) {
      detBusy.current = true
      post<Detections>('/api/detections', { aoi: corr.geometry, start: addDays(d, -6), end: d, filters: DEFAULT_FILTERS }, null, 6000)
        .then(x => setDet(x.data)).catch(() => {}).finally(() => { detBusy.current = false })
    }
  }, [presets, backtest])

  const runReplay = async (from = REPLAY_START) => {
    setAoiSel({ kind: 'preset', id: 'corrientes' }); setSelMonth(null); setReplayMode(true); setReplayDone(false)
    setLens('response'); setPlaying(true); setPop(null); setDrawMode('none')
    if (from === REPLAY_START) {
      prevLevel.current = 'Normal'; seenFlags.current = new Set(); setReplayDate(REPLAY_START)
      setCine(true)
      await new Promise(res => setTimeout(res, 1900))
      setCine(false)
    }
    playRef.current = true
    let d = from
    while (playRef.current && d <= REPLAY_END) {
      setAsOf(d)
      try { await replayAt(d) } catch (e: any) { say(e.message); break }
      await new Promise(res => setTimeout(res, 300))
      d = addDays(d, REPLAY_STEP_DAYS)
    }
    if (playRef.current) setReplayDone(true)
    playRef.current = false
    setPlaying(false)
  }
  const pause = () => { playRef.current = false; setPlaying(false) }
  const exitReplay = () => { pause(); setReplayMode(false); setReplayDone(false); setAsOf(''); setShock(null) }

  // ------------------------------------------------------------ exports
  const exportCsv = async (kind: 'hotspots' | 'summary') => {
    if (!body) return
    try { await downloadCsv(`/api/export/${kind}.csv`, body, `emberline_${kind}.csv`) } catch (e: any) { say(`CSV export needs the live API: ${e.message}`) }
  }
  const exportPng = async (el: HTMLElement | null, name: string) => {
    if (!el) return
    const url = await toPng(el, { backgroundColor: '#0B0F17', pixelRatio: 2 })
    const a = document.createElement('a'); a.href = url; a.download = name; a.click()
  }

  const applyPin = () => {
    const lat = Number(pin.lat), lon = Number(pin.lon)
    if ([lat, lon].some(Number.isNaN)) { say('Enter numeric latitude and longitude.'); return }
    if (replayMode) exitReplay()
    setSelMonth(null); setPop(null)
    setAoiSel({ kind: 'circle', lat, lon, radius_km: pin.r })
  }
  const choosePost = (l: Lens) => {
    setLens(l); setIntro(false); store.set('emberline_intro', 'seen')
    setEntering(true); window.setTimeout(() => setEntering(false), 1600)
  }
  const tryOwnArea = () => { exitReplay(); setDrawMode('rectangle') }

  const status = q?.summary.status
  const level = status?.level ?? 'No data'
  const curMonth = q ? Number(q.summary.as_of.slice(5, 7)) : undefined
  const selCell = selMonth && q ? q.calendar_monthly.find(c => c.year === selMonth[0] && c.month === selMonth[1]) : null
  const lensColor = LENSES.find(l => l.id === lens)!.color

  return (
    <div className={`app lens-${lens}${replayMode ? ' replay' : ''}${entering ? ' entering' : ''}${loading ? ' is-loading' : ''}${intro ? ' behind-intro' : ''}`}>
      <Topo /><div className="sgrid" aria-hidden="true" /><div className="grain" aria-hidden="true" />
      {/* ------------------------------------------------------ top bar */}
      <header className="topbar">
        <div className="tb-left">
          <button className="logo" onClick={() => setIntro(true)} title="Replay the opening"><Logo /> EMBERLINE</button>
          <span className="sep" />
          <span className="region" title="Coverage: Corrientes, Argentina">Corrientes, AR</span>
          <span className="chip aoi" title={aoiName}><i className="dot" /><span>{aoiName}</span></span>
        </div>
        <Tabs lens={lens} setLens={setLens} />
        <div className="tb-right">
          {q && <span className={`status s-${lvlKey(level)}`} title={status?.sentence}><span className="ico">{LEVEL_ICON[level]}</span>{level}</span>}
          <span className="chip hide-sm" title="As-of date: everything is recomputed using only data up to this date">
            As of&nbsp;<input type="date" aria-label="As-of date" value={asOf || q?.summary.as_of || ''} max={q?.summary.last_observed_day}
              onChange={e => { setReplayMode(false); setSelMonth(null); setAsOf(e.target.value) }} />
            {asOf && !replayMode && <button className="link" onClick={() => setAsOf('')}>today</button>}
          </span>
          {cached && <span className="chip cached" title="The live API did not answer in time; showing precomputed real results">↻ cached</span>}
          <button className="icon-btn" aria-label="Methods and credits" onClick={() => setModal('methods')}><I d={IC.info} /></button>
          <button className="btn" onClick={() => setModal('card')}><I d={IC.dl} /><span>Export</span></button>
        </div>
      </header>

      {/* ------------------------------------------------------ body */}
      <div className="body">
        <section className="stage" aria-label="Map">
          {loading && <div className="loading-bar" />}
          <div className="blueprint" aria-hidden="true" /><Corners />
          <MapView coverage={coverage} aoi={aoiGeom} detections={det} drawMode={drawMode} accent={lensColor} fitKey={fitKey + lens}
            onDraw={g => { if (replayMode) exitReplay(); setSelMonth(null); setAoiSel({ kind: 'geom', geom: g }) }}
            onPin={(lat, lon) => { setPin(p => ({ ...p, lat: String(lat), lon: String(lon) })); if (replayMode) exitReplay(); setSelMonth(null); setAoiSel({ kind: 'circle', lat, lon, radius_km: pin.r }) }}
            onModeDone={() => setDrawMode('none')}
            rings={(lens === 'response' || replayMode) && ev?.current ? [{ lat: ev.current.centroid_lat, lon: ev.current.centroid_lon, label: `Fire #${fmt(ev.current.rank_footprint)} · ${fmt(ev.current.footprint_km2)} km²` }] : []} />
          {!replayMode && lens !== 'research' && (
            <div className="stage-title" key={lens} aria-hidden="true">
              <span className="kicker">{LENSES.find(l => l.id === lens)!.name}</span>
              <span className="word">{LENSES.find(l => l.id === lens)!.role}</span>
            </div>
          )}

          {!replayMode && <>
            <div className="rail" role="toolbar" aria-label="Area tools">
              <button data-tip="Draw rectangle" aria-label="Draw rectangle" className={drawMode === 'rectangle' ? 'on' : ''} onClick={() => { setPop(null); setDrawMode(drawMode === 'rectangle' ? 'none' : 'rectangle') }}><I d={IC.rect} /></button>
              <button data-tip="Draw polygon" aria-label="Draw polygon" className={drawMode === 'polygon' ? 'on' : ''} onClick={() => { setPop(null); setDrawMode(drawMode === 'polygon' ? 'none' : 'polygon') }}><I d={IC.poly} /></button>
              <button data-tip="Drop pin (lat/lon)" aria-label="Drop pin" className={pop === 'pin' || drawMode === 'pin' ? 'on' : ''} onClick={() => { setDrawMode('none'); setPop(pop === 'pin' ? null : 'pin') }}><I d={IC.pin} /></button>
              <button data-tip="Presets" aria-label="Presets" className={pop === 'presets' ? 'on' : ''} onClick={() => { setDrawMode('none'); setPop(pop === 'presets' ? null : 'presets') }}><I d={IC.layers} /></button>
              <button data-tip="Filters & dates" aria-label="Filters" className={pop === 'filters' ? 'on' : ''} onClick={() => { setDrawMode('none'); setPop(pop === 'filters' ? null : 'filters') }}><I d={IC.filter} /></button>
            </div>
            {drawMode === 'rectangle' && <div className="hint">Drag to draw a rectangle</div>}
            {drawMode === 'polygon' && <div className="hint">Click to add points · click the first point to finish</div>}
            {drawMode === 'pin' && <div className="hint">Click the map to drop a {pin.r} km pin</div>}

            {pop === 'pin' && (
              <div className="pop">
                <h4>Drop a pin</h4>
                <div className="row2">
                  <label>Latitude<input value={pin.lat} onChange={e => setPin({ ...pin, lat: e.target.value })} inputMode="decimal" /></label>
                  <label>Longitude<input value={pin.lon} onChange={e => setPin({ ...pin, lon: e.target.value })} inputMode="decimal" /></label>
                </div>
                <label>Radius: {pin.r} km<input type="range" min={5} max={100} value={pin.r} onChange={e => setPin({ ...pin, r: +e.target.value })} /></label>
                <div className="btn-row"><button className="btn accent" onClick={applyPin}>Go</button><button className="btn" onClick={() => { setPop(null); setDrawMode('pin') }}>Click on map</button></div>
              </div>
            )}
            {pop === 'presets' && (
              <div className="pop">
                <h4>Presets</h4>
                <div className="list">
                  <button onClick={() => runReplay()} style={{ color: 'var(--gold)' }}>▶ Replay Corrientes 2022</button>
                  <div className="grp">Province</div>
                  {presets.filter(p => p.kind !== 'department').map(p => <button key={p.id} className={aoiSel.kind === 'preset' && aoiSel.id === p.id ? 'on' : ''} onClick={() => { setSelMonth(null); setAoiSel({ kind: 'preset', id: p.id }); setPop(null) }}>{p.name}</button>)}
                  <div className="grp">Departments</div>
                  {presets.filter(p => p.kind === 'department').map(p => <button key={p.id} className={aoiSel.kind === 'preset' && aoiSel.id === p.id ? 'on' : ''} onClick={() => { setSelMonth(null); setAoiSel({ kind: 'preset', id: p.id }); setPop(null) }}>{p.name}</button>)}
                </div>
              </div>
            )}
            {pop === 'filters' && (
              <div className="pop">
                <h4>Filters</h4>
                <label className="chk"><input type="checkbox" checked={filters.min_conf === 'all'} onChange={e => setFilters({ ...filters, min_conf: e.target.checked ? 'all' : 'nominal' })} /> Include low-confidence detections</label>
                <label className="chk"><input type="checkbox" checked={filters.include_static} onChange={e => setFilters({ ...filters, include_static: e.target.checked })} /> Include static / other sources</label>
                <label>Day / night<select value={filters.daynight} onChange={e => setFilters({ ...filters, daynight: e.target.value as Filters['daynight'] })}>
                  <option value="all">Day and night</option><option value="D">Day only</option><option value="N">Night only</option></select></label>
                <h4>Date range</h4>
                <div className="row2">
                  <label>From<input type="date" value={start} onChange={e => setStart(e.target.value)} /></label>
                  <label>To<input type="date" value={end} onChange={e => setEnd(e.target.value)} /></label>
                </div>
                <h4>Baseline years</h4>
                <div className="row2">
                  <label>From<input placeholder="all" value={baseline.from} onChange={e => setBaseline({ ...baseline, from: e.target.value })} /></label>
                  <label>To<input placeholder="all" value={baseline.to} onChange={e => setBaseline({ ...baseline, to: e.target.value })} /></label>
                </div>
                <label className="chk"><input type="checkbox" checked={raw} onChange={e => setRaw(e.target.checked)} /> Show raw (naive) hotspot counts</label>
                <button className="btn block" onClick={() => { setFilters(DEFAULT_FILTERS); setStart('2001-01-01'); setEnd(''); setBaseline({ from: '', to: '' }); setRaw(false) }}>Reset</button>
              </div>
            )}

            {q && lens === 'response' && !pop && (
              <div key={level} className={`orb-card ${lvlKey(level)}`} role="status">
                <div className={`orb ${lvlKey(level)}`} aria-hidden="true">{LEVEL_ICON[level]}</div>
                <div>
                  <div className={`lvl ${lvlKey(level)}`}>{level}</div>
                  <div className="head">{LEVEL_HEAD[level]}</div>
                  <div className="why">{level === 'No data' ? 'Satellite coverage is incomplete for the last 7 days.' : `For ${partOfMonth(q.summary.as_of)} in this area`}</div>
                </div>
              </div>
            )}
            {q && lens === 'ranger' && !pop && selCell && (
              <div className="sel-card">
                <span className="tag">Selected</span>
                <b>{MONTHS[selCell.month - 1]} {selCell.year}</b>
                <span className="hl">{selCell.value == null ? 'no data' : `${fmt(selCell.value)} burning cells`}</span>
                {selCell.provenance !== 'observed' && <span className="muted" style={{ fontSize: 12 }}> · ≈ {selCell.provenance}</span>}
                <div><button className="link" style={{ background: 'none', border: 0, color: 'var(--research)', padding: 0, fontSize: 12, marginTop: 4 }} onClick={clearMonth}>back to last 7 days</button></div>
              </div>
            )}
            <div className="map-legend">
              <span>{selMonth ? `${MONTHS[selMonth[1] - 1]} ${selMonth[0]}` : 'Last 7 days'}</span><span className="muted">older</span><i className="grad" /><span className="muted">newest</span>
              {det && <span className="num muted">· {fmt(det.n)} hotspots{det.truncated ? ' (truncated)' : ''}</span>}
            </div>
          </>}

          {replayMode && q && (
            <>
              <div className="replay-head">
                <button className="x" aria-label="Exit replay" onClick={exitReplay}>✕</button>
                <div><span className="tag" style={{ color: 'var(--gold)' }}>Replay</span><b>Corrientes · summer 2021–22</b></div>
              </div>
              <div className={`replay-date ${lvlKey(level)}`}>
                <span className={`mini-orb orb ${lvlKey(level)}`} />
                <div><b key={replayDate} className="tick">{niceDate(replayDate)}</b><span className={`status s-${lvlKey(level)}`} style={{ height: 22, fontSize: 11, padding: '0 8px', marginTop: 4 }}><span className="ico">{LEVEL_ICON[level]}</span>{level}</span></div>
              </div>
              {shock && <div key={shock.key} className={`shock${shock.sev ? ' sev' : ''}`} />}
              {cine && <div className="cine-card"><span className="tag">Replay · Corrientes</span><b>Would we have seen it coming?</b><span>1 Dec 2021 → 15 Mar 2022 · only data available on each day</span></div>}
              {flag && <div className="flag-pop">⚑ {flag}</div>}
              {replayDone && backtest && <EndCard bt={backtest} onAgain={() => runReplay()} onOwn={tryOwnArea} />}
            </>
          )}
          {toast && <div className="toast" role="alert">{toast}</div>}
        </section>

        {/* ------------------------------------------------------ lens panels */}
        <Boundary resetKey={lens + (q?.summary.as_of ?? '')}>{!q ? (
          <div className="panel"><div className="skeleton" /><div className="skeleton" /><div className="skeleton" /></div>
        ) : lens === 'response' ? (
          <ResponsePanel key="response" q={q} ev={ev} bt={backtest} curMonth={curMonth} onReplay={() => runReplay()} onCard={() => setModal('card')} />
        ) : lens === 'ranger' ? (
          <RangerPanel key="ranger" q={q} raw={raw} setRaw={setRaw} selMonth={selMonth} onPick={pickMonth} calRef={calRef} onPng={() => exportPng(calRef.current, 'emberline_calendar.png')} />
        ) : (
          <ResearchPanel key="research" q={q} ev={ev} methods={methods} onCsv={exportCsv} onPng={() => exportPng(document.querySelector('.panel') as HTMLElement, 'emberline_research.png')} />
        )}</Boundary>
      </div>

      {/* ------------------------------------------------------ timeline dock */}
      <footer className="dock">
        {replayMode
          ? (playing ? <RingButton gold progress={((Date.parse(replayDate) - Date.parse(REPLAY_START)) / (Date.parse(REPLAY_END) - Date.parse(REPLAY_START)))} onClick={pause} label="Pause"><I d={IC.pause} size={16} /></RingButton>
            : <RingButton gold progress={replayDone ? 1 : ((Date.parse(replayDate) - Date.parse(REPLAY_START)) / (Date.parse(REPLAY_END) - Date.parse(REPLAY_START)))} onClick={() => runReplay(replayDone ? REPLAY_START : addDays(replayDate, REPLAY_STEP_DAYS))} label={replayDone ? 'Again' : 'Play'}><I d={IC.play} size={16} /></RingButton>)
          : <RingButton gold progress={0} onClick={() => runReplay()} label="Replay 2022"><I d={IC.play} size={16} /></RingButton>}
        {replayMode && backtest ? <ReplayDock bt={backtest} start={REPLAY_START} end={REPLAY_END} cur={replayDate} />
          : q ? <MainDock cells={q.calendar_monthly} asOf={q.summary.as_of} lastDay={q.summary.last_observed_day > q.summary.as_of ? q.summary.last_observed_day : q.summary.as_of} windows={q.critical_windows.windows} selected={selMonth}
            onScrub={d => { setSelMonth(null); setAsOf(d >= (q.summary.last_observed_day ?? d) ? '' : d) }} /> : <div />}
        <div className="dock-legend">
          {replayMode ? <><span><i style={{ background: '#F59E0B', opacity: .5 }} />Alert days</span><span><i style={{ background: '#FB9B06', height: 2 }} />7-day burning cells</span></>
            : <><span><i style={{ background: '#A3E635', opacity: .5 }} />Critical window</span><span><i style={{ background: '#FB9B06', height: 2 }} />Burning cells</span></>}
        </div>
      </footer>

      {modal === 'card' && q && (
        <div className="scrim" onClick={() => setModal(null)}>
          <div className="modal" onClick={e => e.stopPropagation()} role="dialog" aria-label="Field card">
            <FieldCard ref={cardRef} q={q} ev={ev} name={aoiName} />
            <div className="side">
              <h2>Field card</h2>
              <p className="muted" style={{ margin: 0 }}>One page for the field. Shareable PNG.</p>
              <button className="btn accent" onClick={() => exportPng(cardRef.current, 'emberline_field_card.png')}><I d={IC.dl} />Download PNG</button>
              <button className="btn" onClick={() => exportCsv('hotspots')}>Hotspots CSV</button>
              <button className="btn" onClick={() => exportCsv('summary')}>Summary CSV</button>
              <p className="note">CSV files are generated live by the API for the current area, dates and filters.</p>
              <button className="btn" style={{ marginTop: 'auto' }} onClick={() => setModal(null)}>Close</button>
            </div>
          </div>
        </div>
      )}
      {modal === 'methods' && <MethodsDrawer q={q} methods={methods} bt={backtest} onClose={() => setModal(null)} />}
      {intro && <Intro onChoose={choosePost} coverage={coverage} det={det} />}
    </div>
  )
}

// ================================================================ Response Station
function ResponsePanel({ q, ev, bt, curMonth, onReplay, onCard }: { q: QueryResult; ev: EventsResult | null; bt?: Backtest; curMonth?: number; onReplay: () => void; onCard: () => void }) {
  const c = q.current_vs_median
  const base = Object.values(c.baseline ?? {}).filter((v): v is number => v != null).sort((a, b) => a - b)
  const qt = (p: number) => (base.length ? base[Math.min(base.length - 1, Math.floor(p * (base.length - 1)))] : 0)
  const top = Math.max(1, c.value ?? 0, base[base.length - 1] ?? 0)
  const pos = (v: number) => `${(Math.sqrt(Math.max(0, v) / top) * 100).toFixed(1)}%`
  const main = q.critical_windows.windows[0]
  const doy = Math.round((Date.parse(q.summary.as_of + 'T00:00:00Z') - Date.UTC(+q.summary.as_of.slice(0, 4), 0, 1)) / 864e5) + 1
  const inside = main ? (main.start_doy <= main.end_doy ? doy >= main.start_doy && doy <= main.end_doy : doy >= main.start_doy || doy <= main.end_doy) : false
  const dayIn = main && inside ? ((doy - main.start_doy + 365) % 365) + 1 : 0
  const until = main && !inside ? (main.start_doy - doy + 365) % 365 : null
  const winLabel = !main ? 'No clear season' : inside ? `● Inside window · day ${dayIn}` : (q.summary.status.level === 'Elevated' || q.summary.status.level === 'Extreme') ? '▲ Off-season' : `Opens in ${until} days`
  const offSeasonFire = main && !inside && (q.summary.status.level === 'Elevated' || q.summary.status.level === 'Extreme')
  const winSentence = !main ? q.critical_windows.sentence
    : offSeasonFire ? `Usual season is ${main.start} – ${main.end}. This burning is outside it.`
    : `Main fire season ${main.start} – ${main.end}: ${fmt(main.share_of_annual)}% of yearly burning.`
  const events = (ev?.top ?? []).slice(0, 14)
  const cur = ev?.current
  if (cur && !events.some(e => e.event_id === cur.event_id)) events.push(cur)
  const maxFp = Math.max(1, ...events.map(e => e.footprint_km2))
  const verified = bt?.markers.find(m => m.verified)
  return (
    <aside className="panel" aria-label="Response Station">
      <div className="card">
        <div className="card-h"><h3>Now vs normal</h3><span className="right">days 1–{c.days_compared} of {c.month}</span></div>
        <div className="big-row">
          <span className="big"><CountUp value={c.ratio} digits={1} suffix="×" /></span>
          <span className="muted">the median{c.rank != null ? ` · rank ${c.rank} of ${c.n}` : ''}</span>
        </div>
        <div className="gauge" aria-label={`Now ${fmt(c.value)} vs median ${fmt(c.median)} burning cells`}>
          <div className="track" />
          {base.length > 0 && <div className="iqr" style={{ left: pos(qt(0.25)), width: `calc(${pos(qt(0.75))} - ${pos(qt(0.25))})` }} />}
          {c.median != null && <div className="med" style={{ left: pos(c.median) }} />}
          {c.value != null && <div className={`now ${q.summary.status.level}`} style={{ left: pos(c.value) }} />}
        </div>
        <div className="gauge-legend"><span>Median {fmt(c.median)} · usual range</span><span>Now {fmt(c.value)}</span></div>
      </div>

      <div className="card">
        <div className="card-h"><h3>This fire vs past fires</h3>{cur && <span><b className="hl" style={{ fontSize: 22, fontFamily: 'var(--display)' }}>#{fmt(cur.rank_footprint)}</b> <span className="muted">of {fmt(ev?.n_events)} since 2012</span></span>}</div>
        <div className="strip" aria-hidden="true">
          {events.sort((a, b) => b.footprint_km2 - a.footprint_km2).map(e => <i key={e.event_id} className={cur && e.event_id === cur.event_id ? 'me' : ''} style={{ height: `${Math.max(4, Math.sqrt(e.footprint_km2 / maxFp) * 100)}%` }} title={`${e.start} → ${e.end}: ${fmt(e.footprint_km2)} km² footprint`} />)}
        </div>
        <p className="sent">{cur ? <>Footprint ≈ <b>{fmt(cur.footprint_km2)} km²</b> over {cur.duration_days} days</> : 'No active fire in the last 7 days.'}</p>
        <p className="note">Footprint = burning grid cells, not burned area. Events since 2012 (VIIRS era).</p>
      </div>

      <div className="card">
        <div className="card-h"><h3>Season check</h3><span style={{ color: inside ? 'var(--ranger)' : 'var(--elevated)', fontWeight: 600, fontSize: 13 }}>{winLabel}</span></div>
        <SeasonBars q={q} windows={q.critical_windows.windows} curMonth={curMonth} />
        <p className="sent">{winSentence}</p>
      </div>

      {bt && (
        <div className="card">
          <div className="card-h"><h3>Would we have seen it coming?</h3><span className="right">Corrientes 2022</span></div>
          {verified?.days_after_episode_onset != null && <div className="big-row"><span className="big md"><CountUp value={verified.days_after_episode_onset} prefix="+" /></span><span className="muted">days before the verified decree</span></div>}
          <p className="sent">Rule fixed on 2003–2021. Severe in {bt.honesty.n_severe} of {bt.honesty.n_seasons} past seasons.</p>
          <button className="btn gold block" style={{ marginTop: 12 }} onClick={onReplay}><I d={IC.play} size={14} />Replay Corrientes 2022</button>
        </div>
      )}

      <div className="card" style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
        <div style={{ width: 56, height: 72, borderRadius: 10, border: '1px solid var(--line-600)', background: 'linear-gradient(180deg,#781C6D,#FB9B06 60%,#0B0F17 61%)', flex: 'none' }} aria-hidden="true" />
        <div style={{ flex: 1 }}>
          <h3 style={{ margin: '0 0 8px', fontSize: 15 }}>Field card</h3>
          <button className="btn accent block" onClick={onCard}><I d={IC.dl} />Download PNG</button>
        </div>
      </div>
    </aside>
  )
}

// ================================================================ Ranger Post
function RangerPanel({ q, raw, setRaw, selMonth, onPick, calRef, onPng }: { q: QueryResult; raw: boolean; setRaw: (b: boolean) => void; selMonth: [number, number] | null; onPick: (y: number, m: number) => void; calRef: React.RefObject<HTMLDivElement | null>; onPng: () => void }) {
  const years = q.calendar_monthly.map(c => c.year)
  const y0 = Math.min(...years), y1 = Math.max(...years)
  const headline = useMemo(() => {
    const recent = q.anomalies.monthly.filter(m => m.ratio != null && m.year >= y1 - 5 && (q.calendar_monthly.find(c => c.year === m.year && c.month === m.month)?.value ?? 0) >= 50)
    const top = recent.sort((a, b) => (b.ratio ?? 0) - (a.ratio ?? 0))[0]
    return top ? `${MONTHS[top.month - 1]} ${top.year}: ${top.ratio!.toFixed(1)}× the usual ${MONTHS[top.month - 1]}` : q.peaks.sentence
  }, [q, y1])
  const win = q.critical_windows.windows[0]
  const clockYear = selMonth?.[0] ?? Number(q.summary.as_of.slice(0, 4))
  const topYears = q.peaks.top_years
  const maxY = Math.max(1, ...topYears.map(t => t.total))
  const monthName = (doy: number) => MONTHS[new Date(Date.UTC(2001, 0, doy)).getUTCMonth()]
  return (
    <div className="panel grid" aria-label="Ranger Post">
      <div className="card wide" ref={calRef}>
        <div className="card-h">
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}><h2>Ember Calendar</h2><span className="sub">{raw ? 'raw hotspots' : 'burning cells'} / month · {y0}–{y1}</span></div>
          <span className="hl" style={{ fontSize: 13 }}>{headline}</span>
        </div>
        <EmberCalendar cells={q.calendar_monthly} raw={raw} onPick={onPick} selected={selMonth} />
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginTop: 8, flexWrap: 'wrap' }}>
          <span className="note" style={{ margin: 0 }}>Hatched rows before 2012: estimated from MODIS · 2012 →: observed, MODIS + VIIRS. Click a month to map it.</span>
          <span style={{ display: 'flex', gap: 8 }}>
            <button className="btn" style={{ height: 32 }} onClick={() => setRaw(!raw)} aria-pressed={raw}>{raw ? 'Show harmonized' : 'Show raw'}</button>
            <button className="btn" style={{ height: 32 }} onClick={onPng}><I d={IC.dl} size={14} />PNG</button>
          </span>
        </div>
      </div>

      <div className="card">
        <div className="card-h"><h3>Fire Clock</h3><span className="right">{clockYear} vs median</span></div>
        <FireClock q={q} year={clockYear} />
      </div>

      <div className="card">
        <div className="card-h"><h3>Top years</h3><span className="right">burning cells</span></div>
        <div className="bars">
          {topYears.map((t, i) => (
            <div key={t.year} className={`row${i === 0 ? ' top' : ''}`}>
              <span>{t.year}</span><span className="track"><span className="fill" style={{ display: 'block', width: `${(t.total / maxY) * 100}%` }} /></span><span>{fmt(t.total)}</span>
            </div>
          ))}
        </div>
        <p className="note">{topYears[0]?.year <= 2011 ? '≈ includes estimated pre-2012 years.' : 'Complete years only.'}</p>
      </div>

      <div className="card">
        <div className="card-h"><h3>Critical window</h3></div>
        {win ? <>
          <div className="big md lime" style={{ color: 'var(--ranger)', textShadow: 'none' }}>{monthName(win.start_doy)} – {monthName(win.end_doy)}</div>
          <div style={{ marginTop: 12 }}><SeasonBars q={q} windows={q.critical_windows.windows} /></div>
          <p className="sent">{fmt(win.share_of_annual)}% of a typical year's fire ({win.start}–{win.end}).</p>
        </> : <p className="sent">{q.critical_windows.sentence}</p>}
      </div>

      <div className="card">
        <div className="card-h"><h3>Year vs average</h3><span className="right">× multi-year mean</span></div>
        <AnnualAnomaly q={q} />
        <p className="sent">{annualSentence(q)}</p>
      </div>

      <div className="card" style={{ gridColumn: 'span 2' }}>
        <div className="card-h"><h3>Monthly anomalies</h3><span className="right">vs the usual for each month</span></div>
        <MonthlyAnomalyGrid q={q} />
        <p className="sent">{q.peaks.sentence}</p>
      </div>
    </div>
  )
}

function annualSentence(q: QueryResult) {
  const a = q.anomalies.annual.filter(r => r.complete && r.vs_mean_ratio != null)
  if (!a.length) return 'Not enough complete years.'
  const top = a.reduce((x, y) => ((y.vs_mean_ratio ?? 0) > (x.vs_mean_ratio ?? 0) ? y : x))
  return `${top.year}: ${top.vs_mean_ratio!.toFixed(1)}× the average year.`
}

// ================================================================ Research Lab
function ResearchPanel({ q, ev, methods, onCsv, onPng }: { q: QueryResult; ev: EventsResult | null; methods?: Methods; onCsv: (k: 'hotspots' | 'summary') => void; onPng: () => void }) {
  const share = q.sensor_diff.share_modis_cells_seen_by_viirs
  const h = methods?.holdout.k_M
  return (
    <div className="panel grid" aria-label="Research Lab">
      <div className="card wide">
        <div className="card-h">
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}><h2>Seam Splitter</h2><span className="sub">yearly fire activity, complete years</span></div>
          <span style={{ fontSize: 13 }}><span style={{ color: '#8AB4F8' }}>━ Raw, stitched</span>&nbsp;&nbsp;<span style={{ color: '#FB9B06' }}>━ Harmonized</span></span>
        </div>
        <SeamSplitter q={q} />
      </div>

      <div className="card">
        <div className="card-h"><h3>Who saw what</h3><span className="right">cell-days, 2012 →</span></div>
        <div className="big-row"><span className="big md" style={{ color: '#8AB4F8', textShadow: 'none' }}><CountUp value={share == null ? null : Math.round(share > 1 ? share : share * 100)} suffix="%" /></span><span className="muted">of MODIS cells also seen by VIIRS</span></div>
        <WhoSawWhat q={q} />
        <div className="legend"><span><i className="sw" style={{ background: '#DCE6F7' }} />VIIRS only</span><span><i className="sw" style={{ background: '#8AB4F8' }} />Both</span><span><i className="sw" style={{ background: '#3A4253' }} />MODIS only</span></div>
      </div>

      <div className="card">
        <div className="card-h"><h3>Bridge factor</h3><span className="right">cells per MODIS cell · 90% band</span></div>
        {methods ? <BridgeFactors methods={methods} /> : <div className="skeleton" />}
        <p className="note">Used to estimate pre-2012 months from MODIS alone. Fitted on {methods?.calibration.overlap_years[0]}–{methods?.calibration.overlap_years.slice(-1)[0]}.</p>
      </div>

      <div className="card">
        <div className="card-h"><h3>Tested on unseen years</h3><span className="right">hold-out</span></div>
        {h ? <div className="tiles">
          <div className="tile"><b>{fmt(h.mape_pct, 1)}%</b><span>Monthly error</span></div>
          <div className="tile"><b>{h.bias_pct > 0 ? '+' : ''}{fmt(h.bias_pct, 1)}%</b><span>Bias</span></div>
          <div className="tile"><b>{fmt(h.pearson_r, 3)}</b><span>Correlation</span></div>
          <div className="tile"><b>{fmt(h.interval_coverage_pct, 0)}%</b><span>Inside factor band</span></div>
        </div> : <div className="skeleton" />}
        <p className="note">Leave-one-year-out. The band is factor uncertainty only, so it is narrower than month-to-month error.</p>
        <div className="btn-row" style={{ marginTop: 10 }}>
          <button className="btn" onClick={() => onCsv('hotspots')}>Hotspots CSV</button>
          <button className="btn" onClick={() => onCsv('summary')}>Summary CSV</button>
          <button className="btn" onClick={onPng}>Charts PNG</button>
        </div>
      </div>

      <div className="card">
        <div className="card-h"><h3>Detected</h3><span className="right">{q.summary.start} → {q.summary.end}</span></div>
        <div className="tiles">
          <div className="tile"><b>{fmt(q.counts.burning_cell_days_harmonized)}</b><span>burning cell-days (harmonized)</span></div>
          <div className="tile"><b>{fmt(ev?.n_events)}</b><span>fire events since 2012</span></div>
          <div className="tile"><b>{fmt(q.counts.raw_hotspots.MODIS)}</b><span>MODIS hotspots</span></div>
          <div className="tile"><b>{fmt(q.counts.raw_hotspots.VIIRS_reference)}</b><span>VIIRS hotspots (reference)</span></div>
        </div>
        <p className="note">Raw counts are never added together. {q.counts.no_data_days} no-data days excluded, not zero.</p>
      </div>

      <div className="card">
        <div className="card-h"><h3>This area's factors</h3><span className="right">shrunk to region, n0 = {q.summary.calibration_used.n0}</span></div>
        <table><thead><tr><th>Month</th><th>k_M</th><th>n MODIS</th><th>k_V</th></tr></thead>
          <tbody>{MONTHS.map((m, i) => <tr key={m}><td>{m}</td><td>{q.summary.calibration_used.k_M[i + 1]?.toFixed(2)}</td><td>{fmt(q.summary.calibration_used.n_aoi_M[i + 1])}</td><td>{q.summary.calibration_used.k_V[i + 1]?.toFixed(2)}</td></tr>)}</tbody></table>
      </div>

      <div className="card">
        <div className="card-h"><h3>Sensor continuity</h3></div>
        <p className="sent">{q.sensor_diff.sentence}</p>
        <p className="sent">VIIRS reference: Suomi NPP until {q.summary.viirs_handover.snpp_last_data ?? '—'}; NOAA-20 fills SNPP gaps{q.summary.viirs_handover.noaa20_reference_from ? ` (from ${q.summary.viirs_handover.noaa20_reference_from} on most days)` : ''}.</p>
        {methods && <p className="note">Inter-VIIRS: {Object.entries(methods.inter_viirs).map(([k, v]) => `${k} ${v.overall?.toFixed(2) ?? '—'} (${v.apply ? 'scaled' : 'used as observed'})`).join(' · ')}. Terra drift flag: {methods.stability.drift_flag ? 'yes' : 'no'}.</p>}
      </div>
    </div>
  )
}

// ================================================================ replay end card
function EndCard({ bt, onAgain, onOwn }: { bt: Backtest; onAgain: () => void; onOwn: () => void }) {
  const [more, setMore] = useState(false)
  const v = bt.markers.find(m => m.verified)
  const lead = v?.days_after_episode_onset
  return (
    <div className="end-card" role="dialog" aria-label="Replay result">
      <span className="tag">Would we have seen it coming?</span>
      <div className="huge"><CountUp value={lead} prefix={lead != null && lead >= 0 ? '+' : ''} /><small>days</small></div>
      <p className="sent" style={{ fontSize: 14 }}>From our sustained alert ({bt.result.episode_onset ? niceDate(bt.result.episode_onset) : '—'}) to the first verified emergency decree ({v ? niceDate(v.date) : '—'}).</p>
      <div className="tiles" style={{ marginTop: 14 }}>
        <div className="tile"><b>{bt.honesty.n_severe} / {bt.honesty.n_seasons}</b><span>past seasons reached Severe</span></div>
        <div className="tile"><b>2003–21</b><span>rule fixed before 2022</span></div>
      </div>
      <button className="btn" style={{ height: 30, marginTop: 10, fontSize: 12 }} onClick={() => setMore(!more)}>{more ? 'Hide' : 'How often did this alert fire in other years?'}</button>
      {more && <div style={{ maxHeight: 180, overflowY: 'auto', marginTop: 8 }}>
        <p className="note" style={{ marginTop: 0 }}>{bt.honesty.sentence} Severe (first {bt.result.first_severe ? niceDate(bt.result.first_severe) : '—'}) is the stronger signal. A 2-day Alert blip on {bt.result.first_alert ? niceDate(bt.result.first_alert) : '—'} cleared on its own.</p>
        <table><thead><tr><th>Season</th><th>Alert</th><th>Severe</th></tr></thead>
          <tbody>{bt.honesty.seasons.map(s => <tr key={s.season}><td>{s.season}</td><td>{s.first_alert ?? '—'}</td><td>{s.first_severe ?? '—'}</td></tr>)}</tbody></table>
      </div>}
      <div className="btn-row" style={{ marginTop: 14 }}>
        <button className="btn gold" onClick={onAgain}>Replay again</button>
        <button className="btn" onClick={onOwn}>Try your own area</button>
      </div>
    </div>
  )
}

// ================================================================ field card (PNG)
const FieldCard = forwardRef<HTMLDivElement, { q: QueryResult; ev: EventsResult | null; name: string }>(({ q, ev, name }, ref) => {
  const lvl = q.summary.status.level
  const row = Number(q.summary.as_of.slice(0, 4))
  const cells = MONTHS.map((_, i) => q.calendar_monthly.find(c => c.year === row && c.month === i + 1))
  const max = Math.max(1, ...q.calendar_monthly.map(c => c.value ?? 0))
  return (
    <div ref={ref} className="fcard">
      <div className="logo"><Logo size={14} /> EMBERLINE · FIELD CARD</div>
      <h3>{name}</h3>
      <p className="muted" style={{ margin: '2px 0 10px' }}>As of {niceDate(q.summary.as_of)} · {fmt(q.summary.area_km2)} km²</p>
      <span className={`status s-${lvlKey(lvl)}`}><span className="ico">{LEVEL_ICON[lvl]}</span>{lvl}</span>
      <div className="row" style={{ marginTop: 10 }}><span>Now vs normal</span><b>{q.current_vs_median.ratio != null ? `${q.current_vs_median.ratio.toFixed(1)}× median` : '—'}{q.current_vs_median.rank != null ? ` · #${q.current_vs_median.rank} of ${q.current_vs_median.n}` : ''}</b></div>
      <div className="row"><span>Critical window</span><b>{q.critical_windows.windows[0] ? `${q.critical_windows.windows[0].start} – ${q.critical_windows.windows[0].end}` : '—'}</b></div>
      <div className="row"><span>Top years</span><b>{q.peaks.top_years.slice(0, 3).map(y => y.year).join(' · ')}</b></div>
      <div className="row"><span>Current fire</span><b>{ev?.current ? `#${ev.current.rank_footprint} since 2012 · ${fmt(ev.current.footprint_km2)} km²` : 'none active'}</b></div>
      <div style={{ marginTop: 10 }} className="muted">{row} by month</div>
      <div className="mini">{cells.map((c, i) => <i key={i} style={{ background: c?.value == null ? '#1d2331' : ember(0.06 + 0.94 * Math.sqrt(c.value / max)) }} />)}</div>
      <div className="foot">Burning cells = ~2.2 km grid cells with ≥1 active-fire detection per day; MODIS + VIIRS overlap counted once. Pre-2012 values are estimated from MODIS. No-data days are excluded, never zero. Data: NASA FIRMS (MODIS C6.1, VIIRS 375 m).</div>
    </div>
  )
})

// ================================================================ methods drawer
function MethodsDrawer({ q, methods, bt, onClose }: { q: QueryResult | null; methods?: Methods; bt?: Backtest; onClose: () => void }) {
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose(); window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k) }, [onClose])
  return (
    <div className="scrim" onClick={onClose} style={{ placeItems: 'stretch' }}>
      <div className="drawer" onClick={e => e.stopPropagation()} role="dialog" aria-label="Methods">
        <button className="icon-btn close" aria-label="Close" onClick={onClose}><I d={IC.x} /></button>
        <h2>Methods</h2>
        <p className="muted">How two sensors become one line.</p>
        <svg viewBox="0 0 480 120" style={{ width: '100%', margin: '12px 0' }} aria-label="MODIS and VIIRS lines merge into one harmonized line">
          <path d="M10 30 C120 30 160 60 240 60" stroke="#8A94A8" strokeWidth="3" fill="none" />
          <path d="M10 90 C120 90 160 60 240 60" stroke="#8AB4F8" strokeWidth="3" fill="none" />
          <path d="M240 60 H440" stroke="#FB9B06" strokeWidth="4" fill="none" />
          <circle cx="450" cy="60" r="9" fill="#FCFFA4" />
          <text x="10" y="20" fill="#B4BCCC" fontSize="12">MODIS 1 km · 2000 →</text>
          <text x="10" y="112" fill="#B4BCCC" fontSize="12">VIIRS 375 m · 2012 →</text>
          <text x="270" y="48" fill="#F7D13D" fontSize="12">burning cells / day</text>
        </svg>
        <h3>Same fire, counted once</h3>
        <ul>
          <li>Detections go onto a 0.02° (~2.2 km) grid. A cell counts once per day, however many pixels, passes or satellites saw it.</li>
          <li>One VIIRS satellite per day (S-NPP › NOAA-20 › NOAA-21), so new satellites don't inflate counts.</li>
          <li>Consecutive-day neighbouring cells are linked into fire events.</li>
        </ul>
        <h3>Observed · ≈ Estimated · ⊘ No data</h3>
        {q ? <ul>{Object.entries(q.provenance_legend).map(([k, v]) => <li key={k}><b>{k}</b>: {v}</li>)}</ul> : null}
        <h3>Calibration checks</h3>
        {methods && <p>Hold-out (MODIS → union): {fmt(methods.holdout.k_M.mape_pct, 1)}% monthly error, bias {fmt(methods.holdout.k_M.bias_pct, 1)}%, r = {fmt(methods.holdout.k_M.pearson_r, 3)}. {methods.seam_test.interpretation}</p>}
        <h3>Alert rule (pre-registered)</h3>
        <p>Signal: 7-day sum of burning cells. Thresholds: P90 (Alert) and P99 (Severe) of 2003–2021 values within ±15 days of the date. Needs 3 consecutive days. Fixed before looking at 2022; the same rule drives the status badge.</p>
        {bt && <p>{bt.honesty.sentence} {bt.honesty.note}</p>}
        {bt && <><h3>Official dates</h3><ul>{bt.markers.map(m => <li key={m.date + m.label}>{niceDate(m.date)}: <a href={m.source_url} target="_blank" rel="noreferrer">{m.label}</a>{m.verified ? '' : ' (unverified)'}</li>)}</ul>
          {bt.reported_official.map(r => <p key={r.fact} className="muted">Reported (official source{r.verified ? '' : ', unverified'}): {r.fact}</p>)}</>}
        <h3>Data credits</h3>
        <p>We acknowledge the use of data and/or imagery from NASA's Fire Information for Resource Management System (FIRMS), part of NASA's Earth Science Data and Information System (ESDIS). MODIS C6.1 (MCD14ML / MCD14DL) and VIIRS 375 m (VNP14IMG, VJ114IMG, VJ214IMG) active-fire products. Boundaries: geoBoundaries (CC BY 4.0). Basemap: OpenFreeMap © OpenMapTiles © OpenStreetMap contributors.</p>
        <p className="muted">Built with AI assistance (Claude); no AI model computes any number shown.</p>
      </div>
    </div>
  )
}
