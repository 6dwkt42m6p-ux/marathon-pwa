// Strava OAuth2 + activity sync
import { vdotFromRace as _vdotFromRace, trainingPaces, effortNormalizationFactor } from './vdot'

// Thrown by fetchActivitiesAfter (and propagated through syncActivities) when Strava returns
// HTTP 429. Callers (e.g. StravaSync.tsx) can use `instanceof StravaRateLimitError` to show
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

const CLIENT_ID     = import.meta.env.VITE_STRAVA_CLIENT_ID || ''
// Token exchange/refresh go through the server-side proxy — secret never enters the client bundle.
const TOKEN_PROXY   = import.meta.env.VITE_STRAVA_TOKEN_PROXY || ''
// Use env var if set explicitly, otherwise derive from current origin + Vite BASE_URL
// This works for both localhost dev and GitHub Pages (/marathon-pwa/) without any secrets config
export const REDIRECT_URI  = import.meta.env.VITE_STRAVA_REDIRECT_URI ||
  (window.location.origin + import.meta.env.BASE_URL)
const TOKEN_KEY          = 'strava_tokens'
const ACTS_KEY           = 'strava_activities'
export const STRAVA_LAST_SYNC_KEY = 'strava_last_sync'
// T-163: cap on how many activities' stream/laps caches to keep (oldest beyond cap are evicted).
// iOS localStorage ~5 MB; each stream can be 20–100 KB → 40 activities ≈ safe upper bound.
export const STREAM_CACHE_MAX = 40
// T-163: flag key set when all eviction attempts still failed — App shows a storage warning banner.
export const STORAGE_WARNING_KEY = '_strava_storage_warning'
// T-117: Cutover auf www.api-v3.strava.com erst ab 4.1.2027 — nur diese Zeile ändern
const STRAVA_API_BASE    = 'https://www.strava.com/api/v3'

export interface StravaTokens {
  access_token:  string
  refresh_token: string
  expires_at:    number
  athlete?: { firstname: string; lastname: string; id: number }
}

export interface StravaActivity {
  id:                number
  name:              string
  type:              string
  sport_type:        string
  start_date:        string
  start_date_local:  string
  distance:          number
  moving_time:       number
  total_elevation_gain: number
  average_heartrate?: number
  max_heartrate?:    number
  average_speed:     number
  suffer_score?:     number
  workout_type?:     number
  average_temp?:     number   // °C, only present if device recorded temperature
  // Power fields (T-125) — present on Rides with a power meter
  weighted_average_watts?: number   // Normalized Power (NP) from Strava
  average_watts?:          number   // Average Power (fallback when NP not available)
  device_watts?:           boolean  // true = power from hardware meter, not estimated
}

export function getAuthUrl(): string {
  const params = new URLSearchParams({
    client_id:       CLIENT_ID,
    redirect_uri:    REDIRECT_URI,
    response_type:   'code',
    approval_prompt: 'auto',
    scope:           'read,activity:read_all',
  })
  return `https://www.strava.com/oauth/authorize?${params}`
}

export function loadTokens(): StravaTokens | null {
  try {
    const raw = localStorage.getItem(TOKEN_KEY)
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

export function saveTokens(t: StravaTokens): void {
  localStorage.setItem(TOKEN_KEY, JSON.stringify(t))
}

export function clearTokens(): void {
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(ACTS_KEY)
}

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

export function isAuthenticated(): boolean {
  return loadTokens() !== null
}

async function refreshTokens(refreshToken: string): Promise<StravaTokens> {
  if (!TOKEN_PROXY) throw new Error('VITE_STRAVA_TOKEN_PROXY not configured')
  const r = await fetch(`${TOKEN_PROXY}/strava/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // Worker appends client_id + client_secret server-side
    body: JSON.stringify({ refresh_token: refreshToken }),
  })
  if (!r.ok) throw new Error(`Token refresh failed: ${r.status}`)
  const tokens = await r.json()
  saveTokens(tokens)
  return tokens
}

export async function getValidToken(): Promise<string | null> {
  let tokens = loadTokens()
  if (!tokens) return null
  if (tokens.expires_at < Date.now() / 1000 + 300) {
    try { tokens = await refreshTokens(tokens.refresh_token) }
    catch { return null }
  }
  return tokens.access_token
}

export async function exchangeCode(code: string): Promise<StravaTokens> {
  if (!TOKEN_PROXY) throw new Error('VITE_STRAVA_TOKEN_PROXY not configured')
  const r = await fetch(`${TOKEN_PROXY}/strava/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // Worker appends client_id + client_secret server-side
    body: JSON.stringify({ code, redirect_uri: REDIRECT_URI }),
  })
  if (!r.ok) throw new Error(`Auth failed: ${r.status} ${await r.text()}`)
  const tokens = await r.json()
  saveTokens(tokens)
  return tokens
}

function loadCachedActivities(): StravaActivity[] {
  try {
    const raw = localStorage.getItem(ACTS_KEY)
    return raw ? JSON.parse(raw) : []
  } catch { return [] }
}

// T-163: remove all _strava_stream_* and _strava_laps_* keys from localStorage.
// Streams are always re-fetchable from Strava — safe to evict unconditionally.
export function evictAllStreamLapsCaches(): void {
  const keysToRemove: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i) || ''
    if (k.startsWith('_strava_stream_') || k.startsWith('_strava_laps_')) {
      keysToRemove.push(k)
    }
  }
  for (const k of keysToRemove) localStorage.removeItem(k)
}

// T-163: keep stream/laps caches only for the N most recent activities.
// Called after the bulk analytics fetch so the cache never grows unboundedly.
export function capStreamLapsCaches(maxActivities = STREAM_CACHE_MAX): void {
  // Load activity list to determine recency order
  let acts: StravaActivity[] = []
  try {
    const raw = localStorage.getItem(ACTS_KEY)
    acts = raw ? JSON.parse(raw) : []
  } catch { return }

  // Sort descending by start_date (UTC ISO string compare is safe for lexicographic sort)
  const sorted = [...acts].sort((a, b) =>
    String(b.start_date).localeCompare(String(a.start_date))
  )
  const keepIds = new Set(sorted.slice(0, maxActivities).map(a => String(a.id)))

  const keysToRemove: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i) || ''
    if (k.startsWith('_strava_stream_') || k.startsWith('_strava_laps_')) {
      const id = k.replace('_strava_stream_', '').replace('_strava_laps_', '')
      if (!keepIds.has(id)) keysToRemove.push(k)
    }
  }
  for (const k of keysToRemove) localStorage.removeItem(k)
}

// T-163: storage warning helpers — exported so App.tsx can read and clear the flag.
export function getStorageWarning(): string | null {
  try { return localStorage.getItem(STORAGE_WARNING_KEY) }
  catch { return null }
}

export function clearStorageWarning(): void {
  try { localStorage.removeItem(STORAGE_WARNING_KEY) }
  catch {}
}

// T-163: Prioritised save strategy:
//   1. Try writing the full activity list directly.
//   2. On quota error: evict ALL stream/laps caches, then retry the full list.
//   3. Only as last resort (still fails after eviction): trim to 500 and retry.
//   4. If all three fail: set STORAGE_WARNING_KEY and return false (never throw).
//   Returns true on success (any path), false only on total failure.
// Exported as saveCachedActivitiesExported for unit tests; internal callers use the private alias.
export function saveCachedActivitiesExported(acts: StravaActivity[]): boolean {
  const payload = JSON.stringify(acts)
  try {
    localStorage.setItem(ACTS_KEY, payload)
    clearStorageWarning()
    return true
  } catch {
    // First fallback: evict stream/laps caches (they are re-fetchable), then retry full list.
    evictAllStreamLapsCaches()
    try {
      localStorage.setItem(ACTS_KEY, payload)
      clearStorageWarning()
      return true
    } catch {
      // Last resort: trim and retry. Avoids total loss when storage is genuinely full.
      const trimmed = acts.slice(-500)
      try {
        localStorage.setItem(ACTS_KEY, JSON.stringify(trimmed))
        try { localStorage.setItem(STORAGE_WARNING_KEY, '1') } catch {}
        return false  // trimmed save counts as failure — caller shows warning
      } catch {
        try { localStorage.setItem(STORAGE_WARNING_KEY, '1') } catch {}
        return false
      }
    }
  }
}

// Internal alias used by syncActivities — keeps the rest of the file unchanged.
function saveCachedActivities(acts: StravaActivity[]): void {
  saveCachedActivitiesExported(acts)
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

export function getCachedActivities(): StravaActivity[] {
  return loadCachedActivities()
}

export interface RunSummary {
  id:          number
  name:        string
  date:        Date
  distanceKm:  number
  durationSec: number
  paceSec:     number
  paceFmt:     string
  avgHr?:      number
  maxHr?:      number
  elevationM:  number
  tempC?:      number
}

export interface ActivitySummary extends RunSummary {
  actType:      'run' | 'ride' | 'hike'
  isTrail:      boolean
  workoutType?: number
  speedKmh?:    number
}

export function isRunType(a: StravaActivity): boolean {
  return a.type === 'Run' || a.sport_type === 'Run' ||
         a.type === 'TrailRun' || a.sport_type === 'TrailRun'
}
function isRideType(a: StravaActivity): boolean {
  return a.type === 'Ride' || a.sport_type === 'Ride' ||
         a.type === 'VirtualRide' || a.sport_type === 'VirtualRide'
}
function isHikeType(a: StravaActivity): boolean {
  return a.type === 'Hike' || a.sport_type === 'Hike' ||
         a.type === 'Walk' || a.sport_type === 'Walk'
}

export const DAY_TAGS: Record<number, string> = { 0: 'So', 1: 'Mo', 2: 'Di', 3: 'Mi', 4: 'Do', 5: 'Fr', 6: 'Sa' }

// Strava sends start_date_local as LOCAL wallclock time with a misleading 'Z' (or +HH:MM) suffix.
// Stripping the TZ designator makes JS parse the string as local time → correct week bucketing.
// Falls back to start_date (true UTC) when start_date_local is absent.
export function parseStravaLocal(a: StravaActivity): Date {
  const s = a.start_date_local || a.start_date
  return new Date(s.replace(/(Z|[+-]\d{2}:?\d{2})$/, ''))
}

export function parseAllActivities(activities: StravaActivity[]): ActivitySummary[] {
  return activities
    .filter(a => isRunType(a) || isRideType(a) || isHikeType(a))
    .map(a => {
      const distKm  = (a.distance || 0) / 1000
      const durSec  = a.moving_time || 0
      const paceSec = distKm > 0.1 ? durSec / distKm : 0
      const paceMin = Math.floor(paceSec / 60)
      const paceSc  = Math.round(paceSec % 60)
      const speedKmh = durSec > 0 ? (distKm / durSec) * 3600 : 0
      const actType: 'run' | 'ride' | 'hike' = isRunType(a) ? 'run' : isRideType(a) ? 'ride' : 'hike'
      const isTrail = a.type === 'TrailRun' || a.sport_type === 'TrailRun'
      return {
        id:          a.id,
        name:        a.name,
        date:        parseStravaLocal(a),
        distanceKm:  Math.round(distKm * 100) / 100,
        durationSec: durSec,
        paceSec,
        paceFmt:     paceSec > 0 ? `${paceMin}:${paceSc.toString().padStart(2, '0')}` : '—',
        avgHr:       a.average_heartrate,
        maxHr:       a.max_heartrate,
        elevationM:  Math.round(a.total_elevation_gain || 0),
        tempC:       a.average_temp,
        actType,
        isTrail,
        workoutType: a.workout_type,
        speedKmh:    Math.round(speedKmh * 10) / 10,
      } satisfies ActivitySummary
    })
    .sort((a, b) => b.date.getTime() - a.date.getTime())
}

export interface WeekStats {
  weekStart:   Date
  actualKm:    number
  runs:        number
  avgHr:       number | null
  elevationM:  number
  avgPaceSec:  number | null
}

export function mondayOf(d: Date): Date {
  const day  = d.getDay()
  const diff = day === 0 ? -6 : 1 - day
  const r    = new Date(d)
  r.setDate(r.getDate() + diff)
  r.setHours(0, 0, 0, 0)
  return r
}

// Local YYYY-MM-DD without UTC shift (toISOString would return the previous
// day for local-midnight dates in timezones east of UTC).
export function localISODate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function computeWeeklyStats(runs: RunSummary[]): WeekStats[] {
  const map      = new Map<string, WeekStats>()
  const paceMap  = new Map<string, number[]>()
  // Accumulate HR sum + count per week for true arithmetic mean (not rolling-pair average)
  const hrSumMap   = new Map<string, number>()
  const hrCountMap = new Map<string, number>()

  for (const r of runs) {
    const ws  = mondayOf(r.date)
    const key = localISODate(ws)
    if (!map.has(key)) {
      map.set(key, { weekStart: ws, actualKm: 0, runs: 0, avgHr: null, elevationM: 0, avgPaceSec: null })
      paceMap.set(key, [])
      hrSumMap.set(key, 0)
      hrCountMap.set(key, 0)
    }
    const s = map.get(key)!
    s.actualKm   += r.distanceKm
    s.runs        += 1
    s.elevationM  += r.elevationM
    if (r.avgHr) {
      hrSumMap.set(key, (hrSumMap.get(key) ?? 0) + r.avgHr)
      hrCountMap.set(key, (hrCountMap.get(key) ?? 0) + 1)
    }
    if (r.paceSec > 0 && r.distanceKm >= 2) paceMap.get(key)!.push(r.paceSec)
  }

  return Array.from(map.values())
    .map(s => {
      const key = localISODate(s.weekStart)
      const paces = paceMap.get(key) ?? []
      const avgPaceSec = paces.length > 0
        ? Math.round(paces.reduce((a, b) => a + b, 0) / paces.length)
        : null
      const hrCount = hrCountMap.get(key) ?? 0
      const avgHr   = hrCount > 0 ? Math.round((hrSumMap.get(key) ?? 0) / hrCount) : null
      return { ...s, actualKm: Math.round(s.actualKm * 10) / 10, avgPaceSec, avgHr }
    })
    .sort((a, b) => a.weekStart.getTime() - b.weekStart.getTime())
}

export interface EasyHrTrend {
  direction:   '↑' | '↓' | '→'
  earlyAvgHr:  number
  recentAvgHr: number
  deltaBpm:    number
  label:       string
  color:       string
}

export interface VdotTrend {
  delta:       number
  early:       number
  recent:      number
  direction:   '↑' | '↓' | '→'
  label:       string
  color:       string
  fromTraining:           boolean
  insufficientEffortRuns: boolean  // true when VDOT numbers are based on easy runs (unreliable)
  easyHrTrend?:           EasyHrTrend
}

export function vdotTrendFromActivities(
  runs: RunSummary[],
  currentVdot: number,
  maxHr = 190,
  restHr = 50,
): VdotTrend | null {
  const paces       = trainingPaces(currentVdot)
  const eHighPaceSec = paces.E_high   // upper Easy boundary; faster pace = M-zone or above
  const hrr          = maxHr - restHr

  const now           = new Date()
  const eightWeeksAgo = new Date(now.getTime() - 8 * 7 * 24 * 3600 * 1000)
  const fourWeeksAgo  = new Date(now.getTime() - 4 * 7 * 24 * 3600 * 1000)

  // A run is a meaningful "effort run" if HR is in Z3+ OR pace is at M-zone or faster.
  // Easy runs give a falsely low computed VDOT and must be excluded from the trend.
  function isEffortRun(r: RunSummary): boolean {
    if (r.distanceKm < 3 || r.durationSec === 0 || r.paceSec < 180 || r.paceSec > 420) return false
    if (r.avgHr && hrr > 0) return (r.avgHr - restHr) / hrr * 100 >= 65
    return r.paceSec < eHighPaceSec * 0.98  // no HR: accept only M-zone pace or faster
  }

  // ── Aerobic efficiency trend from easy runs ───────────────────────────────
  // When only Easy training is happening (Basis phase), track average HR at
  // easy effort — HR going down at the same pace is the real fitness signal.
  const easyInWindow = runs.filter(r =>
    r.date >= eightWeeksAgo && !!r.avgHr && r.distanceKm >= 3 && hrr > 0 &&
    // T-086/T-120: unified boundary at <65% HRR (same as coach.py:282).
    // Previously <70% caused 65–70% runs to appear in BOTH easy_hr_trend and effort signal.
    (r.avgHr - restHr) / hrr * 100 < 65
  )
  const earlyEasy  = easyInWindow.filter(r => r.date < fourWeeksAgo)
  const recentEasy = easyInWindow.filter(r => r.date >= fourWeeksAgo)

  let easyHrTrend: EasyHrTrend | undefined
  if (earlyEasy.length >= 2 && recentEasy.length >= 2) {
    const avg = (arr: RunSummary[]) => arr.reduce((s, r) => s + (r.avgHr ?? 0), 0) / arr.length
    const earlyAvgHr  = Math.round(avg(earlyEasy) * 10) / 10
    const recentAvgHr = Math.round(avg(recentEasy) * 10) / 10
    const deltaBpm    = Math.round((recentAvgHr - earlyAvgHr) * 10) / 10
    let direction: '↑' | '↓' | '→', label: string, color: string
    if      (deltaBpm <= -2) { direction = '↑'; label = `Ø HF ↓ ${Math.abs(deltaBpm)} bpm — aerobe Effizienz steigt`; color = '#4CAF50' }
    else if (deltaBpm >= 3)  { direction = '↓'; label = `Ø HF ↑ ${deltaBpm} bpm — Ermüdung oder Hitzephase?`;         color = '#e53935' }
    else                     { direction = '→'; label = 'Aerobe Effizienz bei Easy-Läufen stabil';                      color = '#FFC107' }
    easyHrTrend = { direction, earlyAvgHr, recentAvgHr, deltaBpm, label, color }
  }

  // ── VDOT trend from effort runs ───────────────────────────────────────────
  const effortRuns = runs.filter(r => r.date >= eightWeeksAgo && isEffortRun(r))

  const withVdot = effortRuns.map(r => {
    try {
      // T-140: GAP + Hitze-Normalisierung — durationSec/factor = äquivalente Flachdauer.
      // Roh-Filter (isEffortRun) und easyHrTrend bleiben auf unbereinigten Werten.
      const factor = effortNormalizationFactor(r.distanceKm, r.elevationM, r.tempC)
      const v = _vdotFromRace(r.distanceKm * 1000, r.durationSec / factor)
      return { ...r, computedVdot: (v > 20 && v < 85) ? v : null }
    } catch { return { ...r, computedVdot: null } }
  }).filter(r => r.computedVdot !== null) as (RunSummary & { computedVdot: number })[]

  const earlyEffort  = withVdot.filter(r => r.date < fourWeeksAgo)
  const recentEffort = withVdot.filter(r => r.date >= fourWeeksAgo)

  // Not enough effort runs — return early HR trend only (or null)
  if (withVdot.length < 2 || recentEffort.length === 0) {
    if (!easyHrTrend) return null
    return {
      delta: 0, early: 0, recent: 0,
      direction: easyHrTrend.direction, label: easyHrTrend.label, color: easyHrTrend.color,
      fromTraining: true, insufficientEffortRuns: true, easyHrTrend,
    }
  }

  // T-120: Use mean of ALL effort VDOTs per half — mirrors coach.py:365-366 (.mean()).
  // Previous bestVdot() used threshold-filtered top-3, giving different early/recent/delta
  // for the same activities. SSoT is coach.py → PWA must match.
  const threshold = currentVdot * 0.82
  const meanVdot = (list: typeof withVdot): number => {
    if (!list.length) return 0
    return list.reduce((s, r) => s + r.computedVdot, 0) / list.length
  }

  const recent = Math.round(meanVdot(recentEffort) * 10) / 10
  const early  = earlyEffort.length >= 1 ? Math.round(meanVdot(earlyEffort) * 10) / 10 : recent
  const delta  = Math.round((recent - early) * 10) / 10

  const fromTraining           = earlyEffort.filter(r => r.computedVdot >= threshold).length < 2 ||
                                  recentEffort.filter(r => r.computedVdot >= threshold).length < 2
  const insufficientEffortRuns = earlyEffort.length < 1

  let direction: '↑' | '↓' | '→', label: string, color: string
  if (delta >= 0.3)       { direction = '↑'; label = `+${delta} VDOT`;      color = '#4CAF50' }
  else if (delta <= -0.3) { direction = '↓'; label = `${delta} VDOT`;       color = '#e53935' }
  else                    { direction = '→'; label = 'Stabiler VDOT-Trend'; color = '#FFC107' }

  return { delta, early, recent, direction, label, color, fromTraining, insufficientEffortRuns, easyHrTrend }
}

// ── Efficiency Factor trend (Friel EF) — faithful port of coach.py:392 ───────

export interface EfWeeklyPoint {
  weekStart: Date
  efMedian:  number
  efSmooth:  number
  runCount:  number
}

export interface EfficiencyFactorTrendResult {
  weekly:    EfWeeklyPoint[]
  earlyEf:   number | null
  recentEf:  number | null
  deltaEf:   number | null
  deltaPct:  number
  direction: '↑' | '↓' | '→'
  label:     string
  color:     string
  noHrData:  boolean
}

/**
 * Friel Efficiency Factor (EF) trend for aerobic / Easy runs.
 * EF = (avg_speed_m_s × 60) / avg_hr  (metres per heartbeat).
 * A rising EF means the athlete runs faster at the same cardiac cost.
 *
 * Filters: HR 50–80% HRR, distance ≥3 km, speed 1.1–4.2 m/s.
 * Weekly aggregation = MEDIAN EF (outlier-robust).
 * Trend line = 3-week rolling median (center).
 * early/recent = mean of weekly medians in first/second 4-week half.
 * Thresholds: ≥+2% → ↑, ≤−2% → ↓, else →.
 * Returns null if <4 qualifying runs or <2 qualifying weeks.
 */
export function efficiencyFactorTrend(
  runs: RunSummary[],
  maxHr  = 190,
  restHr = 50,
  weeks  = 8,
): EfficiencyFactorTrendResult | null {
  const hrr = maxHr - restHr
  if (hrr <= 0) return null

  // no_hr_data: all runs have no avgHr
  const hasAnyHr = runs.some(r => r.avgHr != null && r.avgHr > 0)
  if (!hasAnyHr) {
    return {
      weekly: [], earlyEf: null, recentEf: null, deltaEf: null, deltaPct: 0,
      direction: '→',
      label: 'Kein HF-Sensor — EF nicht berechenbar',
      color: '#888888',
      noHrData: true,
    }
  }

  const cutoff = new Date(Date.now() - weeks * 7 * 24 * 3600 * 1000)

  // ── 1. Filter qualifying runs ───────────────────────────────────────────────
  const qualifying = runs.filter(r => {
    if (!r.avgHr || r.avgHr <= 0) return false
    if (r.distanceKm < 3) return false
    if (r.durationSec <= 0) return false
    if (r.date < cutoff) return false
    const hrPct = (r.avgHr - restHr) / hrr * 100
    if (hrPct < 50 || hrPct >= 80) return false
    // speed in m/s derived from distanceKm + durationSec (no avg_speed field on RunSummary)
    const speedMs = (r.distanceKm * 1000) / r.durationSec
    if (speedMs < 1.1 || speedMs > 4.2) return false
    return true
  })

  if (qualifying.length < 4) return null

  // ── 2. Per-run EF ──────────────────────────────────────────────────────────
  const withEf = qualifying.map(r => {
    const speedMs = (r.distanceKm * 1000) / r.durationSec
    // T-140: GAP + Hitze-Normalisierung — Speed mit Faktor skalieren.
    // Roh-Filter (qualifying) und easyHrTrend bleiben auf unbereinigten Werten.
    const factor  = effortNormalizationFactor(r.distanceKm, r.elevationM, r.tempC)
    const ef      = (speedMs * factor * 60) / r.avgHr!
    return { date: r.date, ef }
  })

  // ── 3. Week-level aggregation (Monday anchor, median EF) ───────────────────
  const weekMap = new Map<string, number[]>()
  const weekDateMap = new Map<string, Date>()
  for (const { date, ef } of withEf) {
    const mon = mondayOf(date)
    const key = localISODate(mon)
    if (!weekMap.has(key)) { weekMap.set(key, []); weekDateMap.set(key, mon) }
    weekMap.get(key)!.push(ef)
  }

  const sortedKeys = Array.from(weekMap.keys()).sort()
  if (sortedKeys.length < 2) return null

  function medianOf(arr: number[]): number {
    const s = [...arr].sort((a, b) => a - b)
    const m = Math.floor(s.length / 2)
    return s.length % 2 !== 0 ? s[m] : (s[m - 1] + s[m]) / 2
  }

  // Weekly medians array (sorted chronologically)
  const weeklyMedians = sortedKeys.map(k => ({
    weekStart: weekDateMap.get(k)!,
    efMedian:  Math.round(medianOf(weekMap.get(k)!) * 10000) / 10000,
    runCount:  weekMap.get(k)!.length,
  }))

  // ── 4. 3-week rolling median (center) ─────────────────────────────────────
  const weekly: EfWeeklyPoint[] = weeklyMedians.map((w, i) => {
    const window = weeklyMedians.slice(Math.max(0, i - 1), i + 2).map(x => x.efMedian)
    return {
      ...w,
      efSmooth: Math.round(medianOf(window) * 10000) / 10000,
    }
  })

  // ── 5. Early / recent halves (midcut = 4 weeks ago) ───────────────────────
  const midcut = new Date(Date.now() - (weeks / 2) * 7 * 24 * 3600 * 1000)
  const earlyWeeks  = weekly.filter(w => w.weekStart < midcut)
  const recentWeeks = weekly.filter(w => w.weekStart >= midcut)

  if (earlyWeeks.length === 0 || recentWeeks.length === 0) return null

  const meanEf = (arr: EfWeeklyPoint[]) =>
    arr.reduce((s, w) => s + w.efMedian, 0) / arr.length

  const earlyEf  = Math.round(meanEf(earlyWeeks)  * 10000) / 10000
  const recentEf = Math.round(meanEf(recentWeeks) * 10000) / 10000
  if (earlyEf <= 0) return null

  const deltaEf  = Math.round((recentEf - earlyEf) * 10000) / 10000
  const deltaPct = Math.round((deltaEf / earlyEf) * 100 * 10) / 10

  let direction: '↑' | '↓' | '→'
  let label: string
  let color: string
  if (deltaPct >= 2.0) {
    direction = '↑'; label = `EF +${deltaPct.toFixed(1)}% — aerobe Effizienz steigt`; color = '#28a745'
  } else if (deltaPct <= -2.0) {
    direction = '↓'; label = `EF ${deltaPct.toFixed(1)}% — aerobe Effizienz sinkt`;   color = '#dc3545'
  } else {
    direction = '→'; label = 'EF stabil — aerobe Effizienz konstant';                  color = '#e6a817'
  }

  return { weekly, earlyEf, recentEf, deltaEf, deltaPct, direction, label, color, noHrData: false }
}

export interface SportWeekStats {
  km:          number
  durationSec: number
  count:       number
  elevationM:  number
}

export function thisWeekStatsBySport(activities: StravaActivity[]): Record<'run' | 'ride' | 'hike' | 'swim', SportWeekStats> {
  const now    = new Date()
  const monday = mondayOf(now)
  const week   = activities.filter(a => {
    const d = parseStravaLocal(a)
    return d >= monday && d <= now
  })
  const stats = (filter: (a: StravaActivity) => boolean): SportWeekStats => {
    const acts = week.filter(filter)
    return {
      km:          Math.round(acts.reduce((s, a) => s + (a.distance || 0) / 1000, 0) * 10) / 10,
      durationSec: acts.reduce((s, a) => s + (a.moving_time || 0), 0),
      count:       acts.length,
      elevationM:  Math.round(acts.reduce((s, a) => s + (a.total_elevation_gain || 0), 0)),
    }
  }
  return {
    run:  stats(isRunType),
    ride: stats(isRideType),
    hike: stats(isHikeType),
    swim: stats(a => a.type === 'Swim' || a.sport_type === 'Swim'),
  }
}

export interface SportWeeklyStats {
  weekStart: Date
  runKm:   number
  rideKm:  number
  hikeKm:  number
  runH:    number
  rideH:   number
  hikeH:   number
}

export function computeWeeklyStatsBySport(activities: StravaActivity[], weeksBack = 52): SportWeeklyStats[] {
  const now    = new Date()
  const cutoff = new Date(now.getTime() - weeksBack * 7 * 24 * 3600 * 1000)
  const map    = new Map<string, SportWeeklyStats>()

  for (const a of activities) {
    const d = parseStravaLocal(a)
    if (d < cutoff) continue
    const ws  = mondayOf(d)
    const key = localISODate(ws)
    if (!map.has(key)) map.set(key, { weekStart: ws, runKm: 0, rideKm: 0, hikeKm: 0, runH: 0, rideH: 0, hikeH: 0 })
    const s  = map.get(key)!
    const km = (a.distance || 0) / 1000
    const h  = (a.moving_time || 0) / 3600
    if (isRunType(a))  { s.runKm  += km; s.runH  += h }
    if (isRideType(a)) { s.rideKm += km; s.rideH += h }
    if (isHikeType(a)) { s.hikeKm += km; s.hikeH += h }
  }

  return Array.from(map.values())
    .map(s => ({
      ...s,
      runKm:  Math.round(s.runKm  * 10) / 10,
      rideKm: Math.round(s.rideKm * 10) / 10,
      hikeKm: Math.round(s.hikeKm * 10) / 10,
      runH:   Math.round(s.runH   * 100) / 100,
      rideH:  Math.round(s.rideH  * 100) / 100,
      hikeH:  Math.round(s.hikeH  * 100) / 100,
    }))
    .sort((a, b) => a.weekStart.getTime() - b.weekStart.getTime())
}

export interface AtlCtlResult {
  atl: number
  ctl: number
  tsb: number
}

// Factor maps mirroring coach.py _WORKOUT_TYPE_FACTOR and _SPORT_TYPE_FACTOR (T-122).
// Run codes: 0=default/easy, 1=race, 2=long, 3=workout/interval.
// Ride codes: 10=ride-race, 11=ride-workout, 12=ride-long.
const _WORKOUT_TYPE_FACTOR: Record<number, number> = {
  0:  1.0,
  1:  1.4,
  2:  0.9,
  3:  1.3,
  10: 1.4,
  11: 1.3,
  12: 0.9,
}

// T-125: Power-based Training Stress Score — faithful port of coach.py bike_tss.
// TSS = duration_sec * (NP/FTP)^2 / 3600 * 100
// ftp <= 0 → 0 (ZeroDivision guard, matches Python guard).
export function bikeTss(npWatts: number, durationSec: number, ftp: number): number {
  if (ftp <= 0) return 0
  const if_ = npWatts / ftp
  return (durationSec * if_ * if_ / 3600) * 100
}

// Conservative factor for sports without suffer_score (Swim, Hike, Walk).
// VirtualRide gets 1.0 — Desktop currently excludes VirtualRide from ride_df entirely,
// so including it here with factor 1.0 is a minor residual divergence (documented).
const _SPORT_TYPE_FACTOR: Record<string, number> = {
  Swim:        0.8,
  Hike:        0.8,
  Walk:        0.8,
  VirtualRide: 1.0,
  EBikeRide:   0.6,
}

// T-138: rTSS/hrTSS — formelgleich zu coach.py run_rtss/run_hrtss.
// 1 h @ threshold = 100; IF = threshold/avgPace (faster pace → higher IF).
const TSS_REF_SEC = 3600
const STRUCTURED_DIVERGENCE = 1.15  // hrTSS/rTSS ratio above which workout is treated as structured

export function runRtss(
  durationSec: number,
  avgPaceSec: number | null | undefined,
  thresholdPaceSec: number,
): number | null {
  const d = Number(durationSec)
  const p = Number(avgPaceSec)
  const tp = Number(thresholdPaceSec)
  if (!(d > 0) || !(p > 120 && p < 900) || !(tp > 0) || Number.isNaN(p) || Number.isNaN(tp)) return null
  const intf = tp / p
  return (d / TSS_REF_SEC) * intf * intf * 100
}

export function runHrtss(
  durationSec: number,
  avgHr: number | null | undefined,
  lthr: number,
  restHr: number,
): number | null {
  const d = Number(durationSec)
  const hr = Number(avgHr)
  const lt = Number(lthr)
  const rh = Number(restHr)
  if (!(d > 0) || !(hr > 0) || !(lt > rh) || Number.isNaN(hr) || Number.isNaN(lt)) return null
  const intf = (hr - rh) / (lt - rh)
  if (intf <= 0) return null
  return (d / TSS_REF_SEC) * intf * intf * 100
}

export interface SyncedThreshold {
  lthr: number
  threshold_pace_sec: number
  rest_hr: number
  is_fallback: boolean
  source: string
}

export function activityLoad(a: StravaActivity, ftp?: number, threshold?: SyncedThreshold): number {
  // Priority 1: Power-TSS for Rides with device-measured NP and known FTP.
  // Mirrors coach.py _daily_load priority: power path runs FIRST, before suffer_score.
  // weighted_average_watts is Strava's NP field; fallback to average_watts not used here
  // (coach.py also requires device_watts=True before accepting np_watts).
  const sportType = a.sport_type || a.type || ''
  if (
    ftp != null && ftp > 0 &&
    (sportType === 'Ride' || sportType === 'VirtualRide') &&
    a.device_watts === true &&
    a.weighted_average_watts != null && a.weighted_average_watts > 0
  ) {
    const durationSec = a.moving_time || 0
    if (durationSec > 0) {
      return bikeTss(a.weighted_average_watts, durationSec, ftp)
    }
  }

  // T-138: Smart Run-TSS (rTSS steady / hrTSS structured) — before suffer_score.
  if (threshold && (sportType === 'Run' || sportType === 'TrailRun' || sportType === 'VirtualRun')) {
    const durSec = a.moving_time || 0
    const paceSec = a.distance && a.distance > 0 ? durSec / (a.distance / 1000) : null
    const rtss = runRtss(durSec, paceSec, threshold.threshold_pace_sec)
    const hrtss = runHrtss(durSec, a.average_heartrate, threshold.lthr, threshold.rest_hr)
    const structured = a.workout_type === 3 ||
      (rtss != null && hrtss != null && hrtss >= rtss * STRUCTURED_DIVERGENCE)
    if (structured && hrtss != null) return Math.round(hrtss)
    if (rtss != null) return Math.round(rtss)
    if (hrtss != null) return Math.round(hrtss)
    // Both null → fall through to suffer_score/factor path
  }

  // Priority 2: suffer_score when present and > 0 (Strava HR-based load).
  if (a.suffer_score != null && a.suffer_score > 0) return a.suffer_score

  // Priority 3: duration × factor (no HR data / suffer_score absent / no power path).
  const durationMin = (a.moving_time || 0) / 60
  const wt = a.workout_type ?? 0

  // Auswahllogik identical to coach.py _daily_load:
  //   if wt not in _WORKOUT_TYPE_FACTOR AND sport_type in _SPORT_TYPE_FACTOR → sport factor
  //   elif wt === 0 AND sport_type in _SPORT_TYPE_FACTOR                      → sport factor
  //   else                                                                    → workout_type factor (default 1.0)
  let factor: number
  if (!(wt in _WORKOUT_TYPE_FACTOR) && sportType in _SPORT_TYPE_FACTOR) {
    factor = _SPORT_TYPE_FACTOR[sportType]
  } else if (wt === 0 && sportType in _SPORT_TYPE_FACTOR) {
    factor = _SPORT_TYPE_FACTOR[sportType]
  } else {
    factor = _WORKOUT_TYPE_FACTOR[wt] ?? 1.0
  }

  return Math.round(durationMin * factor)
}

// T-144: per-Kalendertag-Last oldest→today (gefüllt 0). Geteilt von computeAtlCtl + injuryRisk,
// spiegelt coach.py _daily_load + reindex-to-today.
export function dailyLoadSeries(
  activities: StravaActivity[], ftp?: number, threshold?: SyncedThreshold,
): number[] {
  if (!activities.length) return []
  const dayMap = new Map<string, number>()
  for (const a of activities) {
    const day = (a.start_date_local || a.start_date).slice(0, 10)
    dayMap.set(day, (dayMap.get(day) ?? 0) + activityLoad(a, ftp, threshold))
  }
  const dates = Array.from(dayMap.keys()).sort()
  const startDate = new Date(dates[0])
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const out: number[] = []
  for (let d = new Date(startDate); d <= today; d.setDate(d.getDate() + 1)) {
    out.push(dayMap.get(localISODate(d)) ?? 0)
  }
  return out
}

export function computeAtlCtl(activities: StravaActivity[], ftp?: number, threshold?: SyncedThreshold): AtlCtlResult {
  if (!activities.length) return { atl: 0, ctl: 0, tsb: 0 }

  // T-125: ftp propagated to activityLoad for power-TSS on Rides with device_watts.
  // T-138: threshold propagated for rTSS/hrTSS on Runs.
  // T-144: shared dailyLoadSeries — same series injuryRisk uses.
  const series = dailyLoadSeries(activities, ftp, threshold)

  const K_CTL = 1 / 42
  const K_ATL = 1 / 7

  let ctl = 0
  let atl = 0

  for (const load of series) {
    ctl = ctl * (1 - K_CTL) + load * K_CTL
    atl = atl * (1 - K_ATL) + load * K_ATL
  }

  return {
    atl: Math.round(atl * 10) / 10,
    ctl: Math.round(ctl * 10) / 10,
    tsb: Math.round((ctl - atl) * 10) / 10,
  }
}

// T-146: Steigt der 42d-CTL? Letzter EWMA-Wert > 28 Kalendertage zuvor. <29 Tage → null.
export function ctlRising(activities: StravaActivity[], ftp?: number, threshold?: SyncedThreshold): boolean | null {
  const series = dailyLoadSeries(activities, ftp, threshold)
  if (series.length < 29) return null
  const k = 1 / 42
  let ctl = 0
  const out: number[] = []
  for (const load of series) { ctl = ctl * (1 - k) + load * k; out.push(ctl) }
  return out[out.length - 1] > out[out.length - 29]
}

export function thisWeekKm(activities: StravaActivity[]): number {
  const now    = new Date()
  const monday = mondayOf(now)
  return activities
    .filter(a => {
      const d = parseStravaLocal(a)
      return isRunType(a) && d >= monday && d <= now
    })
    .reduce((sum, a) => sum + (a.distance || 0) / 1000, 0)
}

export function parseRuns(activities: StravaActivity[]): RunSummary[] {
  return activities
    .filter(isRunType)
    .map(a => {
      const distKm  = (a.distance || 0) / 1000
      const durSec  = a.moving_time || 0
      const paceSec = distKm > 0.1 ? durSec / distKm : 0
      const paceMin = Math.floor(paceSec / 60)
      const paceSc  = Math.round(paceSec % 60)
      return {
        id:          a.id,
        name:        a.name,
        date:        parseStravaLocal(a),
        distanceKm:  Math.round(distKm * 100) / 100,
        durationSec: durSec,
        paceSec,
        paceFmt:     paceSec > 0 ? `${paceMin}:${paceSc.toString().padStart(2, '0')}` : '—',
        avgHr:       a.average_heartrate,
        maxHr:       a.max_heartrate,
        elevationM:  Math.round(a.total_elevation_gain || 0),
        tempC:       a.average_temp,
      }
    })
    .sort((a, b) => b.date.getTime() - a.date.getTime())
}

// ── Activity Streams — persistent localStorage cache + 429-safe fetch ────────

export interface ActivityStreams {
  time:             number[]   // elapsed seconds
  velocity_smooth:  number[]   // m/s
  heartrate?:       number[]   // bpm
  altitude?:        number[]   // meters
  distance?:        number[]   // cumulative meters
}

// Cache key functions — exported so tests can pre-populate and verify cache behaviour.
// Streams and laps for a completed activity are immutable → no TTL needed.
export const STREAM_CACHE_KEY = (id: number): string => `_strava_stream_${id}`
export const LAPS_CACHE_KEY   = (id: number): string => `_strava_laps_${id}`

function _loadCachedStream(id: number): ActivityStreams | null {
  try {
    const raw = localStorage.getItem(STREAM_CACHE_KEY(id))
    if (!raw) return null
    const parsed = JSON.parse(raw)
    // Accept both the raw Strava response shape (key→{data:[]}) and the already-parsed shape.
    if (Array.isArray(parsed.time)) return parsed as ActivityStreams
    return {
      time:            parsed.time?.data            ?? [],
      velocity_smooth: parsed.velocity_smooth?.data ?? [],
      heartrate:       parsed.heartrate?.data,
      altitude:        parsed.altitude?.data,
      distance:        parsed.distance?.data,
    }
  } catch { return null }
}

function _cacheStream(id: number, streams: ActivityStreams): void {
  try { localStorage.setItem(STREAM_CACHE_KEY(id), JSON.stringify(streams)) } catch {}
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function _loadCachedLaps(id: number): any[] | null {
  try {
    const raw = localStorage.getItem(LAPS_CACHE_KEY(id))
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function _cacheLaps(id: number, laps: any[]): void {
  try { localStorage.setItem(LAPS_CACHE_KEY(id), JSON.stringify(laps)) } catch {}
}

// Sentinel value distinguishing 429 (rate-limited) from other errors.
// Callers must check `=== 'rate_limited'` to abort the bulk-fetch loop.
type FetchStreamResult = ActivityStreams | null | 'rate_limited'
type FetchLapsResult   = any[]           | null | 'rate_limited' // eslint-disable-line @typescript-eslint/no-explicit-any

export async function fetchActivityStreams(activityId: number): Promise<FetchStreamResult> {
  // Delegiert an den 429-bewussten Fetcher: reicht den 'rate_limited'-Sentinel durch, statt
  // 429 (wie früher) still als null zu maskieren (T-129). Entfernt zugleich das Duplikat der
  // Fetch/Parse/Cache-Logik — war eine Kopie von _fetchStreams429.
  const token = await getValidToken()
  if (!token) return null
  return _fetchStreams429(activityId, token)
}

// Strava lap raw data — variable structure, parsed in analyzeWorkoutLaps()
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function fetchActivityLaps(activityId: number): Promise<any[] | null> {
  const token = await getValidToken()
  if (!token) return null
  const cached = _loadCachedLaps(activityId)
  if (cached) return cached
  const res = await fetch(
    `${STRAVA_API_BASE}/activities/${activityId}/laps`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  if (!res.ok) return null
  const laps = await res.json()
  _cacheLaps(activityId, laps)
  return laps
}

// 429-aware internal fetchers — return 'rate_limited' sentinel on HTTP 429.
async function _fetchStreams429(id: number, token: string): Promise<FetchStreamResult> {
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

async function _fetchLaps429(id: number, token: string): Promise<FetchLapsResult> {
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

// ── Shape types for bulk-loader output ───────────────────────────────────────

export interface StrideDataEntry {
  strideCount:     number
  strides:         { peakPaceSec: number }[]
  avgPeakPaceSec?: number
}

export interface BulkAnalyticsResult {
  strideDataById: Record<string, StrideDataEntry>
  workSplits:     Record<string, number[]>
  partial:        boolean
  fetched:        number
  total:          number
}

/**
 * Bulk-loads streams (for stride detection) and laps (for VDOT adherence) for
 * the provided run sets. Fetches sequentially to avoid rate-limit storms.
 * On HTTP 429: stops immediately and returns a partial result with `partial:true`.
 * Cache-hits never trigger a fetch — the persistent localStorage cache means
 * each activity is only fetched once across sessions.
 *
 * @param allRuns        All runs (used for stream fetch + stride detection)
 * @param qualityRuns    Runs with workout_type==3 (used for lap fetch + work-splits)
 * @param vdot           Current VDOT (used by detectStrides + analyzeWorkoutLaps)
 */
export async function loadAnalyticsStreams(
  allRuns:      RunSummary[],
  qualityRuns:  RunSummary[],
  vdot:         number,
): Promise<BulkAnalyticsResult> {
  // analyzeWorkoutLaps is in vdot.ts (no circular dep: vdot.ts imports from strava.ts types only).
  const { analyzeWorkoutLaps } = await import('./vdot')
  // durability.ts is a separate module (no circular dep: imports types only from strava.ts).
  const { durabilityRecordForRun, upsertDurability } = await import('./durability')

  const strideDataById: Record<string, StrideDataEntry> = {}
  const workSplits:     Record<string, number[]>        = {}
  let partial  = false
  let fetched  = 0
  const total  = allRuns.length + qualityRuns.length

  const token = await getValidToken()
  if (!token) return { strideDataById, workSplits, partial: false, fetched: 0, total }

  // ── Phase 1: streams for all runs → stride detection ─────────────────────
  for (const run of allRuns) {
    const result = await _fetchStreams429(run.id, token)
    if (result === 'rate_limited') { partial = true; break }
    if (!result) continue
    fetched++

    // detectStrides is defined in this same file (strava.ts) — direct call, no import needed.
    const analysis = detectStrides(result, run.paceSec, vdot)
    if (analysis.strideCount > 0) {
      strideDataById[String(run.id)] = {
        strideCount:    analysis.strideCount,
        strides:        analysis.strides.map(s => ({ peakPaceSec: s.peakPaceSec })),
        avgPeakPaceSec: analysis.avgPeakPaceSec,
      }
    }

    // T-142: Durability-Cache aus denselben Streams befüllen (Longrun-Gate).
    if (run.durationSec >= 4500 || run.distanceKm >= 18) {
      const drec = durabilityRecordForRun(run, result)
      if (drec) upsertDurability(run.id, drec)
    }
  }

  // ── Phase 2: laps for quality sessions → work-splits ─────────────────────
  if (!partial) {
    for (const run of qualityRuns) {
      const laps = await _fetchLaps429(run.id, token)
      if (laps === 'rate_limited') { partial = true; break }
      if (!laps) continue
      fetched++

      const lapAnalysis = analyzeWorkoutLaps(laps, vdot)
      if (lapAnalysis) {
        // Extract pace of interval laps as work-splits (sec/km)
        const intervalSplits = lapAnalysis.laps
          .filter(l => l.role === 'interval' && l.paceSec > 0)
          .map(l => l.paceSec)
        if (intervalSplits.length > 0) {
          workSplits[String(run.id)] = intervalSplits
        }
      }
    }
  }

  // T-163: cap stream/laps caches after bulk fetch to prevent iOS quota exhaustion.
  // Streams are always re-fetchable; capping here keeps storage within ~5 MB iOS limit.
  capStreamLapsCaches()

  return { strideDataById, workSplits, partial, fetched, total }
}

// ── Workout Classification v5 ───────────────────────────────────────────────

/**
 * Derive stable easy-baseline speed (m/s) from VDOT anchor.
 * Returns null when anchor is implausible (stale VDOT or wrong profile).
 * Plausibility gate: activity median must lie within ±40 % of VDOT-easy speed.
 */
function _vdotAnchor(vdot: number | null | undefined, activityMedianMs: number): number | null {
  if (vdot == null || isNaN(vdot)) return null
  try {
    const p = trainingPaces(vdot)
    const eHighSec = p['E_high']
    if (!eHighSec || !isFinite(eHighSec) || eHighSec <= 0) return null
    const easySpeedMs = 1000 / eHighSec  // convert sec/km → m/s
    if (activityMedianMs > 0) {
      const ratio = activityMedianMs / easySpeedMs
      // Athlete's activity must sit in easy–tempo range (0.6× to 1.4× easy speed)
      if (ratio < 0.60 || ratio > 1.40) return null
    }
    return easySpeedMs
  } catch {
    return null
  }
}

export interface WorkoutStrideSegment {
  startSec:    number
  durationSec: number
  peakSpeedMs: number  // m/s
}

export interface IntervalBlock {
  startSec:   number
  durationSec: number
  avgPaceSec: number   // sec/km
  avgHr?:     number
}

export interface TempoBlock {
  startSec:     number
  durationSec:  number
  avgPaceSec:   number   // sec/km
  paceDeviation: number  // drift %, end vs start
}

export interface WorkoutClassification {
  workoutType:    'easy' | 'strides' | 'intervals' | 'tempo' | 'mixed'
  strides:        WorkoutStrideSegment[]
  intervalBlocks: IntervalBlock[]
  tempoBlocks:    TempoBlock[]
}

export function classifyWorkoutStructure(
  timeStream: number[],
  velocityStream: number[],
  heartrateStream?: number[],
  vdot?: number | null,
): WorkoutClassification {
  const empty: WorkoutClassification = { workoutType: 'easy', strides: [], intervalBlocks: [], tempoBlocks: [] }
  const n = velocityStream.length
  if (n < 10 || n !== timeStream.length) return empty

  // ── Step 1: ~25s rolling-window smoothing (time-based, matches streams.py) ──
  // Estimate sample rate from the time stream, then derive half-window in samples.
  const nForDt = Math.min(n - 1, 60)
  const rawDeltas: number[] = []
  for (let i = 0; i < nForDt; i++) {
    const d = timeStream[i + 1] - timeStream[i]
    if (d > 0) rawDeltas.push(d)
  }
  rawDeltas.sort((a, b) => a - b)
  const dtMedian = rawDeltas.length > 0 ? rawDeltas[Math.floor(rawDeltas.length / 2)] : 1.0
  // half-window ≈ 12 s on each side → total ~25 s
  const hw = Math.max(1, Math.round(12.0 / dtMedian))

  const smoothed: number[] = new Array(n)
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - hw)
    const hi = Math.min(n, i + hw + 1)
    let sum = 0; let cnt = 0
    for (let j = lo; j < hi; j++) { sum += velocityStream[j]; cnt++ }
    smoothed[i] = cnt > 0 ? sum / cnt : 0
  }

  // ── Step 2: Varianz-Gate — uniformly paced run needs no structure analysis ──
  const posS = smoothed.filter(s => s > 0)
  if (posS.length === 0) return empty
  const meanS = posS.reduce((a, b) => a + b, 0) / posS.length
  if (meanS <= 0) return empty
  const varS = posS.reduce((a, b) => a + (b - meanS) ** 2, 0) / posS.length
  const cv   = Math.sqrt(varS) / meanS
  if (cv < 0.05) return empty

  // ── Step 3: Easy-Baseline ────────────────────────────────────────────────────
  // Priority 1 (VDOT anchor): VDOT-derived E_high speed when plausible.
  // Priority 2 (self-reference): p30–p35 percentile of smoothed distribution
  // (avoids median being pulled up by work-dominant fast blocks — core v5 fix).
  const sortedPos = [...posS].sort((a, b) => a - b)
  const actMedianMs = sortedPos[Math.floor(sortedPos.length / 2)] ?? 0

  const anchoredBase = _vdotAnchor(vdot, actMedianMs)
  let baseSpeed: number
  if (anchoredBase !== null) {
    baseSpeed = anchoredBase
  } else {
    const p30idx = Math.max(0, Math.floor(sortedPos.length * 0.30) - 1)
    const p35idx = Math.max(0, Math.floor(sortedPos.length * 0.35) - 1)
    baseSpeed = (sortedPos[p30idx] + sortedPos[p35idx]) / 2
  }
  if (baseSpeed <= 0) return empty

  // Hysteresis: enter at +10%, exit at +5%
  const enterThr = baseSpeed * 1.10
  const exitThr  = baseSpeed * 1.05

  // ── Step 4: Hysteresis state machine to find elevated-pace blocks ───────────
  const rawBlocks: [number, number][] = []   // [startIdx, endIdx]
  let inBlock = false
  let blkStart = 0
  for (let i = 0; i < n; i++) {
    const s = smoothed[i]
    if (!inBlock) {
      if (s >= enterThr) { inBlock = true; blkStart = i }
    } else {
      if (s < exitThr) { inBlock = false; rawBlocks.push([blkStart, i - 1]) }
    }
  }
  if (inBlock) rawBlocks.push([blkStart, n - 1])
  if (rawBlocks.length === 0) return empty

  // ── Step 5: Gap-Merge (90s) + Merge-Guard (≥45s on one side) ───────────────
  const MERGE_GAP_S = 90
  const MERGE_MIN_S = 45

  const mergedBlocks: [number, number][] = [rawBlocks[0]]
  for (let k = 1; k < rawBlocks.length; k++) {
    const [s2, e2] = rawBlocks[k]
    const [s1, e1] = mergedBlocks[mergedBlocks.length - 1]
    const gapS    = timeStream[s2] - timeStream[e1]
    const durTail = timeStream[e1] - timeStream[s1]
    const durNext = timeStream[e2] - timeStream[s2]
    const blockWorthy = durTail >= MERGE_MIN_S || durNext >= MERGE_MIN_S
    if (gapS <= MERGE_GAP_S && blockWorthy) {
      mergedBlocks[mergedBlocks.length - 1] = [s1, e2]
    } else {
      mergedBlocks.push([s2, e2])
    }
  }

  // ── Step 6: Classify each merged block by duration ──────────────────────────
  const MIN_TEMPO_S    = 180   // ≥ 3 min → tempo
  const MIN_INTERVAL_S = 45   // ≥ 45 s  → interval
  const MIN_STRIDE_S   = 8    // ≥ 8 s   → stride candidate; shorter = GPS spike

  const hrUsable = (() => {
    if (!heartrateStream || heartrateStream.length !== n) return false
    const nValid = heartrateStream.filter(h => h > 0).length
    return nValid / n >= 0.40
  })()

  const strides:        WorkoutStrideSegment[] = []
  const intervalBlocks: IntervalBlock[]        = []
  const tempoBlocks:    TempoBlock[]           = []

  for (const [blkS, blkE] of mergedBlocks) {
    const segT  = timeStream[blkE] - timeStream[blkS]
    const segV  = smoothed.slice(blkS, blkE + 1)
    const avgMs = segV.length > 0 ? segV.reduce((a, b) => a + b, 0) / segV.length : 0
    const paceSec = avgMs > 0 ? Math.round(1000 / avgMs) : 0

    let avgHr: number | undefined
    if (hrUsable && heartrateStream) {
      const hrSeg = heartrateStream.slice(blkS, blkE + 1).filter(h => h > 0)
      if (hrSeg.length > 0) avgHr = Math.round(hrSeg.reduce((a, b) => a + b, 0) / hrSeg.length)
    }

    if (segT < MIN_STRIDE_S) continue  // GPS spike — skip

    if (segT < MIN_INTERVAL_S) {
      // Short peak → stride candidate
      const peakMs = Math.max(...segV)
      strides.push({
        startSec:    timeStream[blkS],
        durationSec: Math.round(segT),
        peakSpeedMs: Math.round(peakMs * 1000) / 1000,
      })
    } else if (segT < MIN_TEMPO_S) {
      // 45s–179s → interval block
      if (paceSec > 0) {
        intervalBlocks.push({ startSec: timeStream[blkS], durationSec: Math.round(segT), avgPaceSec: paceSec, avgHr })
      }
    } else {
      // ≥ 180s → tempo block (pace drift: intra-block, first vs second half)
      if (paceSec > 0) {
        const rawSeg = velocityStream.slice(blkS, blkE + 1)
        const half = Math.floor(rawSeg.length / 2)
        let paceDeviation = 0
        if (half > 0) {
          const firstHalf  = rawSeg.slice(0, half)
          const secondHalf = rawSeg.slice(half)
          const avgFirst  = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length
          const avgSecond = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length
          if (avgFirst > 0 && avgSecond > 0) {
            const pFirst  = 1000 / avgFirst
            const pSecond = 1000 / avgSecond
            paceDeviation = Math.round((pSecond - pFirst) / pFirst * 100 * 10) / 10
          }
        }
        tempoBlocks.push({ startSec: timeStream[blkS], durationSec: Math.round(segT), avgPaceSec: paceSec, paceDeviation })
      }
    }
  }

  // ── Determine workoutType from what was found ────────────────────────────────
  const hasStrides   = strides.length > 0
  const hasIntervals = intervalBlocks.length > 0
  const hasTempo     = tempoBlocks.length > 0
  const typeCount    = [hasStrides, hasIntervals, hasTempo].filter(Boolean).length

  let workoutType: WorkoutClassification['workoutType']
  if (typeCount === 0)       workoutType = 'easy'
  else if (typeCount > 1)    workoutType = 'mixed'
  else if (hasStrides)       workoutType = 'strides'
  else if (hasIntervals)     workoutType = 'intervals'
  else                       workoutType = 'tempo'

  return { workoutType, strides, intervalBlocks, tempoBlocks }
}

// ── Stride detection from velocity stream ────────────────────────────────────

export interface StrideSegment {
  startSec:   number
  endSec:     number
  durationSec: number
  distanceM:  number
  peakPaceSec: number   // fastest point, sec/km
  avgPaceSec:  number   // average over segment
  peakHr?:    number
}

export interface StrideAnalysis {
  strides:           StrideSegment[]
  strideCount:       number
  avgPeakPaceSec:    number
  fastestPaceSec:    number
  thresholdMs:       number
  avgRecoverySec:    number | null   // avg recovery gap between strides
}

export function detectStrides(
  streams: ActivityStreams,
  avgPaceSec: number,
  vdot?: number | null,
): StrideAnalysis {
  const { time, velocity_smooth, heartrate } = streams
  const n = velocity_smooth.length
  if (n < 10) {
    return { strides: [], strideCount: 0, avgPeakPaceSec: 0, fastestPaceSec: 0, thresholdMs: 0, avgRecoverySec: null }
  }

  const avgSpeedMs = avgPaceSec > 0 ? 1000 / avgPaceSec : 0

  // Compute activity median for VDOT plausibility gate
  const posVel = velocity_smooth.filter(v => v > 0)
  const sortedVel = [...posVel].sort((a, b) => a - b)
  const actMedianMs = sortedVel.length > 0 ? sortedVel[Math.floor(sortedVel.length / 2)] : avgSpeedMs

  // VDOT anchor: use VDOT-derived E_high as reference when plausible.
  // This makes thresholds athlete-specific (absolute) instead of relative to
  // session average, which is elevated in work-dominant runs.
  const anchoredEasyMs = _vdotAnchor(vdot, actMedianMs)
  const refSpeedMs     = anchoredEasyMs ?? avgSpeedMs

  // Raised thresholds (v3): 1.25× ref for peak (was 1.15), 1.12× for trace boundary (was 1.08).
  // At typical Easy 5:30/km, 1.25× ≈ 4:24/km — clearly sprint territory, not GPS drift.
  const peakThreshold = refSpeedMs * 1.25
  const baselineMs    = refSpeedMs * 1.12

  const DWELL_MIN_S    = 3.0   // smoothed speed must stay ≥ peakThreshold for ≥3s contiguously
  const MIN_STRIDE_DUR = 10    // seconds (raised from 8)

  // 5-point moving average to reduce GPS noise
  const smoothed: number[] = new Array(n)
  for (let i = 0; i < n; i++) {
    const slice = velocity_smooth.slice(Math.max(0, i - 2), Math.min(n, i + 3))
    smoothed[i] = slice.reduce((s, x) => s + x, 0) / slice.length
  }

  // Step 1: Find strict local peaks ≥ peakThreshold (5-point local max)
  let peakIdxs: number[] = []
  for (let i = 2; i < n - 2; i++) {
    if (
      smoothed[i] >= peakThreshold &&
      smoothed[i] >= smoothed[i - 1] && smoothed[i] >= smoothed[i - 2] &&
      smoothed[i] >= smoothed[i + 1] && smoothed[i] >= smoothed[i + 2]
    ) {
      peakIdxs.push(i)
    }
  }

  // Step 1b: Dwell-Gate — smoothed speed must stay ≥ peakThreshold for ≥ DWELL_MIN_S seconds
  // contiguously around the peak. Eliminates single-sample GPS spikes.
  peakIdxs = peakIdxs.filter(peakI => {
    let lo = peakI; let hi = peakI
    while (lo > 0     && smoothed[lo - 1] >= peakThreshold) lo--
    while (hi < n - 1 && smoothed[hi + 1] >= peakThreshold) hi++
    const dwellS = hi > lo ? time[hi] - time[lo] : 0
    return dwellS >= DWELL_MIN_S
  })

  // Step 2: For each peak, trace back/forward to baseline crossing
  const strides: StrideSegment[] = []

  for (const peakIdx of peakIdxs) {
    // Enforce ≥15s recovery gap from previous stride
    if (strides.length > 0) {
      const recoverySec = time[peakIdx] - strides[strides.length - 1].endSec
      if (recoverySec < 15) continue
    }

    // Trace back to baseline
    let startIdx = peakIdx
    while (startIdx > 0 && smoothed[startIdx - 1] > baselineMs) startIdx--
    // Trace forward to baseline
    let endIdx = peakIdx
    while (endIdx < n - 1 && smoothed[endIdx + 1] > baselineMs) endIdx++

    const tStart = time[startIdx]
    const tEnd   = time[endIdx]
    const dur    = tEnd - tStart

    if (dur < MIN_STRIDE_DUR || dur > 60) continue

    const seg    = smoothed.slice(startIdx, endIdx + 1)
    const peakMs = Math.max(...seg)
    const avgMs  = seg.reduce((s, v) => s + v, 0) / seg.length
    const distM  = Math.round(avgMs * dur)
    if (distM < 30 || distM > 250) continue

    const hrSeg  = heartrate?.slice(startIdx, endIdx + 1)
    const peakHr = hrSeg && hrSeg.length > 0 ? Math.max(...hrSeg) : undefined

    strides.push({
      startSec:    tStart,
      endSec:      tEnd,
      durationSec: Math.round(dur),
      distanceM:   distM,
      peakPaceSec: peakMs > 0 ? Math.round(1000 / peakMs) : 0,
      avgPaceSec:  avgMs  > 0 ? Math.round(1000 / avgMs)  : 0,
      peakHr,
    })
  }

  // Recovery gap stats
  const recoveryGaps = strides.slice(1).map((s, i) => s.startSec - strides[i].endSec)
  const avgRecoverySec = recoveryGaps.length > 0
    ? Math.round(recoveryGaps.reduce((a, b) => a + b, 0) / recoveryGaps.length) : null

  const avgPeakPaceSec = strides.length > 0
    ? Math.round(strides.reduce((s, st) => s + st.peakPaceSec, 0) / strides.length) : 0
  const fastestPaceSec = strides.length > 0
    ? Math.min(...strides.map(st => st.peakPaceSec)) : 0

  return { strides, strideCount: strides.length, avgPeakPaceSec, fastestPaceSec, thresholdMs: peakThreshold, avgRecoverySec }
}
