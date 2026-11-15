import { useMemo } from 'react'

// Procedural topographic contour lines (decorative, deterministic): nested wobbly rings around a few summits.
export function Topo({ className = 'topo', seed = 3, w = 1600, h = 1000 }: { className?: string; seed?: number; w?: number; h?: number }) {
  const d = useMemo(() => {
    let s = seed
    const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647 }
    const peaks = Array.from({ length: 4 }, () => ({ x: rnd() * w, y: rnd() * h, r: 120 + rnd() * 220, ph: [rnd() * 6, rnd() * 6, rnd() * 6] }))
    const paths: string[] = []
    for (const p of peaks) {
      for (let k = 1; k <= 9; k++) {
        const R = p.r * (k / 3.2)
        let path = ''
        for (let i = 0; i <= 96; i++) {
          const t = (i / 96) * Math.PI * 2
          const wob = 1 + 0.16 * Math.sin(3 * t + p.ph[0] + k * 0.3) + 0.09 * Math.sin(5 * t + p.ph[1] - k * 0.2) + 0.05 * Math.sin(9 * t + p.ph[2])
          path += `${i ? 'L' : 'M'}${(p.x + Math.cos(t) * R * wob * 1.25).toFixed(1)},${(p.y + Math.sin(t) * R * wob * 0.8).toFixed(1)}`
        }
        paths.push(path + 'Z')
      }
    }
    return paths
  }, [seed, w, h])
  return (
    <svg className={className} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      {d.map((p, i) => <path key={i} d={p} />)}
    </svg>
  )
}

// blueprint crop marks in the four corners of a frame
export function Corners() {
  return <div className="corners" aria-hidden="true"><i /><i /><i /><i /></div>
}

// round control with a progress arc (Orano-style ring)
export function RingButton({ progress, onClick, label, children, gold }: { progress: number; onClick: () => void; label: string; children: React.ReactNode; gold?: boolean }) {
  const C = 2 * Math.PI * 27
  return (
    <button className={`ring-btn${gold ? ' gold' : ''}`} onClick={onClick} aria-label={label} title={label}>
      <svg viewBox="0 0 60 60" aria-hidden="true">
        <circle cx="30" cy="30" r="27" className="track" />
        <circle cx="30" cy="30" r="27" className="arc" strokeDasharray={C} strokeDashoffset={C * (1 - Math.max(0, Math.min(1, progress)))} transform="rotate(-90 30 30)" />
      </svg>
      <span className="ic">{children}</span>
      <span className="lbl">{label}</span>
    </button>
  )
}
