// Inhalt: Strava-REST-Aufrufe und Aktivitaets-Sync.
// Zweck: inkrementeller Sync mit Overlap-Lookback (T-109), Last-Sync-Zeitstempel,
//   429-bewusstes Laden von Streams/Laps (Cache vor Token, T-259 P-07).
// Einstieg: syncActivities, StravaRateLimitError, syncAnchorTs/OVERLAP_DAYS,
//   secsSinceLastSync/SYNC_MIN_INTERVAL_SEC, fetchActivityStreams, fetchActivityLaps.
// Abschnitte: Fehlerklasse · Sync-Zeitstempel · Aktivitaetsliste · Streams/Laps-Fetcher.
// Intern (fuer bulk, nicht im Index): _fetchStreams429/_fetchLaps429, Fetch*Result.
// Regeln: importiert ./auth, ./cache, ./types. Basis-URL nur hier (STRAVA_API_BASE, T-117).
import { getValidToken } from './auth'
import { loadCachedActivities, saveCachedActivities, _loadCachedStream, _cacheStream, _loadCachedLaps, _cacheLaps } from './cache'
import type { StravaActivity, ActivityStreams } from './types'

// Thrown by fetchActivitiesAfter (and propagated through syncActivities) when Strava returns
// HTTP 429. Callers (e.g. App.tsx trySync) can use `instanceof StravaRateLimitError` to show
// a user-friendly rate-limit message instead of the raw status string.
// Mirrors the T-129 pattern used by _fetchStreams429/_fetchLaps429 (sentinel there, typed
// error here — typed error is cleaner for async call-stack propagation).
export class StravaRateLimitError extends Error {
  readonly retryAfter: number | undefined
  constructor(retryAfterSec?: number) {
    super('Strava API 429: rate limit reached')
    this.name = 'StravaRateLimitError'
    this.retryAfter = retryAfterSec
    // Restore prototype chain for instanceof to work correctly in transpiled output
    Object.setPrototypeOf(this, new.target.prototype)
  }
}
export const STRAVA_LAST_SYNC_KEY = 'strava_last_sync'
// T-117: Cutover auf www.api-v3.strava.com erst ab 4.1.2027 — nur diese Zeile ändern
const STRAVA_API_BASE    = 'https://www.strava.com/api/v3'
export function saveLastSyncTimestamp(): void {
  try { localStorage.setItem(STRAVA_LAST_SYNC_KEY, new Date().toISOString()) } catch {}
}

export function loadLastSyncTimestamp(): Date | null {
  try {
    const raw = localStorage.getItem(STRAVA_LAST_SYNC_KEY)
    if (!raw) return null
    const d = new Date(raw)
    return isNaN(d.getTime()) ? null : d
  } catch { return null }
}

// Minimum seconds between auto-syncs to avoid hammering the Strava API on
// rapid focus/visibility flicker (e.g., notification bar swipe on iOS).
export const SYNC_MIN_INTERVAL_SEC = 60

// Returns seconds since the last successful syncActivities call,
// or Infinity when no sync has been recorded (first launch / cleared storage).
export function secsSinceLastSync(): number {
  const last = loadLastSyncTimestamp()
  if (!last) return Infinity
  return (Date.now() - last.getTime()) / 1000
}
function activityTs(a: StravaActivity): number {
  try { return new Date(a.start_date).getTime() / 1000 }
  catch { return 0 }
}

async function fetchActivitiesAfter(token: string, afterTs: number): Promise<StravaActivity[]> {
  const all: StravaActivity[] = []
  let page = 1
  while (true) {
    const r = await fetch(
      `${STRAVA_API_BASE}/athlete/activities?after=${afterTs}&page=${page}&per_page=200`,
      { headers: { Authorization: `Bearer ${token}` } }
    )
    if (r.status === 429) {
      const retryAfterRaw = r.headers.get('Retry-After')
      const retryAfter = retryAfterRaw ? parseInt(retryAfterRaw, 10) : undefined
      throw new StravaRateLimitError(Number.isFinite(retryAfter) ? retryAfter : undefined)
    }
    if (!r.ok) throw new Error(`Strava API error: ${r.status}`)
    const batch: StravaActivity[] = await r.json()
    if (!batch.length) break
    all.push(...batch)
    if (batch.length < 200) break
    page++
  }
  return all
}

// Overlap lookback to catch backdated / manually-added / late-uploaded activities.
// Using strictly latestTs as the "after" anchor means any activity whose start_date
// is not strictly newer than the newest cached activity is silently skipped forever.
// A 45-day window covers realistic backdating and is small enough to stay fast (T-109).
export const OVERLAP_DAYS = 45

export function syncAnchorTs(latestTs: number, cutoffTs: number): number {
  return Math.max(cutoffTs, latestTs - OVERLAP_DAYS * 86400)
}

export async function syncActivities(weeksBack = 52): Promise<StravaActivity[]> {
  const token = await getValidToken()
  if (!token) throw new Error('Not authenticated')

  const cutoffTs = Math.floor((Date.now() - weeksBack * 7 * 24 * 3600 * 1000) / 1000)
  const cached   = loadCachedActivities()

  let newActs: StravaActivity[]
  if (cached.length) {
    const latestTs = Math.max(...cached.map(activityTs), cutoffTs)
    // Overlap window: go back up to OVERLAP_DAYS so backdated activities are fetched.
    // Merge-by-id (below) deduplicates, so no double-counting in weekly km / ATL-CTL.
    // Residual: activities backdated > 45 days remain unfetched — accepted, see T-109.
    newActs = await fetchActivitiesAfter(token, syncAnchorTs(latestTs, cutoffTs))
  } else {
    newActs = await fetchActivitiesAfter(token, cutoffTs)
  }

  const idMap = new Map(cached.map(a => [a.id, a]))
  for (const a of newActs) idMap.set(a.id, a)
  const merged = Array.from(idMap.values()).filter(a => activityTs(a) >= cutoffTs)
  saveCachedActivities(merged)
  saveLastSyncTimestamp()
  return merged
}

// Sentinel value distinguishing 429 (rate-limited) from other errors.
// Callers must check `=== 'rate_limited'` to abort the bulk-fetch loop.
export type FetchStreamResult = ActivityStreams | null | 'rate_limited'
export type FetchLapsResult   = any[]           | null | 'rate_limited' // eslint-disable-line @typescript-eslint/no-explicit-any

export async function fetchActivityStreams(activityId: number): Promise<FetchStreamResult> {
  // Delegiert an den 429-bewussten Fetcher: reicht den 'rate_limited'-Sentinel durch, statt
  // 429 (wie früher) still als null zu maskieren (T-129). Entfernt zugleich das Duplikat der
  // Fetch/Parse/Cache-Logik — war eine Kopie von _fetchStreams429.
  const cached = _loadCachedStream(activityId)   // T-259 P-07: Cache vor Token (offline lesbar)
  if (cached) return cached
  const token = await getValidToken()
  if (!token) return null
  return _fetchStreams429(activityId, token)
}

// Strava lap raw data — variable structure, parsed in analyzeWorkoutLaps()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function fetchActivityLaps(activityId: number): Promise<FetchLapsResult> {
  const cached = _loadCachedLaps(activityId)   // T-259 P-07: Cache vor Token
  if (cached) return cached
  const token = await getValidToken()
  if (!token) return null
  return _fetchLaps429(activityId, token)
}

// 429-aware internal fetchers — return 'rate_limited' sentinel on HTTP 429.
export async function _fetchStreams429(id: number, token: string): Promise<FetchStreamResult> {
  const cached = _loadCachedStream(id)
  if (cached) return cached
  const keys = 'time,velocity_smooth,heartrate,altitude,distance'
  const res = await fetch(
    `${STRAVA_API_BASE}/activities/${id}/streams?keys=${keys}&key_by_type=true`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  if (res.status === 429) return 'rate_limited'
  if (!res.ok) return null
  const raw = await res.json()
  const streams: ActivityStreams = {
    time:            raw.time?.data            ?? [],
    velocity_smooth: raw.velocity_smooth?.data ?? [],
    heartrate:       raw.heartrate?.data,
    altitude:        raw.altitude?.data,
    distance:        raw.distance?.data,
  }
  _cacheStream(id, streams)
  return streams
}

export async function _fetchLaps429(id: number, token: string): Promise<FetchLapsResult> {
  const cached = _loadCachedLaps(id)
  if (cached) return cached
  const res = await fetch(
    `${STRAVA_API_BASE}/activities/${id}/laps`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  if (res.status === 429) return 'rate_limited'
  if (!res.ok) return null
  const laps = await res.json()
  _cacheLaps(id, laps)
  return laps
}
