import * as echarts from 'echarts'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { CalCell, Methods, QueryResult, Window } from './types'

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export const fmt = (v: number | null | undefined, d = 0) => (v == null || Number.isNaN(v) ? '—' : v.toLocaleString('en-US', { maximumFractionDigits: d }))

// ---------------------------------------------------------------- ramps (FRONTEND.md §2)
export const EMBER = ['#1B0C41', '#4A0C6B', '#781C6D', '#A52C60', '#CF4446', '#ED6925', '#FB9B06', '#F7D13D', '#FCFFA4']
export const ANOMALY = ['#4393C3', '#3A4253', '#F4A582', '#D6604D', '#B2182B']
function lerpHex(a: string, b: string, t: number) {
  const pa = [1, 3, 5].map(i => parseInt(a.slice(i, i + 2), 16))
  const pb = [1, 3, 5].map(i => parseInt(b.slice(i, i + 2), 16))
  return '#' + pa.map((v, i) => Math.round(v + (pb[i] - v) * t).toString(16).padStart(2, '0')).join('')
}
export function ramp(colors: string[], t: number) {
  const x = Math.min(1, Math.max(0, t)) * (colors.length - 1)
  const i = Math.min(colors.length - 2, Math.floor(x))
  return lerpHex(colors[i], colors[i + 1], x - i)
}
export const ember = (t: number) => ramp(EMBER, t)
// anomaly: ratio vs median → below (blue) · normal (neutral) · above (reds); log2 scale, ±2 (¼× … 4×)
export const anomaly = (ratio: number) => {
  const l = Math.max(-2, Math.min(2, Math.log2(Math.max(ratio, 1e-6))))
  return l < 0 ? ramp([ANOMALY[1], ANOMALY[0]], -l / 2) : ramp(ANOMALY.slice(1), l / 2)
}
export const EMBER_CSS = `linear-gradient(90deg, ${EMBER.join(',')})`
export const ANOMALY_CSS = `linear-gradient(90deg, ${ANOMALY.join(',')})`

const AXIS = { axisLine: { lineStyle: { color: '#2A3448' } }, axisLabel: { color: '#8A94A8', fontSize: 11 }, splitLine: { lineStyle: { color: '#1F2738' } }, axisTick: { show: false } }
const TOOLTIP = { backgroundColor: '#121826', borderColor: '#2A3448', textStyle: { color: '#E8ECF4', fontSize: 12 }, extraCssText: 'border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.4)' }

// ---------------------------------------------------------------- generic wrapper
export function EChart({ option, height = 260, onClick, label }: { option: echarts.EChartsCoreOption; height?: number; onClick?: (p: any) => void; label?: string }) {
  const ref = useRef<HTMLDivElement>(null)
  const chart = useRef<echarts.ECharts | null>(null)
  useEffect(() => {
    if (!ref.current) return
    chart.current = echarts.init(ref.current, undefined, { renderer: 'canvas' })
    const ro = new ResizeObserver(() => chart.current?.resize())
    ro.observe(ref.current)
    return () => { ro.disconnect(); chart.current?.dispose() }
  }, [])
  useEffect(() => { chart.current?.setOption(option, true) }, [option])
  useEffect(() => {
    if (!chart.current) return
    chart.current.off('click')
    if (onClick) chart.current.on('click', onClick)
  }, [onClick])
  return <div ref={ref} role="img" aria-label={label} style={{ width: '100%', height }} />
}

// ---------------------------------------------------------------- Ember Calendar (§6.1, signature graphic)
export function EmberCalendar({ cells, raw, onPick, selected }: { cells: CalCell[]; raw: boolean; onPick?: (y: number, m: number) => void; selected?: [number, number] | null }) {
  const years = useMemo(() => Array.from(new Set(cells.map(c => c.year))).sort((a, b) => a - b), [cells])
  const option = useMemo(() => {
    const val = (c: CalCell) => (raw ? c.raw_naive_hotspots : c.value)
    const vals = cells.map(val).filter((v): v is number => v != null && v > 0)
    const max = vals.length ? Math.max(...vals) : 1
    const data = cells.map(c => [c.month - 1, years.indexOf(c.year), val(c), c])
    const viirsRow = years.indexOf(2012)
    return {
      animation: false,
      grid: { left: 44, right: 6, top: 22, bottom: 4 },
      xAxis: { type: 'category', data: MONTHS.map(m => m[0]), position: 'top', ...AXIS, axisLine: { show: false }, axisLabel: { color: '#8A94A8', fontSize: 11 } },
      yAxis: { type: 'category', data: years.map(String), inverse: true, ...AXIS, axisLine: { show: false },
        axisLabel: { color: '#8A94A8', fontSize: 10, formatter: (y: string) => (selected && +y === selected[0] ? `{s|${y}}` : y), rich: { s: { color: '#F7D13D', fontWeight: 'bold', fontSize: 10 } } } },
      tooltip: {
        ...TOOLTIP,
        formatter: (p: any) => {
          const c: CalCell = p.data[3]
          const head = `<b>${MONTHS[c.month - 1]} ${c.year}</b>`
          if (!raw && c.value == null) return `${head}<br/>No data: no satellite coverage<br/><span style="color:#8A94A8">Coverage ${c.coverage_pct}% of days</span>`
          const v = raw ? `${fmt(c.raw_naive_hotspots)} raw hotspots (naive sum, not comparable across 2012)`
            : `<b style="font-size:15px">${fmt(c.value)}</b> burning cells` + (c.provenance !== 'observed' && c.low != null ? `<br/><span style="color:#8A94A8">factor range ${fmt(c.low)}–${fmt(c.high)}</span>` : '')
          const prov = c.provenance === 'observed' ? 'observed (MODIS + VIIRS)' : c.provenance === 'estimated' ? '≈ estimated (bridged from one sensor)' : c.provenance
          return `${head}<br/>${v}<br/>${prov}<br/><span style="color:#8A94A8">Coverage ${c.coverage_pct}% of days${c.incomplete ? ' (incomplete)' : ''}${c.in_progress ? ' · month in progress' : ''}</span>`
        },
      },
      series: [{
        type: 'custom', encode: { x: 0, y: 1 }, data,
        renderItem: (params: any, api: any) => {
          const c = data[params.dataIndex][3] as CalCell
          const v = val(c)
          const [x, y] = api.coord([api.value(0), api.value(1)])
          const [w, h] = api.size([1, 1])
          const gap = viirsRow > 0 && years.indexOf(c.year) >= viirsRow ? 3 : 0
          const rect = { x: x - w / 2 + 1.5, y: y - h / 2 + 1 + gap, width: w - 3, height: h - 2, r: 3 }
          const children: any[] = []
          const noData = v == null
          const t = v ? Math.sqrt(v / max) : 0
          const fill = noData ? '#1d2331' : v === 0 ? '#150b2e' : ember(0.06 + 0.94 * t)
          const glow = !noData && t > 0.55
          children.push({ type: 'rect', shape: rect, style: { fill, shadowBlur: glow ? 14 * t : 0, shadowColor: glow ? 'rgba(251,155,6,.65)' : 'transparent' } })
          const hatch = noData || (!raw && (c.provenance === 'estimated' || c.provenance === 'mixed'))
          if (hatch) {
            const step = 4
            for (let k = -rect.height; k < rect.width; k += step) {
              const x1 = rect.x + Math.max(0, k), y1 = rect.y + Math.max(0, -k)
              const len = Math.min(rect.width - Math.max(0, k), rect.height - Math.max(0, -k))
              children.push({ type: 'line', shape: { x1, y1: y1 + len, x2: x1 + len, y2: y1 }, style: { stroke: noData ? '#3A4253' : 'rgba(11,15,23,.55)', lineWidth: 1.2 } })
            }
          }
          if (c.in_progress) children.push({ type: 'rect', shape: rect, style: { fill: 'none', stroke: '#E8ECF4', lineWidth: 1, lineDash: [3, 2] } })
          if (selected && c.year === selected[0] && c.month === selected[1]) children.push({ type: 'rect', shape: { ...rect, x: rect.x - 1, y: rect.y - 1, width: rect.width + 2, height: rect.height + 2 }, style: { fill: 'none', stroke: '#FCFFA4', lineWidth: 2 } })
          if (gap && c.year === 2012 && c.month === 1) children.push({ type: 'line', shape: { x1: 44, y1: rect.y - 3, x2: 4000, y2: rect.y - 3 }, style: { stroke: '#8A94A8', lineDash: [3, 3], lineWidth: 1, opacity: 0.6 } })
          return { type: 'group', children }
        },
      }],
    } as echarts.EChartsCoreOption
  }, [cells, raw, years, selected])
  const max = useMemo(() => Math.max(1, ...cells.map(c => (raw ? c.raw_naive_hotspots : c.value) ?? 0)), [cells, raw])
  return (
    <div>
      <EChart option={option} height={Math.max(260, years.length * 17 + 30)} onClick={p => onPick?.(years[p.data[1]], p.data[0] + 1)}
        label={`Burning activity calendar ${years[0]}–${years[years.length - 1]}, ${raw ? 'raw hotspots' : 'burning cells'} per month`} />
      <div className="legend">
        <span className="num">0</span><span className="ramp" style={{ background: EMBER_CSS }} /><span className="num">{fmt(max)}</span>
        <span>{raw ? 'raw hotspots / month' : 'burning cells / month'}</span>
        <span><i className="sw est" />≈ estimated</span>
        <span><i className="sw nd" />⊘ no data</span>
        <span><i className="sw ip" />in progress</span>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- Fire Clock (radial seasonal shape)
export function FireClock({ q, year }: { q: QueryResult; year: number }) {
  const option = useMemo(() => {
    const med = q.climatology.map(c => c.median ?? 0)
    const p75 = q.climatology.map(c => c.p75 ?? 0)
    const yr = MONTHS.map((_, i) => q.calendar_monthly.find(c => c.year === year && c.month === i + 1)?.value ?? null)
    const max = Math.max(1, ...p75, ...yr.map(v => v ?? 0))
    const close = <T,>(a: T[]) => [...a, a[0]]
    return {
      animation: true, animationDuration: 400,
      polar: { radius: ['6%', '82%'] },
      angleAxis: { type: 'category', data: close(MONTHS.map(m => m[0])), boundaryGap: false, startAngle: 90, clockwise: true, ...AXIS, axisLine: { lineStyle: { color: '#2A3448' } }, splitLine: { show: true, lineStyle: { color: '#1F2738' } } },
      radiusAxis: { max: Math.sqrt(max), axisLabel: { show: false }, axisLine: { show: false }, splitLine: { lineStyle: { color: '#1F2738' } }, axisTick: { show: false } },
      tooltip: { ...TOOLTIP, trigger: 'axis', formatter: (ps: any[]) => `<b>${MONTHS[ps[0].dataIndex % 12]}</b><br/>` + ps.map(p => `${p.seriesName}: ${fmt(p.value ** 2)}`).join('<br/>') },
      series: [
        { name: 'usual (median)', type: 'line', coordinateSystem: 'polar', data: close(med.map(Math.sqrt)), symbol: 'none', smooth: 0.3,
          lineStyle: { color: '#A52C60', width: 1 }, areaStyle: { color: { type: 'radial', x: 0.5, y: 0.5, r: 0.6, colorStops: [{ offset: 0, color: 'rgba(207,68,70,.85)' }, { offset: 1, color: 'rgba(74,12,107,.6)' }] } } },
        { name: String(year), type: 'line', coordinateSystem: 'polar', data: close(yr.map(v => (v == null ? null : Math.sqrt(v)))), symbol: 'none', smooth: 0.3, connectNulls: false,
          lineStyle: { color: '#FCFFA4', width: 2, shadowBlur: 10, shadowColor: 'rgba(247,209,61,.7)' } },
      ],
    } as echarts.EChartsCoreOption
  }, [q, year])
  return <EChart option={option} height={210} label={`Fire clock: monthly burning in ${year} versus the usual season`} />
}

// ---------------------------------------------------------------- Seam Splitter (raw stitched vs harmonized, draggable)
export function SeamSplitter({ q }: { q: QueryResult }) {
  const series = useMemo(() => {
    const by: Record<number, { naive: number; harm: number; ok: boolean }> = {}
    q.calendar_monthly.forEach(c => {
      const r = (by[c.year] ||= { naive: 0, harm: 0, ok: true })
      r.naive += c.raw_naive_hotspots ?? 0
      r.harm += c.value ?? 0
      if (c.in_progress || c.incomplete) r.ok = false
    })
    const years = Object.keys(by).map(Number).filter(y => by[y].ok).sort((a, b) => a - b)
    const ref = years.filter(y => y >= 2003 && y <= 2011)
    const mean = (k: 'naive' | 'harm') => ref.reduce((s, y) => s + by[y][k], 0) / Math.max(1, ref.length)
    const mN = mean('naive'), mH = mean('harm')
    return { years, naive: years.map(y => by[y].naive / mN), harm: years.map(y => by[y].harm / mH), rawN: years.map(y => by[y].naive), rawH: years.map(y => by[y].harm) }
  }, [q])
  const [split, setSplit] = useState(2014)
  const [lo, hi] = [series.years[0] ?? 2001, series.years[series.years.length - 1] ?? 2025]
  const option = useMemo(() => {
    const idx = series.years.findIndex(y => y >= split)
    const cut = idx < 0 ? series.years.length : idx
    const left = series.naive.map((v, i) => (i <= cut ? v : null))
    const right = series.harm.map((v, i) => (i >= cut ? v : null))
    return {
      animation: false,
      grid: { left: 44, right: 16, top: 40, bottom: 26 },
      xAxis: { type: 'category', data: series.years.map(String), boundaryGap: false, ...AXIS },
      yAxis: { type: 'value', ...AXIS, axisLabel: { color: '#8A94A8', fontSize: 11, formatter: (v: number) => `${v.toFixed(1)}×` } },
      tooltip: { ...TOOLTIP, trigger: 'axis', formatter: (ps: any[]) => { const i = ps[0].dataIndex; return `<b>${series.years[i]}</b><br/><span style="color:#8AB4F8">Raw stitched</span>: ${fmt(series.rawN[i])} hotspots (${series.naive[i].toFixed(2)}×)<br/><span style="color:#FB9B06">Harmonized</span>: ${fmt(series.rawH[i])} burning cells (${series.harm[i].toFixed(2)}×)` } },
      series: [
        { name: 'Raw, stitched', type: 'line', data: left, symbol: 'none', lineStyle: { color: '#8AB4F8', width: 2.5 }, areaStyle: { color: 'rgba(138,180,248,.08)' },
          markLine: { symbol: 'none', silent: true, data: [{ xAxis: '2012' }], lineStyle: { color: '#8A94A8', type: 'dashed' }, label: { formatter: 'VIIRS joins → counts jump, fire didn\'t', color: '#B4BCCC', fontSize: 11, position: 'end', rotate: 0, backgroundColor: '#121826', padding: [3, 6], borderRadius: 4 } } },
        { name: 'Harmonized', type: 'line', data: right, symbol: 'none', lineStyle: { color: '#FB9B06', width: 2.5, shadowBlur: 8, shadowColor: 'rgba(251,155,6,.5)' }, areaStyle: { color: 'rgba(237,105,37,.10)' },
          markLine: { symbol: 'none', silent: true, data: [{ xAxis: String(series.years[Math.min(cut, series.years.length - 1)]) }], lineStyle: { color: '#E8ECF4', type: 'solid', width: 2 }, label: { show: false } } },
      ],
    } as echarts.EChartsCoreOption
  }, [series, split])
  return (
    <div>
      <EChart option={option} height={270} label="Seam splitter: raw stitched hotspot counts jump in 2012, harmonized burning cells do not" />
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginTop: 6 }}>
        <span className="muted" style={{ fontSize: 13, whiteSpace: 'nowrap' }}>⟷ Drag to compare</span>
        <input type="range" min={lo} max={hi} step={1} value={split} onChange={e => setSplit(+e.target.value)} style={{ flex: 1, accentColor: '#8AB4F8' }} aria-label="Split year between raw and harmonized" />
        <span className="num" style={{ width: 40 }}>{split}</span>
      </div>
      <p className="note">Both lines are shown relative to their own 2003–2011 average, so only the shape is compared. Left of the handle: raw stitched hotspots. Right: harmonized burning cells.</p>
    </div>
  )
}

// ---------------------------------------------------------------- who saw what (sensor differences §6.7)
export function WhoSawWhat({ q }: { q: QueryResult }) {
  const option = useMemo(() => {
    const by: Record<string, { both: number; m: number; v: number }> = {}
    q.sensor_diff.monthly.forEach(r => {
      const y = r.month.slice(0, 4)
      const o = (by[y] ||= { both: 0, m: 0, v: 0 })
      o.both += r.both; o.m += r.modis_only; o.v += r.viirs_only
    })
    const ys = Object.keys(by).sort()
    return {
      animation: true, animationDuration: 300,
      grid: { left: 40, right: 6, top: 10, bottom: 22 },
      xAxis: { type: 'category', data: ys.map(y => `'${y.slice(2)}`), ...AXIS },
      yAxis: { type: 'value', ...AXIS, axisLabel: { color: '#8A94A8', fontSize: 10, formatter: (v: number) => (v >= 1000 ? `${v / 1000}k` : String(v)) } },
      tooltip: { ...TOOLTIP, trigger: 'axis', valueFormatter: (v: number) => `${fmt(v)} cell-days` },
      series: [
        { name: 'MODIS only', type: 'bar', stack: 's', data: ys.map(y => by[y].m), itemStyle: { color: '#3A4253', decal: { symbol: 'rect', dashArrayX: [1, 0], dashArrayY: [2, 3], rotation: -Math.PI / 4, color: 'rgba(255,255,255,.12)' } } },
        { name: 'Both', type: 'bar', stack: 's', data: ys.map(y => by[y].both), itemStyle: { color: '#8AB4F8' } },
        { name: 'VIIRS only', type: 'bar', stack: 's', data: ys.map(y => by[y].v), itemStyle: { color: '#DCE6F7', borderRadius: [3, 3, 0, 0] } },
      ],
    } as echarts.EChartsCoreOption
  }, [q])
  return <EChart option={option} height={170} label="Burning cell-days seen by both sensors, MODIS only, or VIIRS only, per year" />
}

// ---------------------------------------------------------------- bridge factor small multiples (k_M per month + CI)
export function BridgeFactors({ methods, k = 'k_M' }: { methods: Methods; k?: 'k_M' | 'k_V' }) {
  const vals = MONTHS.map((_, i) => methods.calibration[k][String(i + 1)])
  const cis = MONTHS.map((_, i) => methods.calibration[`${k}_ci` as 'k_M_ci'][String(i + 1)] ?? [vals[i], vals[i]])
  const lo = Math.min(...cis.map(c => c[0])) * 0.95, hi = Math.max(...cis.map(c => c[1])) * 1.05
  const H = 96, y = (v: number) => 8 + (H - 16) * (1 - (v - lo) / (hi - lo))
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(12, 1fr)', gap: 5 }}>
      {MONTHS.map((m, i) => (
        <div key={m} title={`${m}: ${vals[i]?.toFixed(2)} (90% ${cis[i][0].toFixed(2)}–${cis[i][1].toFixed(2)})`} style={{ background: '#1A2233', borderRadius: 8, padding: '6px 0 4px', textAlign: 'center' }}>
          <svg width="22" height={H} style={{ display: 'block', margin: '0 auto' }}>
            <line x1="11" x2="11" y1={y(cis[i][1])} y2={y(cis[i][0])} stroke="#8AB4F8" strokeWidth="2" strokeLinecap="round" />
            <circle cx="11" cy={y(vals[i])} r="5" fill="#E8ECF4" stroke="#3b4f7a" strokeWidth="3" />
          </svg>
          <div style={{ fontSize: 10, color: '#8A94A8', marginTop: 4 }}>{m[0]}</div>
          <div className="num" style={{ fontSize: 10, color: '#B4BCCC' }}>{vals[i]?.toFixed(2)}</div>
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------- anomalies (§6.4)
export function AnnualAnomaly({ q }: { q: QueryResult }) {
  const option = useMemo(() => {
    const a = q.anomalies.annual
    return {
      animation: false, grid: { left: 40, right: 6, top: 10, bottom: 22 },
      tooltip: { ...TOOLTIP, trigger: 'axis', formatter: (p: any) => { const r = a[p[0].dataIndex]; return `<b>${r.year}</b>${r.complete ? '' : ' (incomplete)'}<br/>${fmt(r.total)} burning cells<br/>${r.vs_mean_ratio != null ? r.vs_mean_ratio.toFixed(2) + '× the multi-year mean' : ''}` } },
      xAxis: { type: 'category', data: a.map(r => `'${String(r.year).slice(2)}`), ...AXIS },
      yAxis: { type: 'value', ...AXIS, axisLabel: { color: '#8A94A8', fontSize: 10, formatter: (v: number) => `${(v + 1).toFixed(1)}×` } },
      series: [{ type: 'bar', data: a.map(r => ({ value: r.vs_mean_ratio == null ? null : r.vs_mean_ratio - 1, itemStyle: { color: r.vs_mean_ratio == null ? '#3A4253' : anomaly(r.vs_mean_ratio), opacity: r.complete ? 1 : 0.4, borderRadius: 2 } })) }],
    } as echarts.EChartsCoreOption
  }, [q])
  return <EChart option={option} height={170} label="Annual burning versus the multi-year mean" />
}

export function MonthlyAnomalyGrid({ q }: { q: QueryResult }) {
  const option = useMemo(() => {
    const years = Array.from(new Set(q.anomalies.monthly.map(m => m.year))).sort()
    const data = q.anomalies.monthly.map(m => [m.month - 1, years.indexOf(m.year), m.ratio])
    return {
      animation: false, grid: { left: 40, right: 4, top: 20, bottom: 4 },
      tooltip: { ...TOOLTIP, formatter: (p: any) => `${MONTHS[p.data[0]]} ${years[p.data[1]]}: ${p.data[2] == null ? 'no data' : p.data[2].toFixed(2) + '× the usual for this month'}` },
      xAxis: { type: 'category', data: MONTHS.map(m => m[0]), position: 'top', ...AXIS, axisLine: { show: false } },
      yAxis: { type: 'category', data: years.map(String), inverse: true, ...AXIS, axisLine: { show: false }, axisLabel: { color: '#8A94A8', fontSize: 9 } },
      series: [{
        type: 'custom', encode: { x: 0, y: 1 }, data,
        renderItem: (_: any, api: any) => {
          const [x, y] = api.coord([api.value(0), api.value(1)])
          const [w, h] = api.size([1, 1])
          const r = api.value(2)
          return { type: 'rect', shape: { x: x - w / 2 + 1, y: y - h / 2 + 0.5, width: w - 2, height: h - 1, r: 1.5 }, style: { fill: r == null || Number.isNaN(r) ? '#1d2331' : anomaly(r) } }
        },
      }],
    } as echarts.EChartsCoreOption
  }, [q])
  return (
    <div>
      <EChart option={option} height={Math.max(220, new Set(q.anomalies.monthly.map(m => m.year)).size * 11 + 30)} label="Monthly anomaly versus the usual level for each month" />
      <div className="legend"><span>below normal</span><span className="ramp" style={{ background: ANOMALY_CSS }} /><span>far above (4×)</span></div>
    </div>
  )
}

// month-of-year activity bars with the critical window highlighted (Season check / Critical window cards)
export function SeasonBars({ q, windows, curMonth }: { q: QueryResult; windows: Window[]; curMonth?: number }) {
  const med = q.climatology.map(c => c.median ?? 0)
  const max = Math.max(1, ...med)
  const inWin = (m: number) => windows.slice(0, 1).some(w => {
    const mid = new Date(Date.UTC(2001, m, 15)).getTime(), doy = Math.round((mid - Date.UTC(2001, 0, 1)) / 864e5) + 1
    return w.start_doy <= w.end_doy ? doy >= w.start_doy && doy <= w.end_doy : doy >= w.start_doy || doy <= w.end_doy
  })
  return (
    <div>
      <div className="months">{med.map((v, i) => <i key={i} className={(inWin(i) ? 'win ' : '') + (curMonth === i + 1 ? 'cur' : '')} style={{ height: `${Math.max(5, (v / max) * 100)}%` }} title={`${MONTHS[i]}: median ${fmt(v)} burning cells`} />)}</div>
      <div className="months-l">{MONTHS.map((m, i) => <span key={m} className={curMonth === i + 1 ? 'cur' : ''}>{m[0]}</span>)}</div>
    </div>
  )
}
