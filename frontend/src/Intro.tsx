import { useEffect, useMemo, useRef, useState } from 'react'
import type { Detections } from './types'
import './intro.css'
import { Topo } from './Hud'

export type Lens = 'response' | 'ranger' | 'research'
type Phase = 'sky' | 'parting' | 'world' | 'leaving'

const POSTS: { id: Lens; name: string; role: string; color: string; x: number; y: number }[] = [
  { id: 'response', name: 'Response Station', role: 'Act now', color: '#4FD1C5', x: 24, y: 36 },
  { id: 'ranger', name: 'Ranger Post', role: 'Know the seasons', color: '#A3E635', x: 50, y: 64 },
  { id: 'research', name: 'Research Lab', role: 'Check the science', color: '#8AB4F8', x: 76, y: 42 },
]
const reduced = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

// cloud puffs: [left %, top %, size vmax, shade] — two banks that part left / right
const CLOUDS: [number, number, number, number][] = [
  [-8, -12, 34, 0], [10, -18, 30, 1], [-14, 22, 38, 2], [6, 30, 30, 0], [-10, 62, 40, 1], [14, 70, 32, 2], [22, 8, 22, 1], [26, 46, 24, 0],
  [62, -16, 34, 1], [80, -8, 32, 0], [70, 24, 36, 2], [88, 30, 30, 1], [60, 58, 38, 0], [84, 66, 36, 2], [52, 12, 22, 2], [50, 50, 24, 1],
  [36, 78, 30, 0], [44, -20, 24, 2],
]

function project(fc: any, w: number, h: number, pad = 0.08) {
  const rings: number[][][] = []
  for (const f of fc?.features ?? []) {
    const g = f.geometry
    if (g?.type === 'Polygon') rings.push(g.coordinates[0])
    if (g?.type === 'MultiPolygon') g.coordinates.forEach((p: number[][][]) => rings.push(p[0]))
  }
  if (!rings.length) return null
  const pts = rings.flat()
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1])
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]
  const k = Math.cos(((y0 + y1) / 2) * Math.PI / 180)
  const s = Math.min((w * (1 - 2 * pad)) / ((x1 - x0) * k), (h * (1 - 2 * pad)) / (y1 - y0))
  const ox = (w - (x1 - x0) * k * s) / 2, oy = (h - (y1 - y0) * s) / 2
  const P = (lon: number, lat: number): [number, number] => [ox + (lon - x0) * k * s, oy + (y1 - lat) * s]
  const d = rings.map(r => r.map((p, i) => `${i ? 'L' : 'M'}${P(p[0], p[1]).map(v => v.toFixed(1)).join(',')}`).join('') + 'Z').join('')
  return { d, P }
}

function Outpost({ id, color }: { id: Lens; color: string }) {
  return (
    <svg viewBox="-60 -110 120 150" className="op-outpost-svg" aria-hidden="true">
      <ellipse cx="0" cy="26" rx="50" ry="13" fill="#05070c" opacity=".55" />
      <polygon points="-46,8 0,-14 46,8 0,30" fill="#1A2233" stroke={color} strokeOpacity=".75" strokeWidth="1.5" />
      <polygon points="-46,8 0,30 0,36 -46,14" fill="#121826" />
      <polygon points="46,8 0,30 0,36 46,14" fill="#0e1420" />
      {id === 'response' && <g stroke="#C9D3E3" strokeWidth="2.2" strokeLinecap="round">
        <line x1="-14" y1="12" x2="0" y2="-74" /><line x1="14" y1="12" x2="0" y2="-74" />
        <line x1="-10" y1="-12" x2="9" y2="-34" /><line x1="10" y1="-12" x2="-9" y2="-34" /><line x1="-6" y1="-40" x2="5" y2="-56" /><line x1="6" y1="-40" x2="-5" y2="-56" />
        <circle cx="0" cy="-80" r="7" fill={color} stroke="none" className="op-beacon" />
        <circle cx="0" cy="-80" r="13" fill="none" stroke={color} strokeWidth="2" className="op-ripple" />
      </g>}
      {id === 'ranger' && <g>
        <g stroke="#C9D3E3" strokeWidth="2.2" strokeLinecap="round"><line x1="-14" y1="14" x2="-10" y2="-38" /><line x1="14" y1="14" x2="10" y2="-38" /><line x1="-12" y1="-4" x2="12" y2="-22" /><line x1="12" y1="-4" x2="-12" y2="-22" /></g>
        <polygon points="-16,-38 16,-38 16,-58 -16,-58" fill="#242d40" stroke="#3a4558" />
        <rect x="-7" y="-52" width="8" height="8" fill={color} opacity=".85" />
        <polygon points="-22,-58 0,-92 22,-58" fill={color} /><polygon points="0,-92 22,-58 0,-62" fill="#000" opacity=".22" />
      </g>}
      {id === 'research' && <g>
        <path d="M-26,4 V-30 H26 V4 Z" fill="#242d40" stroke="#3a4558" />
        <path d="M-28,-30 A28,28 0 0 1 28,-30 Z" fill={color} /><path d="M0,-58 A28,28 0 0 1 28,-30 H0 Z" fill="#000" opacity=".18" />
        <line x1="4" y1="-56" x2="12" y2="-38" stroke="#0B0F17" strokeWidth="5" strokeLinecap="round" />
      </g>}
    </svg>
  )
}

export default function Intro({ onChoose, coverage, det }: { onChoose: (l: Lens) => void; coverage: any; det: Detections | null }) {
  const [phase, setPhase] = useState<Phase>(reduced() ? 'world' : 'sky')
  const [hold, setHold] = useState(0)
  const [hover, setHover] = useState<Lens | null>(null)
  const [chosen, setChosen] = useState<Lens | null>(null)
  const raf = useRef(0)
  const holding = useRef(false)

  const W = 1000, H = 640
  const geo = useMemo(() => project(coverage, W, H), [coverage])
  const embers = useMemo(() => {
    if (!geo || !det) return []
    return (det.features as any[]).slice(0, 700).map(f => { const [lon, lat] = f.geometry.coordinates; return geo.P(lon, lat) })
  }, [geo, det])

  const descend = () => {
    if (phase !== 'sky') return
    setPhase('parting')
    window.setTimeout(() => setPhase('world'), 1150)
  }
  // hold-to-descend: fills in 1.1 s while pressed, rewinds when released; a quick tap auto-fills
  const tick = (t0: number, from: number, dir: 1 | -1, dur: number) => {
    cancelAnimationFrame(raf.current)
    const step = (t: number) => {
      const v = Math.max(0, Math.min(1, from + (dir * (t - t0)) / dur))
      setHold(v)
      if (v >= 1) { descend(); return }
      if (v > 0 && (dir === 1 ? holding.current || dur < 800 : !holding.current)) raf.current = requestAnimationFrame(step)
    }
    raf.current = requestAnimationFrame(step)
  }
  const down = () => { holding.current = true; tick(performance.now(), hold, 1, 1100) }
  const up = () => {
    const pressed = holding.current
    holding.current = false
    if (pressed && hold < 0.25) tick(performance.now(), hold, 1, 450)   // tap → finish quickly
    else if (pressed && hold < 1) tick(performance.now(), hold, -1, 500)
  }
  useEffect(() => () => cancelAnimationFrame(raf.current), [])

  const choose = (l: Lens) => {
    if (chosen) return
    setChosen(l); setPhase('leaving')
    window.setTimeout(() => onChoose(l), reduced() ? 0 : 900)
  }
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') choose('response')
      if ((e.key === 'Enter' || e.key === ' ') && phase === 'sky') { e.preventDefault(); descend() }
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  })

  const target = POSTS.find(p => p.id === chosen)
  return (
    <div className={`op ph-${phase}`} role="dialog" aria-label="Welcome to Emberline"
      style={target ? ({ ['--fx' as any]: `${target.x}%`, ['--fy' as any]: `${target.y}%` }) : undefined}>
      {/* ---------------- world (behind the clouds) */}
      <div className="op-world">
        <div className="op-stars" /><Topo className="op-topo" seed={11} />
        <svg className="op-map" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" aria-hidden="true">
          <defs>
            <radialGradient id="opEmber"><stop offset="0" stopColor="#FCFFA4" /><stop offset=".35" stopColor="#FB9B06" stopOpacity=".9" /><stop offset="1" stopColor="#CF4446" stopOpacity="0" /></radialGradient>
            <pattern id="opGrid" width="22" height="22" patternUnits="userSpaceOnUse"><path d="M22 0H0V22" fill="none" stroke="rgba(138,180,248,.13)" strokeWidth="1" /></pattern>
            <filter id="opGlow" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="6" /></filter>
          </defs>
          {geo && <>
            <path d={geo.d} fill="#121a2a" /><path d={geo.d} fill="url(#opGrid)" />
            <path d={geo.d} fill="none" stroke="#FB9B06" strokeWidth="10" opacity=".25" filter="url(#opGlow)" />
            <path d={geo.d} fill="none" stroke="#8AB4F8" strokeWidth="4" opacity=".35" transform="translate(-5 2)" />
            <path d={geo.d} fill="none" stroke="#F7D13D" strokeWidth="1.6" className="op-outline" pathLength={1} />
          </>}
          {embers.map(([x, y], i) => <circle key={i} cx={x} cy={y} r={i % 9 === 0 ? 9 : 5} fill="url(#opEmber)" className="op-ember" style={{ animationDelay: `${0.4 + (i % 40) * 0.025}s` }} />)}
        </svg>
        {POSTS.map((p, i) => (
          <button key={p.id} className={`op-post${hover === p.id ? ' hot' : ''}${chosen === p.id ? ' chosen' : ''}`} style={{ left: `${p.x}%`, top: `${p.y}%`, ['--c' as any]: p.color, ['--d' as any]: `${0.25 + i * 0.12}s` }}
            onClick={() => choose(p.id)} onMouseEnter={() => setHover(p.id)} onMouseLeave={() => setHover(null)} tabIndex={-1} aria-hidden="true">
            <span className="op-halo" />
            <Outpost id={p.id} color={p.color} />
            <span className="op-label">{p.name}</span>
          </button>
        ))}
        <div className="op-choose">
          <h2>Choose your post</h2>
          <div className="op-tiles">
            {POSTS.map((p, i) => (
              <button key={p.id} className="op-tile" style={{ ['--c' as any]: p.color, ['--d' as any]: `${0.6 + i * 0.07}s` }}
                onClick={() => choose(p.id)} onMouseEnter={() => setHover(p.id)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(p.id)} onBlur={() => setHover(null)}>
                <i /><span><b>{p.name}</b><small>{p.role}</small></span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ---------------- sky: clouds + title + hold to descend */}
      <div className="op-sky">
        <div className="op-skyglow" />
        {CLOUDS.map(([x, y, s, shade], i) => (
          <span key={i} className={`op-cloud ${x < 45 ? 'l' : 'r'} s${shade}`} style={{ left: `${x}%`, top: `${y}%`, width: `${s}vmax`, height: `${s}vmax`, ['--i' as any]: i }} />
        ))}
        <div className="op-title">
          <svg className="op-spark" viewBox="0 0 520 120" aria-hidden="true">
            <path d="M10 22 C150 22 200 62 300 62" className="op-track m" />
            <path d="M10 104 C150 104 200 62 300 62" className="op-track v" />
            <path d="M300 62 H470" className="op-line" />
            <circle cx="482" cy="62" r="9" className="op-dot" />
            <text x="12" y="14" className="op-tl">MODIS</text><text x="12" y="118" className="op-tl v">VIIRS</text>
          </svg>
          <div className="op-word">EMBERLINE</div>
          <div className="op-tag">25 years of fire. One clear line.</div>
          <div className="op-hold">
            <button className="op-holdbtn" onPointerDown={down} onPointerUp={up} onPointerLeave={() => holding.current && up()} onContextMenu={e => e.preventDefault()} aria-label="Hold to descend">
              <svg viewBox="0 0 112 112" aria-hidden="true">
                <circle cx="56" cy="56" r="50" fill="none" stroke="rgba(252,211,77,.18)" strokeWidth="4" />
                <circle cx="56" cy="56" r="50" fill="none" stroke="#FCD34D" strokeWidth="4" strokeLinecap="round" strokeDasharray="314.16" strokeDashoffset={314.16 * (1 - hold)} transform="rotate(-90 56 56)" />
              </svg>
              <svg className="op-arrow" width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 4v14" /><path d="m6 12 6 6 6-6" /></svg>
            </button>
            <span>HOLD TO DESCEND</span>
          </div>
        </div>
      </div>

      <button className="op-skip" onClick={() => choose('response')}>Skip ›</button>
    </div>
  )
}
