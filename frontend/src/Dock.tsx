import { useEffect, useMemo, useRef, useState } from 'react'
import { fmt, MONTHS } from './charts'
import type { Backtest, CalCell, Window } from './types'

const H = 76, TOP = 14, BOT = 18

function useWidth<T extends Element>(ref: React.RefObject<T | null>) {
  const [w, setW] = useState(1000)
  useEffect(() => {
    if (!ref.current) return
    const ro = new ResizeObserver(([e]) => setW(Math.max(200, e.contentRect.width)))
    ro.observe(ref.current)
    return () => ro.disconnect()
  }, [ref])
  return w
}
const ms = (d: string) => Date.parse(d + 'T00:00:00Z')
const iso = (t: number) => new Date(t).toISOString().slice(0, 10)
const shortDate = (d: string) => { const x = new Date(ms(d)); return `${x.getUTCDate()} ${MONTHS[x.getUTCMonth()]} ${x.getUTCFullYear()}` }

function usePointerScrub(ref: React.RefObject<SVGSVGElement | null>, toDate: (fx: number) => string, onCommit: (d: string) => void) {
  const [drag, setDrag] = useState<string | null>(null)
  const at = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect()
    return toDate(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)))
  }
  return {
    ref, drag,
    handlers: {
      onPointerDown: (e: React.PointerEvent) => { (e.target as Element).setPointerCapture?.(e.pointerId); setDrag(at(e)) },
      onPointerMove: (e: React.PointerEvent) => { if (drag) setDrag(at(e)) },
      onPointerUp: (e: React.PointerEvent) => { const d = at(e); setDrag(null); onCommit(d) },
    },
  }
}

// ---------------------------------------------------------------- main dock: 2001 → now
export function MainDock({ cells, asOf, lastDay, windows, selected, onScrub }: {
  cells: CalCell[]; asOf: string; lastDay: string; windows: Window[]; selected: [number, number] | null; onScrub: (d: string) => void
}) {
  const scrubRef = useRef<SVGSVGElement>(null)
  const W = useWidth(scrubRef)
  const t0 = ms('2001-01-01'), t1 = ms(lastDay)
  const x = (t: number) => ((t - t0) / (t1 - t0)) * W
  const { path, area, years } = useMemo(() => {
    const pts = cells.filter(c => c.year >= 2001).sort((a, b) => a.year - b.year || a.month - b.month)
    const max = Math.max(1, ...pts.map(c => c.value ?? 0))
    const y = (v: number) => H - BOT - Math.sqrt(v / max) * (H - BOT - TOP)
    let d = '', started = false
    pts.forEach(c => {
      const xx = x(Date.UTC(c.year, c.month - 1, 15))
      if (xx > W) return
      if (c.value == null) { started = false; return }
      d += `${started ? 'L' : 'M'}${xx.toFixed(1)},${y(c.value).toFixed(1)}`
      started = true
    })
    const ys = Array.from(new Set(pts.map(c => c.year)))
    return { path: d, area: d ? `${d}L${x(t1)},${H - BOT}L0,${H - BOT}Z` : '', years: ys }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cells, lastDay, W])
  const win = windows[0]
  const scrub = usePointerScrub(scrubRef, f => iso(t0 + f * (t1 - t0)), onScrub)
  const handle = scrub.drag ?? asOf
  return (
    <svg ref={scrubRef} viewBox={`0 0 ${W} ${H}`} {...scrub.handlers} role="slider" aria-label="As-of date" aria-valuetext={handle}>
      <defs>
        <linearGradient id="emberLine" x1="0" x2="0" y1="1" y2="0"><stop offset="0" stopColor="#A52C60" /><stop offset=".5" stopColor="#ED6925" /><stop offset="1" stopColor="#FCFFA4" /></linearGradient>
        <linearGradient id="emberFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#ED6925" stopOpacity=".35" /><stop offset="1" stopColor="#4A0C6B" stopOpacity="0" /></linearGradient>
      </defs>
      {win && years.map(yr => {
        const a = Date.UTC(yr, 0, win.start_doy), b = Date.UTC(win.end_doy < win.start_doy ? yr + 1 : yr, 0, win.end_doy)
        return x(a) < W && <rect key={yr} x={x(a)} y={TOP - 4} width={Math.max(1, Math.min(W, x(b)) - x(a))} height={H - BOT - TOP + 4} fill="#A3E635" opacity=".09" />
      })}
      <path d={area} fill="url(#emberFill)" />
      <path d={path} fill="none" stroke="url(#emberLine)" strokeWidth="1.4" vectorEffect="non-scaling-stroke" />
      <line x1={x(ms('2012-01-20'))} x2={x(ms('2012-01-20'))} y1={TOP - 6} y2={H - BOT} stroke="#8A94A8" strokeDasharray="2 2" vectorEffect="non-scaling-stroke" />
      <text x={x(ms('2012-01-20')) + 4} y={TOP - 2} fill="#B4BCCC" fontSize="9" style={{ fontWeight: 600 }}>VIIRS joins</text>
      {selected && <rect x={x(Date.UTC(selected[0], selected[1] - 1, 1))} y={TOP - 4} width={Math.max(2, x(Date.UTC(selected[0], selected[1], 1)) - x(Date.UTC(selected[0], selected[1] - 1, 1)))} height={H - BOT - TOP + 4} fill="#F7D13D" opacity=".5" />}
      {years.filter(yr => (W < 600 ? yr % 10 === 0 : yr % 5 === 0) || yr === 2001).map(yr => <text key={yr} x={x(Date.UTC(yr, 0, 1))} y={H - 4} fill="#8A94A8" fontSize="10" textAnchor={yr === 2001 ? 'start' : 'middle'}>{yr}</text>)}
      <g transform={`translate(${x(ms(handle))},0)`}>
        <line y1={TOP - 4} y2={H - BOT} stroke="#E8ECF4" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        <circle cy={TOP - 4} r="6" fill="#E8ECF4" stroke="#0B0F17" strokeWidth="2" />
        {scrub.drag && <text y={H - 4} fill="#F7D13D" fontSize="10" textAnchor="middle" style={{ fontWeight: 700 }}>{shortDate(scrub.drag)}</text>}
      </g>
    </svg>
  )
}

// ---------------------------------------------------------------- replay dock: Dec 2021 → Mar 2022
export function ReplayDock({ bt, start, end, cur }: { bt: Backtest; start: string; end: string; cur: string }) {
  const ref = useRef<SVGSVGElement>(null)
  const W = useWidth(ref)
  const t0 = ms(start), t1 = ms(end)
  const x = (d: string) => ((ms(d) - t0) / (t1 - t0)) * W
  const rows = bt.timeline.filter(r => r.date >= start && r.date <= end)
  const max = Math.max(1, ...rows.map(r => r.S ?? 0), ...rows.map(r => r.P99 ?? 0))
  const y = (v: number) => H - BOT - (v / max) * (H - BOT - TOP - 8)
  const seen = rows.filter(r => r.date <= cur)
  const line = seen.map((r, i) => `${i ? 'L' : 'M'}${x(r.date).toFixed(1)},${y(r.S ?? 0).toFixed(1)}`).join('')
  const area = line ? `${line}L${x(seen[seen.length - 1].date)},${H - BOT}L${x(seen[0].date)},${H - BOT}Z` : ''
  const p90 = rows.map((r, i) => `${i ? 'L' : 'M'}${x(r.date).toFixed(1)},${y(r.P90 ?? 0).toFixed(1)}`).join('')
  const dayW = W / ((t1 - t0) / 864e5)
  const onset = bt.result.episode_onset
  const months = ['2021-12-01', '2022-01-01', '2022-02-01', '2022-03-01'].filter(d => d >= start && d <= end)
  return (
    <svg ref={ref} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Replay timeline, currently ${cur}`}>
      {seen.map(r => r.status !== 'Normal' && r.status !== 'No data' && <rect key={r.date} x={x(r.date)} y={TOP - 4} width={dayW + 0.5} height={H - BOT - TOP + 4} fill={r.status === 'Extreme' ? '#EF4444' : '#F59E0B'} opacity=".13" />)}
      <path d={p90} fill="none" stroke="#F59E0B" strokeOpacity=".5" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
      <path d={area} fill="rgba(237,105,37,.22)" />
      <path d={line} fill="none" stroke="#FB9B06" strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
      {bt.markers.filter(m => m.date >= start && m.date <= end).map((m, i) => (
        <g key={m.date + m.label} opacity={m.date <= cur ? 1 : 0.18}>
          <line x1={x(m.date)} x2={x(m.date)} y1={TOP - 4} y2={H - BOT} stroke="#E8ECF4" strokeDasharray={m.verified ? undefined : '3 2'} vectorEffect="non-scaling-stroke" />
          <text x={x(m.date) + 3} y={TOP + 4 + (i % 2) * 12} fill="#E8ECF4" fontSize="9" style={{ fontWeight: 600 }}>{m.label.match(/(Decree|DNU)\s*[\d/]+/)?.[0] ?? m.label.split(',')[0]}{m.verified ? '' : '*'}</text>
        </g>
      ))}
      {onset && onset <= cur && <g>
        <line x1={x(onset)} x2={x(onset)} y1={TOP - 4} y2={H - BOT} stroke="#F59E0B" strokeWidth="2" vectorEffect="non-scaling-stroke" />
        <text x={x(onset) - 3} y={H - BOT - 4} fill="#F59E0B" fontSize="9" textAnchor="end" style={{ fontWeight: 700 }}>Our alert · {shortDate(onset).slice(0, -5)}</text>
      </g>}
      {months.map(d => <text key={d} x={x(d)} y={H - 4} fill="#8A94A8" fontSize="10">{shortDate(d)}</text>)}
      <g transform={`translate(${x(cur)},0)`}>
        <line y1={TOP - 4} y2={H - BOT} stroke="#E8ECF4" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        <circle cy={TOP - 4} r="6" fill="#E8ECF4" />
      </g>
      <title>{`7-day burning cells ${fmt(seen[seen.length - 1]?.S)} on ${cur}`}</title>
    </svg>
  )
}
