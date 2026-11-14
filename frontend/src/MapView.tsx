import maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { useEffect, useRef, useState } from 'react'
import { TerraDraw, TerraDrawPolygonMode, TerraDrawRectangleMode, TerraDrawRenderMode } from 'terra-draw'
import { TerraDrawMapLibreGLAdapter } from 'terra-draw-maplibre-gl-adapter'
import type { Detections, Geometry } from './types'

type Props = {
  coverage: unknown | null              // province FeatureCollection
  aoi: Geometry | null                  // currently selected AOI geometry (for display)
  detections: Detections | null
  onDraw: (g: Geometry) => void
}

// OpenFreeMap Positron (free, no key). © OpenMapTiles © OpenStreetMap contributors
const STYLE = 'https://tiles.openfreemap.org/styles/positron'

const EMPTY = { type: 'FeatureCollection', features: [] } as const

export default function MapView({ coverage, aoi, detections, onDraw }: Props) {
  const div = useRef<HTMLDivElement>(null)
  const map = useRef<maplibregl.Map | null>(null)
  const draw = useRef<TerraDraw | null>(null)
  const [ready, setReady] = useState(false)
  const [mode, setMode] = useState<'none' | 'rectangle' | 'polygon'>('none')
  const onDrawRef = useRef(onDraw)
  onDrawRef.current = onDraw

  useEffect(() => {
    const m = new maplibregl.Map({ container: div.current!, style: STYLE, center: [-57.8, -28.8], zoom: 6.3, canvasContextAttributes: { preserveDrawingBuffer: true } })
    m.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right')
    map.current = m
    m.on('load', () => {
      m.addSource('coverage', { type: 'geojson', data: EMPTY as any })
      m.addLayer({ id: 'coverage-line', type: 'line', source: 'coverage', paint: { 'line-color': '#333', 'line-width': 1.5, 'line-dasharray': [3, 2] } })
      m.addSource('aoi', { type: 'geojson', data: EMPTY as any })
      m.addLayer({ id: 'aoi-fill', type: 'fill', source: 'aoi', paint: { 'fill-color': '#31688e', 'fill-opacity': 0.08 } })
      m.addLayer({ id: 'aoi-line', type: 'line', source: 'aoi', paint: { 'line-color': '#31688e', 'line-width': 2 } })
      m.addSource('det', { type: 'geojson', data: EMPTY as any })
      m.addLayer({
        id: 'det', type: 'circle', source: 'det',
        paint: {
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 5, 1.6, 10, 4],
          'circle-color': ['match', ['get', 'sensor'], 'MODIS', '#e08214', '#542788'],
          'circle-opacity': 0.75,
        },
      })
      m.on('click', 'det', e => {
        const p = e.features?.[0]?.properties as any
        if (p) new maplibregl.Popup().setLngLat(e.lngLat).setHTML(`${p.sensor} · ${p.platform}<br/>${p.date}<br/>FRP ${p.frp ?? '—'} MW`).addTo(m)
      })
      const td = new TerraDraw({
        adapter: new TerraDrawMapLibreGLAdapter({ map: m }),
        modes: [new TerraDrawRectangleMode(), new TerraDrawPolygonMode(), new TerraDrawRenderMode({ modeName: 'static', styles: {} })],
      })
      td.start()
      td.setMode('static')
      td.on('finish', (id: string | number) => {
        const f = td.getSnapshot().find(x => x.id === id)
        if (f && f.geometry.type === 'Polygon') onDrawRef.current(f.geometry as unknown as Geometry)
        td.clear()
        td.setMode('static')
        setMode('none')
      })
      draw.current = td
      setReady(true)
    })
    return () => { draw.current?.stop(); m.remove() }
  }, [])

  useEffect(() => {
    if (!ready || !coverage) return
    ;(map.current!.getSource('coverage') as maplibregl.GeoJSONSource).setData(coverage as any)
  }, [ready, coverage])

  useEffect(() => {
    if (!ready) return
    const src = map.current!.getSource('aoi') as maplibregl.GeoJSONSource
    src.setData(aoi ? ({ type: 'Feature', geometry: aoi, properties: {} } as any) : (EMPTY as any))
    if (aoi) {
      const coords: number[][] = JSON.stringify(aoi.coordinates).match(/-?\d+\.?\d*,-?\d+\.?\d*/g)!.map(s => s.split(',').map(Number))
      const xs = coords.map(c => c[0]), ys = coords.map(c => c[1])
      map.current!.fitBounds([[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]], { padding: 30, duration: 400, maxZoom: 10 })
    }
  }, [ready, aoi])

  useEffect(() => {
    if (!ready) return
    ;(map.current!.getSource('det') as maplibregl.GeoJSONSource).setData((detections as any) || EMPTY)
  }, [ready, detections])

  const start = (m: 'rectangle' | 'polygon') => {
    draw.current?.setMode(m)
    setMode(m)
  }

  return (
    <div className="map-wrap">
      <div ref={div} className="map" />
      <div className="map-tools">
        <button className={mode === 'rectangle' ? 'on' : ''} onClick={() => start('rectangle')}>Draw rectangle</button>
        <button className={mode === 'polygon' ? 'on' : ''} onClick={() => start('polygon')}>Draw polygon</button>
        {mode === 'polygon' && <span className="hint">click to add points, click the first point to finish</span>}
      </div>
      <div className="map-legend">
        <span><i style={{ background: '#e08214' }} /> MODIS</span>
        <span><i style={{ background: '#542788' }} /> VIIRS</span>
        <span>- - coverage: Corrientes, Argentina</span>
        {detections && <span>{detections.n.toLocaleString()} detections {detections.start} → {detections.end}{detections.truncated ? ' (truncated)' : ''}</span>}
      </div>
    </div>
  )
}
