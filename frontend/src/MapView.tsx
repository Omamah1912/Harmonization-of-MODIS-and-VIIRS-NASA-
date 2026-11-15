import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { useEffect, useMemo, useRef, useState } from 'react'
import { TerraDraw, TerraDrawPolygonMode, TerraDrawRectangleMode, TerraDrawRenderMode } from 'terra-draw'
import { TerraDrawMapLibreGLAdapter } from 'terra-draw-maplibre-gl-adapter'
import type { Detections, Geometry } from './types'

export type DrawMode = 'none' | 'rectangle' | 'polygon' | 'pin'
type Props = {
  coverage: any | null           // province FeatureCollection
  aoi: Geometry | null
  detections: Detections | null
  drawMode: DrawMode
  accent: string
  onDraw: (g: Geometry) => void
  onPin: (lat: number, lon: number) => void
  onModeDone: () => void
  fitKey?: string                // refit only when this changes
  rings?: { lat: number; lon: number; label: string }[]   // ring hotspots (click to fly there)
}

// OpenFreeMap "dark" (free, no key). © OpenMapTiles © OpenStreetMap contributors
const STYLE = 'https://tiles.openfreemap.org/styles/dark'
const EMPTY = { type: 'FeatureCollection', features: [] } as any

function polyRings(fc: any): number[][][] {
  const out: number[][][] = []
  for (const f of fc?.features ?? []) {
    const g = f.geometry
    if (g?.type === 'Polygon') out.push(g.coordinates[0])
    if (g?.type === 'MultiPolygon') g.coordinates.forEach((p: number[][][]) => out.push(p[0]))
  }
  return out
}

export default function MapView({ coverage, aoi, detections, drawMode, accent, onDraw, onPin, onModeDone, fitKey, rings = [] }: Props) {
  const div = useRef<HTMLDivElement>(null)
  const map = useRef<maplibregl.Map | null>(null)
  const draw = useRef<TerraDraw | null>(null)
  const [ready, setReady] = useState(false)
  const fitB = useRef<[[number, number], [number, number]] | null>(null)
  const userMoved = useRef(false)
  const cb = useRef({ onDraw, onPin, onModeDone, drawMode })
  cb.current = { onDraw, onPin, onModeDone, drawMode }

  useEffect(() => {
    const m = new maplibregl.Map({
      container: div.current!, style: STYLE, center: [-57.8, -28.6], zoom: 6.2, attributionControl: { compact: true },
      canvasContextAttributes: { preserveDrawingBuffer: true },
    })
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right')
    map.current = m
    // keep the selected area framed while the layout morphs (lens switch), unless the user moved the map
    let settle = 0
    const ro = new ResizeObserver(() => {
      m.resize()
      window.clearTimeout(settle)
      settle = window.setTimeout(() => {
        if (fitB.current && !userMoved.current && m.getContainer().clientWidth > 50)
          m.fitBounds(fitB.current, { padding: 50, duration: 500, maxZoom: 10 })
      }, 140)
    })
    m.on('dragstart', () => { userMoved.current = true })
    m.on('zoomstart', e => { if ((e as any).originalEvent) userMoved.current = true })
    ro.observe(div.current!)
    m.on('load', () => {
      m.addSource('mask', { type: 'geojson', data: EMPTY })
      m.addLayer({ id: 'mask', type: 'fill', source: 'mask', paint: { 'fill-color': '#05070c', 'fill-opacity': 0.55 } })
      m.addSource('coverage', { type: 'geojson', data: EMPTY })
      m.addLayer({ id: 'coverage-glow', type: 'line', source: 'coverage', paint: { 'line-color': '#FB9B06', 'line-width': 8, 'line-blur': 8, 'line-opacity': 0.35 } })
      m.addLayer({ id: 'coverage-line', type: 'line', source: 'coverage', paint: { 'line-color': '#F7D13D', 'line-width': 1.4, 'line-opacity': 0.8 } })
      m.addSource('aoi', { type: 'geojson', data: EMPTY })
      m.addLayer({ id: 'aoi-fill', type: 'fill', source: 'aoi', paint: { 'fill-color': '#4FD1C5', 'fill-opacity': 0.08 } })
      m.addLayer({ id: 'aoi-glow', type: 'line', source: 'aoi', paint: { 'line-color': '#4FD1C5', 'line-width': 6, 'line-blur': 6, 'line-opacity': 0.4 } })
      m.addLayer({ id: 'aoi-line', type: 'line', source: 'aoi', paint: { 'line-color': '#4FD1C5', 'line-width': 1.6 } })
      m.addSource('det', { type: 'geojson', data: EMPTY })
      // embers: wide soft halo + bright core; t = 0 (oldest) … 1 (newest)
      m.addLayer({
        id: 'det-halo', type: 'circle', source: 'det',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 5, 10, 14],
          'circle-color': ['interpolate', ['linear'], ['get', 't'], 0, '#781C6D', 0.5, '#ED6925', 1, '#FB9B06'],
          'circle-blur': 1, 'circle-opacity': ['interpolate', ['linear'], ['get', 't'], 0, 0.18, 1, 0.45],
        },
      })
      m.addLayer({
        id: 'det', type: 'circle', source: 'det',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 1.6, 10, 4.5],
          'circle-color': ['interpolate', ['linear'], ['get', 't'], 0, '#A52C60', 0.5, '#ED6925', 0.85, '#F7D13D', 1, '#FCFFA4'],
          'circle-opacity': ['interpolate', ['linear'], ['get', 't'], 0, 0.55, 1, 1],
        },
      })
      m.on('click', 'det', e => {
        if (cb.current.drawMode !== 'none') return
        const p = e.features?.[0]?.properties as any
        if (p) new maplibregl.Popup({ closeButton: false }).setLngLat(e.lngLat).setHTML(`<b>${p.sensor}</b> · ${p.platform}<br/>${p.date}<br/>FRP ${p.frp ?? '—'} MW`).addTo(m)
      })
      m.on('mouseenter', 'det', () => { m.getCanvas().style.cursor = 'pointer' })
      m.on('mouseleave', 'det', () => { m.getCanvas().style.cursor = '' })
      m.on('click', e => {
        if (cb.current.drawMode !== 'pin') return
        cb.current.onPin(+e.lngLat.lat.toFixed(4), +e.lngLat.lng.toFixed(4))
        cb.current.onModeDone()
      })
      const td = new TerraDraw({
        adapter: new TerraDrawMapLibreGLAdapter({ map: m }),
        modes: [
          new TerraDrawRectangleMode({ styles: { fillColor: '#4FD1C5', fillOpacity: 0.15, outlineColor: '#4FD1C5', outlineWidth: 2 } }),
          new TerraDrawPolygonMode({ styles: { fillColor: '#4FD1C5', fillOpacity: 0.15, outlineColor: '#4FD1C5', outlineWidth: 2, closingPointColor: '#FCFFA4', closingPointWidth: 6 } }),
          new TerraDrawRenderMode({ modeName: 'static', styles: {} }),
        ],
      })
      td.start()
      td.setMode('static')
      td.on('finish', (id: string | number) => {
        const f = td.getSnapshot().find(x => x.id === id)
        if (f && f.geometry.type === 'Polygon') cb.current.onDraw(f.geometry as unknown as Geometry)
        td.clear()
        td.setMode('static')
        cb.current.onModeDone()
      })
      draw.current = td
      setReady(true)
    })
    return () => { ro.disconnect(); draw.current?.stop(); m.remove() }
  }, [])

  useEffect(() => {
    if (!ready || !draw.current) return
    draw.current.setMode(drawMode === 'rectangle' || drawMode === 'polygon' ? drawMode : 'static')
    map.current!.getCanvas().style.cursor = drawMode === 'pin' ? 'crosshair' : ''
  }, [ready, drawMode])

  useEffect(() => {
    if (!ready || !coverage) return
    ;(map.current!.getSource('coverage') as maplibregl.GeoJSONSource).setData(coverage)
    const holes = polyRings(coverage)
    ;(map.current!.getSource('mask') as maplibregl.GeoJSONSource).setData({
      type: 'Feature', properties: {},
      geometry: { type: 'Polygon', coordinates: [[[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]], ...holes.map(r => [...r].reverse())] },
    } as any)
  }, [ready, coverage])

  useEffect(() => {
    if (!ready) return
    const m = map.current!
    ;['aoi-fill', 'aoi-glow', 'aoi-line'].forEach(id => m.setPaintProperty(id, id === 'aoi-fill' ? 'fill-color' : 'line-color', accent))
  }, [ready, accent])

  useEffect(() => {
    if (!ready) return
    const src = map.current!.getSource('aoi') as maplibregl.GeoJSONSource
    src.setData(aoi ? ({ type: 'Feature', geometry: aoi, properties: {} } as any) : EMPTY)
    // "claimed plot": the outline flares, then settles (≈ 1 s)
    if (!aoi) return
    const m = map.current!, t0 = performance.now()
    let raf = 0
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / 1100), e = 1 - Math.pow(1 - k, 3)
      m.setPaintProperty('aoi-glow', 'line-width', 22 - 16 * e)
      m.setPaintProperty('aoi-glow', 'line-opacity', 0.95 - 0.55 * e)
      m.setPaintProperty('aoi-fill', 'fill-opacity', 0.28 - 0.2 * e)
      if (k < 1) raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, aoi])

  useEffect(() => {
    if (!ready || !aoi) return
    const coords: number[][] = JSON.stringify(aoi.coordinates).match(/-?\d+\.?\d*,-?\d+\.?\d*/g)!.map(s => s.split(',').map(Number))
    const xs = coords.map(c => c[0]), ys = coords.map(c => c[1])
    fitB.current = [[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]]
    userMoved.current = false
    // wait for layout (the stage may have just become visible or changed width)
    const t = window.setTimeout(() => {
      const m = map.current!
      m.resize()
      if (m.getContainer().clientWidth < 50) return
      m.fitBounds([[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]], { padding: 50, duration: 700, maxZoom: 10 })
    }, 80)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, fitKey])

  const fc = useMemo(() => {
    if (!detections) return EMPTY
    const s = Date.parse(detections.start), e = Date.parse(detections.end)
    const span = Math.max(1, e - s)
    return { ...detections, features: (detections.features as any[]).map(f => ({ ...f, properties: { ...f.properties, t: Math.max(0, Math.min(1, (Date.parse(f.properties.date) - s) / span)) } })) }
  }, [detections])
  useEffect(() => {
    if (!ready) return
    ;(map.current!.getSource('det') as maplibregl.GeoJSONSource).setData(fc)
  }, [ready, fc])

  const ringKey = JSON.stringify(rings)
  useEffect(() => {
    if (!ready) return
    const m = map.current!
    const ms = rings.map(r => {
      const el = document.createElement('button')
      el.className = 'hot-ring'
      el.setAttribute('aria-label', r.label)
      el.innerHTML = `<i></i><span>${r.label}</span>`
      el.addEventListener('click', ev => { ev.stopPropagation(); userMoved.current = true; m.flyTo({ center: [r.lon, r.lat], zoom: Math.max(m.getZoom(), 9), duration: 1400, essential: true }) })
      return new maplibregl.Marker({ element: el }).setLngLat([r.lon, r.lat]).addTo(m)
    })
    return () => ms.forEach(x => x.remove())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, ringKey])

  return <div ref={div} className="map" />
}
