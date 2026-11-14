// API client: every call has a timeout and falls back to precomputed JSON for preset AOIs (§8.4).
// VITE_API_URL for a separately hosted API (e.g. Vercel → HF Space); otherwise dev → local API, build → same origin
export const API = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/$/, '') ?? (import.meta.env.DEV ? 'http://127.0.0.1:8000' : '')
const TIMEOUT_MS = 4000          // with a cached fallback available (§8.4)
const TIMEOUT_NO_FALLBACK_MS = 20000  // custom AOIs have no fallback: wait longer rather than fail

export type Result<T> = { data: T; cached: boolean }

async function withTimeout(input: string, init: RequestInit = {}, ms = TIMEOUT_MS): Promise<Response> {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), ms)
  try {
    return await fetch(input, { ...init, signal: ctl.signal })
  } finally {
    clearTimeout(t)
  }
}

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

async function fallback<T>(key: string | null): Promise<Result<T>> {
  if (!key) throw new ApiError(0, 'The live API did not respond and there is no cached result for this custom area.')
  const r = await fetch(`${import.meta.env.BASE_URL}fallback/${key}.json`)
  // dev servers / SPA hosts answer missing files with index.html (200), so check the content type too
  if (!r.ok || !(r.headers.get('content-type') || '').includes('json'))
    throw new ApiError(0, 'The live API did not respond in time and no cached result exists for these settings. Try again in a moment.')
  return { data: (await r.json()) as T, cached: true }
}

export async function get<T>(path: string, fallbackKey: string | null, ms?: number): Promise<Result<T>> {
  try {
    const r = await withTimeout(`${API}${path}`, {}, ms ?? (fallbackKey ? TIMEOUT_MS : TIMEOUT_NO_FALLBACK_MS))
    if (!r.ok) throw new ApiError(r.status, await errText(r))
    return { data: (await r.json()) as T, cached: false }
  } catch (e) {
    if (e instanceof ApiError && e.status >= 400 && e.status < 500) throw e
    return fallback<T>(fallbackKey)
  }
}

export async function post<T>(path: string, body: unknown, fallbackKey: string | null, ms?: number): Promise<Result<T>> {
  try {
    const r = await withTimeout(`${API}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }, ms ?? (fallbackKey ? TIMEOUT_MS : TIMEOUT_NO_FALLBACK_MS))
    if (!r.ok) throw new ApiError(r.status, await errText(r))
    return { data: (await r.json()) as T, cached: false }
  } catch (e) {
    if (e instanceof ApiError && e.status >= 400 && e.status < 500) throw e
    return fallback<T>(fallbackKey)
  }
}

async function errText(r: Response): Promise<string> {
  try {
    const j = await r.json()
    return typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail)
  } catch {
    return `HTTP ${r.status}`
  }
}

export async function downloadCsv(path: string, body: unknown, filename: string): Promise<void> {
  const r = await withTimeout(`${API}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }, 60000)
  if (!r.ok) throw new ApiError(r.status, await errText(r))
  const blob = await r.blob()
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  URL.revokeObjectURL(a.href)
}
