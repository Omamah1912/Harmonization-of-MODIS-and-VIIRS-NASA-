import * as echarts from 'echarts'
import { useEffect, useRef } from 'react'
import type { Backtest, CalCell, Marker, Methods, QueryResult, Window } from './types'

export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// ---------------------------------------------------------------- colour ramps (colourblind-safe)
const VIRIDIS = ['#440154', '#482878', '#3e4989', '#31688e', '#26828e', '#1f9e89', '#35b779', '#6ece58', '#b5de2b', '#fde725']
const DIVERGING = ['#2d004b', '#542788', '#8073ac', '#b2abd2', '#d8daeb', '#f7f7f7', '#fee0b6', '#fdb863', '#e08214', '#b35806', '#7f3b08'] // PuOr

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
export const viridis = (t: number) => ramp(VIRIDIS, t)
export const diverging = (t: number) => ramp(DIVERGING, t)
export const VIRIDIS_CSS = `linear-gradient(90deg, ${VIRIDIS.join(',')})`
export const DIVERGING_CSS = `linear-gradient(90deg, ${DIVERGING.join(',')})`

// ---------------------------------------------------------------- generic wrapper
export function EChart({ option, height = 260, onClick }: { option: echarts.EChartsCoreOption; height?: number; onClick?: (p: any) => void }) {
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
    if (!chart.current || !onClick) return
    chart.current.off('click')
    chart.current.on('click', onClick)
  }, [onClick])
  return <div ref={ref} style={{ width: '100%', height }} />
}

const fmt = (v: number | null | undefined, d = 0) => (v == null ? '—' : v.toLocaleString(undefined, { maximumFractionDigits: d }))

// ---------------------------------------------------------------- burning calendar (§6.1)
export function Calendar({ cells, raw, onPick, windows }: { cells: CalCell[]; raw: boolean; onPick?: (y: number, m: number) => void; windows?: Window[] }) {
  const years = Array.from(new Set(cells.map(c => c.year))).sort((a, b) => a - b)
  const val = (c: CalCell) => (raw ? c.raw_naive_hotspots : c.value)
  const vals = cells.map(val).filter((v): v is number => v != null && v > 0)
  const max = vals.length ? Math.max(...vals) : 1
  const scale = (v: number) => Math.sqrt(v / max)
  const data = cells.map(c => [c.month - 1, years.indexOf(c.year), val(c), c])
  const windowMonths = new Set<number>()
  windows?.slice(0, 1).forEach(w => {
    for (let d = w.start_doy; ; d = (d % 365) + 1) {
      windowMonths.add(new Date(Date.UTC(2001, 0, d)).getUTCMonth())
      if (d === w.end_doy) break
    }
  })
  const option: echarts.EChartsCoreOption = {
    animation: false,
    grid: { left: 48, right: 12, top: 26, bottom: 8 },
    xAxis: { type: 'category', data: MONTHS, position: 'top', axisTick: { show: false },
      axisLabel: { formatter: (m: string, i: number) => (windowMonths.has(i) ? `{w|${m}}` : m), rich: { w: { color: '#b35806', fontWeight: 'bold' } } } },
    yAxis: { type: 'category', data: years.map(String), inverse: true, axisTick: { show: false } },
    tooltip: {
      formatter: (p: any) => {
        const c: CalCell = p.data[3]
        const head = `<b>${MONTHS[c.month - 1]} ${c.year}</b>`
        const v = raw ? `${fmt(c.raw_naive_hotspots)} raw hotspots (MODIS${c.raw_viirs_hotspots ? ' + VIIRS' : ''}, naive sum — not comparable across years)`
          : `${fmt(c.value)} burning cells` + (c.provenance !== 'observed' && c.low != null ? ` (90% CI ${fmt(c.low)}–${fmt(c.high)})` : '')
        return `${head}<br/>${c.value == null && !raw ? 'No data — no satellite coverage' : v}<br/>Provenance: ${c.provenance}<br/>Coverage: ${c.coverage_pct}% of days${c.incomplete ? ' (incomplete)' : ''}${c.in_progress ? '<br/><i>Month in progress</i>' : ''}`
      },
    },
    series: [{
      type: 'custom',
      encode: { x: 0, y: 1 },
      data,
      renderItem: (params: any, api: any) => {
        const c: CalCell = data[params.dataIndex][3] as CalCell
        const v = val(c)
        const [x, y] = api.coord([api.value(0), api.value(1)])
        const [w, h] = api.size([1, 1])
        const rect = { x: x - w / 2 + 1, y: y - h / 2 + 1, width: w - 2, height: h - 2 }
        const children: any[] = []
        const noData = v == null
        children.push({ type: 'rect', shape: rect, style: { fill: noData ? '#d9d9d9' : (v === 0 ? '#f2f0f7' : viridis(scale(v))) } })
        const hatch = noData || (!raw && (c.provenance === 'estimated' || c.provenance === 'mixed')) || c.incomplete
        if (hatch) {
          const step = 6
          for (let k = -rect.height; k < rect.width; k += step) {
            const x1 = rect.x + Math.max(0, k), y1 = rect.y + Math.max(0, -k)
            const len = Math.min(rect.width - Math.max(0, k), rect.height - Math.max(0, -k))
            children.push({ type: 'line', shape: { x1, y1, x2: x1 + len, y2: y1 + len },
              style: { stroke: noData ? '#8c8c8c' : 'rgba(255,255,255,0.55)', lineWidth: 1 } })
          }
        }
        if (c.in_progress) children.push({ type: 'rect', shape: rect, style: { fill: 'none', stroke: '#b35806', lineWidth: 2 } })
        return { type: 'group', children }
      },
    }],
  }
  return (
    <div>
      <EChart option={option} height={Math.max(220, years.length * 16 + 40)} onClick={p => onPick?.(years[p.data[1]], p.data[0] + 1)} />
      <div className="legend">
        <span>0</span><span className="ramp" style={{ background: VIRIDIS_CSS }} /><span>{fmt(max)} {raw ? 'raw hotspots / month' : 'burning cells / month'}</span>
        <span className="sw hatch-est" /> estimated / mixed / incomplete
        <span className="sw hatch-nd" /> no data
        <span className="sw inprog" /> month in progress
        {windowMonths.size > 0 && <span style={{ color: '#b35806', fontWeight: 600 }}>bold months = critical window</span>}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- timeline (H, S, thresholds, markers, windows)
export function Timeline({ q, markers, asOf, alertDates, height = 260 }: { q: QueryResult; markers?: Marker[]; asOf?: string; alertDates?: { alert?: string | null; severe?: string | null }; height?: number }) {
  const t = q.timeline
  const est = t.date.map((d, i) => (t.provenance[i] === 'estimated' ? [d, t.H_low[i], t.H_high[i]] : [d, null, null]))
  const mk: any[] = (markers || []).filter(m => m.date >= t.date[0] && m.date <= t.date[t.date.length - 1]).map(m => ({
    xAxis: m.date, label: { formatter: m.label.split(',')[0] + (m.verified ? '' : ' (unverified)'), rotate: 90, fontSize: 9, position: 'insideEndTop' },
    lineStyle: { type: m.verified ? 'solid' : 'dashed', color: '#555' },
  }))
  if (alertDates?.alert) mk.push({ xAxis: alertDates.alert, label: { formatter: 'Our Alert', fontSize: 10 }, lineStyle: { color: '#e08214', width: 2 } })
  if (alertDates?.severe) mk.push({ xAxis: alertDates.severe, label: { formatter: 'Our Severe', fontSize: 10 }, lineStyle: { color: '#7f3b08', width: 2 } })
  if (asOf) mk.push({ xAxis: asOf, label: { formatter: 'as of', fontSize: 10 }, lineStyle: { color: '#000', type: 'dotted' } })
  const option: echarts.EChartsCoreOption = {
    animation: false,
    grid: { left: 50, right: 50, top: 30, bottom: 50 },
    legend: { top: 0, data: ['H (burning cells/day)', '7-day sum S', 'P90', 'P99'] },
    tooltip: { trigger: 'axis', valueFormatter: (v: number) => fmt(v, 1) },
    xAxis: { type: 'category', data: t.date },
    yAxis: [{ type: 'value', name: 'cells/day' }, { type: 'value', name: '7-day sum', splitLine: { show: false } }],
    dataZoom: [{ type: 'inside' }, { type: 'slider', height: 16, bottom: 8 }],
    series: [
      { name: 'H (burning cells/day)', type: 'bar', data: t.H, itemStyle: { color: '#31688e' }, barCategoryGap: 0, markLine: { symbol: 'none', data: mk } },
      { name: 'estimated band', type: 'line', data: est.map(e => e[2]), lineStyle: { opacity: 0 }, symbol: 'none', areaStyle: { color: 'rgba(53,183,121,0.25)' }, silent: true },
      { name: '7-day sum S', type: 'line', yAxisIndex: 1, data: t.S, symbol: 'none', lineStyle: { color: '#1f9e89', width: 2 } },
      { name: 'P90', type: 'line', yAxisIndex: 1, data: t.P90, symbol: 'none', lineStyle: { color: '#e08214', type: 'dashed' } },
      { name: 'P99', type: 'line', yAxisIndex: 1, data: t.P99, symbol: 'none', lineStyle: { color: '#7f3b08', type: 'dashed' } },
    ],
  }
  return <EChart option={option} height={height} />
}

// ---------------------------------------------------------------- climatology (§6.2)
export function Climatology({ q }: { q: QueryResult }) {
  const c = q.climatology
  const option: echarts.EChartsCoreOption = {
    animation: false, grid: { left: 50, right: 12, top: 30, bottom: 28 },
    legend: { top: 0, data: ['median', 'p25–p75'] },
    tooltip: { trigger: 'axis', valueFormatter: (v: number) => fmt(v, 1) },
    xAxis: { type: 'category', data: MONTHS },
    yAxis: { type: 'value', name: 'cells / month' },
    series: [
      { name: 'p25', type: 'line', stack: 'band', data: c.map(x => x.p25), symbol: 'none', lineStyle: { opacity: 0 } },
      { name: 'p25–p75', type: 'line', stack: 'band', data: c.map(x => (x.p75 ?? 0) - (x.p25 ?? 0)), symbol: 'none', lineStyle: { opacity: 0 }, areaStyle: { color: 'rgba(49,104,142,0.25)' } },
      { name: 'median', type: 'line', data: c.map(x => x.median), lineStyle: { color: '#31688e', width: 2 } },
    ],
  }
  return <EChart option={option} height={230} />
}

// ---------------------------------------------------------------- annual anomaly (§6.4)
export function AnnualAnomaly({ q }: { q: QueryResult }) {
  const a = q.anomalies.annual
  const option: echarts.EChartsCoreOption = {
    animation: false, grid: { left: 50, right: 12, top: 16, bottom: 28 },
    tooltip: { trigger: 'axis', formatter: (p: any) => { const r = a[p[0].dataIndex]; return `<b>${r.year}</b>${r.complete ? '' : ' (incomplete year)'}<br/>${fmt(r.total)} burning cells<br/>${r.vs_mean_ratio != null ? r.vs_mean_ratio.toFixed(2) + '× multi-year mean' : ''}` } },
    xAxis: { type: 'category', data: a.map(r => String(r.year)) },
    yAxis: { type: 'value', name: '× mean', axisLabel: { formatter: (v: number) => `${(v + 1).toFixed(1)}×` } },
    series: [{
      type: 'bar', data: a.map(r => ({
        value: r.vs_mean_ratio == null ? null : r.vs_mean_ratio - 1,
        itemStyle: { color: r.vs_mean_ratio == null ? '#ccc' : diverging(0.5 + Math.max(-0.5, Math.min(0.5, Math.log2(r.vs_mean_ratio) / 4))), opacity: r.complete ? 1 : 0.45 },
      })),
    }],
  }
  return <EChart option={option} height={220} />
}

export function MonthlyAnomalyGrid({ q }: { q: QueryResult }) {
  const years = Array.from(new Set(q.anomalies.monthly.map(m => m.year))).sort()
  const data = q.anomalies.monthly.map(m => [m.month - 1, years.indexOf(m.year), m.ratio])
  const option: echarts.EChartsCoreOption = {
    animation: false, grid: { left: 48, right: 12, top: 24, bottom: 8 },
    tooltip: { formatter: (p: any) => `${MONTHS[p.data[0]]} ${years[p.data[1]]}: ${p.data[2] == null ? '—' : p.data[2].toFixed(2) + '× the monthly median'}` },
    xAxis: { type: 'category', data: MONTHS, position: 'top' },
    yAxis: { type: 'category', data: years.map(String), inverse: true },
    visualMap: { show: false, min: -2, max: 2, inRange: { color: DIVERGING } },
    series: [{ type: 'heatmap', data: data.map(d => [d[0], d[1], d[2] == null ? null : Math.log2(Math.max(d[2] as number, 0.25))]) }],
  }
  return (
    <div>
      <EChart option={option} height={Math.max(220, years.length * 14 + 40)} />
      <div className="legend"><span>¼× median</span><span className="ramp" style={{ background: DIVERGING_CSS }} /><span>4× median</span></div>
    </div>
  )
}

// ---------------------------------------------------------------- sensor differences (§6.7)
export function SensorDiff({ q }: { q: QueryResult }) {
  const m = q.sensor_diff.monthly
  const option: echarts.EChartsCoreOption = {
    animation: false, grid: { left: 50, right: 12, top: 30, bottom: 50 },
    legend: { top: 0 }, tooltip: { trigger: 'axis' },
    xAxis: { type: 'category', data: m.map(r => r.month) },
    yAxis: { type: 'value', name: 'cell-days' },
    dataZoom: [{ type: 'slider', height: 16, bottom: 8 }],
    series: [
      { name: 'both sensors', type: 'bar', stack: 's', data: m.map(r => r.both), itemStyle: { color: '#31688e' } },
      { name: 'MODIS only', type: 'bar', stack: 's', data: m.map(r => r.modis_only), itemStyle: { color: '#e08214' } },
      { name: 'VIIRS only', type: 'bar', stack: 's', data: m.map(r => r.viirs_only), itemStyle: { color: '#8073ac' } },
    ],
  }
  return <EChart option={option} height={250} />
}

// ---------------------------------------------------------------- seam test (raw vs harmonized)
export function Seam({ q, methods, raw }: { q: QueryResult; methods?: Methods; raw: boolean }) {
  const byYear: Record<number, { naive: number; harm: number; modis: number; ok: boolean }> = {}
  q.calendar_monthly.forEach(c => {
    const r = (byYear[c.year] ||= { naive: 0, harm: 0, modis: 0, ok: true })
    r.naive += c.raw_naive_hotspots ?? 0
    r.harm += c.value ?? 0
    r.modis += c.modis_cells ?? 0
    if (c.incomplete || c.in_progress) r.ok = false
  })
  const years = Object.keys(byYear).map(Number).filter(y => byYear[y].ok)
  const option: echarts.EChartsCoreOption = {
    animation: false, grid: { left: 60, right: 60, top: 30, bottom: 28 },
    legend: { top: 0 }, tooltip: { trigger: 'axis', valueFormatter: (v: number) => fmt(v) },
    xAxis: { type: 'category', data: years.map(String) },
    yAxis: [{ type: 'value', name: 'raw hotspots' }, { type: 'value', name: 'cells', splitLine: { show: false } }],
    series: [
      { name: 'Naive splice (raw hotspots)', type: 'line', data: years.map(y => byYear[y].naive), lineStyle: { color: '#b35806', width: raw ? 3 : 1 },
        markLine: { symbol: 'none', data: [{ xAxis: '2012', label: { formatter: 'VIIRS starts' } }], lineStyle: { color: '#888', type: 'dashed' } } },
      { name: 'Harmonized (burning cells)', type: 'line', yAxisIndex: 1, data: years.map(y => byYear[y].harm), lineStyle: { color: '#31688e', width: raw ? 1 : 3 } },
      { name: 'MODIS-only cells (reference)', type: 'line', yAxisIndex: 1, data: years.map(y => byYear[y].modis), lineStyle: { color: '#999', type: 'dotted' } },
    ],
  }
  const st = methods?.seam_test.step_ratio_2012_16_vs_2007_11
  return (
    <div>
      <EChart option={option} height={250} />
      {st && <p className="note">Region-wide step ratio (mean 2012–16 ÷ 2007–11): naive {st.naive_hotspots?.toFixed(2)}×, harmonized {st.harmonized_cells?.toFixed(2)}×, MODIS-only {st['modis_only_cells (consistent sensor)']?.toFixed(2)}×. {methods?.seam_test.interpretation}</p>}
    </div>
  )
}

// ---------------------------------------------------------------- backtest timeline
export function BacktestChart({ bt, asOf }: { bt: Backtest; asOf?: string }) {
  const t = bt.timeline
  const mk: any[] = bt.markers.map(m => ({ xAxis: m.date, label: { formatter: m.label.split(',')[0] + (m.verified ? '' : ' (unverified)'), rotate: 90, fontSize: 9, position: 'insideEndTop' }, lineStyle: { type: m.verified ? 'solid' : 'dashed', color: '#555' } }))
  if (bt.result.first_alert) mk.push({ xAxis: bt.result.first_alert, label: { formatter: 'Alert', fontSize: 10 }, lineStyle: { color: '#e08214', width: 2 } })
  if (bt.result.first_severe) mk.push({ xAxis: bt.result.first_severe, label: { formatter: 'Severe', fontSize: 10 }, lineStyle: { color: '#7f3b08', width: 2 } })
  if (asOf) mk.push({ xAxis: asOf, label: { formatter: 'as of', fontSize: 10 }, lineStyle: { color: '#000', type: 'dotted' } })
  const shown = (i: number) => !asOf || t[i].date <= asOf
  const option: echarts.EChartsCoreOption = {
    animation: false, grid: { left: 50, right: 20, top: 30, bottom: 30 },
    legend: { top: 0 }, tooltip: { trigger: 'axis', valueFormatter: (v: number) => fmt(v, 1) },
    xAxis: { type: 'category', data: t.map(r => r.date) },
    yAxis: { type: 'value', name: '7-day burning cells' },
    series: [
      { name: '7-day sum S', type: 'line', data: t.map((r, i) => (shown(i) ? r.S : null)), symbol: 'none', lineStyle: { color: '#1f9e89', width: 2 }, markLine: { symbol: 'none', data: mk } },
      { name: 'P90 (Alert)', type: 'line', data: t.map(r => r.P90), symbol: 'none', lineStyle: { color: '#e08214', type: 'dashed' } },
      { name: 'P99 (Severe)', type: 'line', data: t.map(r => r.P99), symbol: 'none', lineStyle: { color: '#7f3b08', type: 'dashed' } },
    ],
  }
  return <EChart option={option} height={300} />
}
