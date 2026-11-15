export type Geometry = { type: 'Polygon' | 'MultiPolygon'; coordinates: unknown }
export type AOI = Geometry | { lat: number; lon: number; radius_km: number }

export type Filters = { min_conf: 'nominal' | 'all'; include_static: boolean; daynight: 'all' | 'D' | 'N' }

export type Preset = { id: string; name: string; kind: string; geometry: Geometry }

export type CalCell = {
  year: number; month: number; value: number | null; low: number | null; high: number | null
  provenance: 'observed' | 'estimated' | 'mixed' | 'no data'; coverage_pct: number
  incomplete: boolean; in_progress: boolean
  raw_naive_hotspots: number | null; raw_modis_hotspots: number | null; raw_viirs_hotspots: number | null
  modis_cells: number | null
}

export type Window = {
  start: string; end: string; start_doy: number; end_doy: number; share_of_annual: number
  length_days: number; active_now?: boolean; days_until?: number; sentence?: string
}

export type Status = { level: 'Normal' | 'Elevated' | 'Extreme' | 'No data'; sentence: string; S: number | null; P90: number | null; P99: number | null }

export type QueryResult = {
  summary: {
    as_of: string; start: string; end: string; last_observed_day: string; cells_in_aoi: number; area_km2: number
    clipped_fraction: number; complete_years: number[]; baseline_years: number[]; variant: string; status: Status
    calibration_used: { k_M: Record<string, number>; k_V: Record<string, number>; n_aoi_M: Record<string, number>; n_aoi_V: Record<string, number>; n0: number }
    eras: Record<string, { first: string; last: string; days: number }>
    viirs_handover: { snpp_last_data: string | null; noaa20_reference_from: string | null }
  }
  calendar_monthly: CalCell[]
  climatology: { month: number; name: string; median: number | null; p25: number | null; p75: number | null; mean: number | null; n_years: number | null }[]
  peaks: {
    top_months_of_year: { month: number; name: string; median: number }[]
    top_years: { year: number; total: number }[]
    top_single_months: { name: string; value: number; provenance: string }[]
    sentence: string
  }
  current_vs_median: { as_of: string; month: string; days_compared: number; value: number | null; median: number | null; ratio: number | null; percentile: number | null; rank: number | null; n: number | null; sentence: string; baseline: Record<string, number> }
  anomalies: {
    monthly: { year: number; month: number; ratio: number | null; diff: number | null; robust_z: number | null }[]
    annual: { year: number; total: number; vs_mean_ratio: number | null; vs_mean_diff: number | null; complete: boolean }[]
    annual_mean: number | null
  }
  counts: {
    raw_hotspots: { MODIS: number; VIIRS_reference: number; by_platform: Record<string, number> }
    burning_cell_days_harmonized: number; burning_cell_days_observed_union: number; observed_days: number; no_data_days: number; note: string
  }
  sensor_diff: {
    days_compared: number; totals: { both: number; modis_only: number; viirs_only: number }
    share_modis_cells_seen_by_viirs: number | null; share_viirs_cells_seen_by_modis: number | null
    monthly: { month: string; both: number; modis_only: number; viirs_only: number }[]; sentence: string
  }
  critical_windows: { windows: Window[]; threshold: number | null; curve?: (number | null)[]; sentence: string }
  upcoming_window: Window | null
  timeline: { date: string[]; H: (number | null)[]; S: (number | null)[]; P90: (number | null)[]; P99: (number | null)[]; status: string[]; provenance: string[]; H_low: (number | null)[]; H_high: (number | null)[] }
  provenance_legend: Record<string, string>
}

export type FireEvent = {
  event_id: number; start: string; end: string; duration_days: number; peak_day: string; peak_cells: number
  total_cell_days: number; footprint_cells: number; footprint_km2: number; centroid_lat: number; centroid_lon: number
  max_frp: number | null; rank_footprint: number; rank_duration: number; kind?: string
}

export type EventsResult = { n_events: number; since: string; note: string; current: FireEvent | null; top: FireEvent[]; in_range?: FireEvent[]; n_in_range?: number; sentence: string }

export type Marker = { date: string; label: string; source_url: string; verified: boolean }

export type ReplayResult = QueryResult & {
  replay: { as_of: string; window_start: string; first_alert: string | null; first_severe: string | null; alert_timeline: { date: string; S: number | null; P90: number | null; P99: number | null; status: string }[]; markers: Marker[] }
  events: EventsResult
}

export type Backtest = {
  rule: Record<string, unknown>; aoi: string; season: { start: string; end: string }
  result: { first_alert: string | null; first_severe: string | null; alert_days: number; severe_days: number; no_data_days: number; peak_S: number | null; peak_S_date: string | null; episode_onset?: string | null }
  markers: (Marker & { days_after_first_alert: number | null; days_after_first_severe: number | null; days_after_episode_onset?: number | null })[]
  honesty: { seasons: { season: string; alert: boolean; severe: boolean; first_alert: string | null; first_severe: string | null }[]; n_seasons: number; n_alert: number; n_severe: number; sentence: string; note: string }
  timeline: { date: string; H: number | null; S: number | null; P90: number | null; P99: number | null; alert: boolean; severe: boolean; status: string }[]
  reported_official: { fact: string; label: string; verified: boolean; source_url: string }[]
}

export type Methods = {
  calibration: { overlap_years: number[]; fit_note: string; k_M: Record<string, number>; k_V: Record<string, number>; k_M_ci: Record<string, [number, number]>; k_V_ci: Record<string, [number, number]>; eras: Record<string, { days: number; first: string | null; last: string | null }> }
  holdout: Record<'k_M' | 'k_V', { mape_pct: number | null; bias_pct: number; pearson_r: number; interval_coverage_pct: number; n_months: number }>
  stability: { k_M_by_year: Record<string, number>; k_V_by_year: Record<string, number>; drift_flag: boolean }
  seam_test: { annual: Record<string, { naive_hotspots: number; harmonized_cells: number; modis_cells: number }>; step_ratio_2012_16_vs_2007_11: Record<string, number | null>; interpretation: string }
  inter_viirs: Record<string, { overall?: number; apply: boolean; overlap_days?: number; months: Record<string, number | null> }>
  alert_rule: Record<string, unknown>
  markers: Marker[]
}

export type Detections = { type: 'FeatureCollection'; features: unknown[]; start: string; end: string; truncated: boolean; n: number }
