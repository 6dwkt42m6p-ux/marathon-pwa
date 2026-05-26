// Strava OAuth2 + activity sync

const CLIENT_ID     = import.meta.env.VITE_STRAVA_CLIENT_ID || ''
const CLIENT_SECRET = import.meta.env.VITE_STRAVA_CLIENT_SECRET || ''
const REDIRECT_URI  = import.meta.env.VITE_STRAVA_REDIRECT_URI || window.location.origin + '/'
const TOKEN_KEY     = 'strava_tokens'
const ACTS_KEY      = 'strava_activities'

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

export function isAuthenticated(): boolean {
  return loadTokens() !== null
}

async function refreshTokens(refreshToken: string): Promise<StravaTokens> {
  const r = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type:    'refresh_token',
    }),
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
  const r = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id:     CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      grant_type:    'authorization_code',
      redirect_uri:  REDIRECT_URI,
    }),
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

function saveCachedActivities(acts: StravaActivity[]): void {
  try { localStorage.setItem(ACTS_KEY, JSON.stringify(acts)) }
  catch (e) {
    // LocalStorage might be full — trim older entries and retry
    const trimmed = acts.slice(-300)
    try { localStorage.setItem(ACTS_KEY, JSON.stringify(trimmed)) } catch {}
  }
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
      `https://www.strava.com/api/v3/athlete/activities?after=${afterTs}&page=${page}&per_page=100`,
      { headers: { Authorization: `Bearer ${token}` } }
    )
    if (!r.ok) throw new Error(`Strava API error: ${r.status}`)
    const batch: StravaActivity[] = await r.json()
    if (!batch.length) break
    all.push(...batch)
    if (batch.length < 100) break
    page++
  }
  return all
}

export async function syncActivities(weeksBack = 52): Promise<StravaActivity[]> {
  const token = await getValidToken()
  if (!token) throw new Error('Not authenticated')

  const cutoffTs = Math.floor((Date.now() - weeksBack * 7 * 24 * 3600 * 1000) / 1000)
  const cached   = loadCachedActivities()

  let newActs: StravaActivity[]
  if (cached.length) {
    const latestTs = Math.max(...cached.map(activityTs), cutoffTs)
    newActs = await fetchActivitiesAfter(token, latestTs)
  } else {
    newActs = await fetchActivitiesAfter(token, cutoffTs)
  }

  const idMap = new Map(cached.map(a => [a.id, a]))
  for (const a of newActs) idMap.set(a.id, a)
  const merged = Array.from(idMap.values()).filter(a => activityTs(a) >= cutoffTs)
  saveCachedActivities(merged)
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
}

export interface ActivitySummary extends RunSummary {
  actType:      'run' | 'ride' | 'hike'
  isTrail:      boolean
  workoutType?: number
  speedKmh?:    number
}

export function parseAllActivities(activities: StravaActivity[]): ActivitySummary[] {
  const isRun   = (a: StravaActivity) => a.type === 'Run'  || a.sport_type === 'Run' ||
                                          a.type === 'TrailRun' || a.sport_type === 'TrailRun'
  const isRide  = (a: StravaActivity) => a.type === 'Ride' || a.sport_type === 'Ride' ||
                                          a.type === 'VirtualRide' || a.sport_type === 'VirtualRide'
  const isHike  = (a: StravaActivity) => a.type === 'Hike' || a.sport_type === 'Hike' ||
                                          a.type === 'Walk' || a.sport_type === 'Walk'

  return activities
    .filter(a => isRun(a) || isRide(a) || isHike(a))
    .map(a => {
      const distKm  = (a.distance || 0) / 1000
      const durSec  = a.moving_time || 0
      const paceSec = distKm > 0.1 ? durSec / distKm : 0
      const paceMin = Math.floor(paceSec / 60)
      const paceSc  = Math.round(paceSec % 60)
      const speedKmh = durSec > 0 ? (distKm / durSec) * 3600 : 0
      const actType: 'run' | 'ride' | 'hike' = isRun(a) ? 'run' : isRide(a) ? 'ride' : 'hike'
      const isTrail = a.type === 'TrailRun' || a.sport_type === 'TrailRun'
      return {
        id:          a.id,
        name:        a.name,
        date:        new Date(a.start_date_local || a.start_date),
        distanceKm:  Math.round(distKm * 100) / 100,
        durationSec: durSec,
        paceSec,
        paceFmt:     paceSec > 0 ? `${paceMin}:${paceSc.toString().padStart(2, '0')}` : '—',
        avgHr:       a.average_heartrate,
        maxHr:       a.max_heartrate,
        elevationM:  Math.round(a.total_elevation_gain || 0),
        actType,
        isTrail,
        workoutType: a.workout_type,
        speedKmh:    Math.round(speedKmh * 10) / 10,
      } satisfies ActivitySummary
    })
    .sort((a, b) => b.date.getTime() - a.date.getTime())
}

export interface WeekStats {
  weekStart:  Date
  actualKm:   number
  runs:       number
  avgHr:      number | null
  elevationM: number
}

function mondayOf(d: Date): Date {
  const day  = d.getDay()
  const diff = day === 0 ? -6 : 1 - day
  const r    = new Date(d)
  r.setDate(r.getDate() + diff)
  r.setHours(0, 0, 0, 0)
  return r
}

export function computeWeeklyStats(runs: RunSummary[]): WeekStats[] {
  const map = new Map<string, WeekStats>()

  for (const r of runs) {
    const ws  = mondayOf(r.date)
    const key = ws.toISOString().slice(0, 10)
    if (!map.has(key)) {
      map.set(key, { weekStart: ws, actualKm: 0, runs: 0, avgHr: null, elevationM: 0 })
    }
    const s = map.get(key)!
    s.actualKm   += r.distanceKm
    s.runs        += 1
    s.elevationM  += r.elevationM
    if (r.avgHr) {
      s.avgHr = s.avgHr === null ? r.avgHr : (s.avgHr + r.avgHr) / 2
    }
  }

  return Array.from(map.values())
    .map(s => ({ ...s, actualKm: Math.round(s.actualKm * 10) / 10 }))
    .sort((a, b) => a.weekStart.getTime() - b.weekStart.getTime())
}

export interface VdotTrend {
  delta:       number
  early:       number
  recent:      number
  direction:   '↑' | '↓' | '→'
  label:       string
  color:       string
  fromTraining: boolean
}

import { vdotFromRace as _vdotFromRace } from './vdot'

export function vdotTrendFromActivities(runs: RunSummary[], currentVdot: number): VdotTrend | null {
  const MIN_VDOT_PCT = 0.82
  const eligible = runs
    .filter(r => r.distanceKm >= 3 && r.paceSec >= 180 && r.paceSec <= 420 && r.durationSec > 0)

  if (eligible.length < 4) return null

  const now       = new Date()
  const eightWeeksAgo = new Date(now.getTime() - 8 * 7 * 24 * 3600 * 1000)
  const fourWeeksAgo  = new Date(now.getTime() - 4 * 7 * 24 * 3600 * 1000)

  const withVdot = eligible.map(r => {
    try {
      const v = _vdotFromRace(r.distanceKm * 1000, r.durationSec)
      return { ...r, computedVdot: (v > 20 && v < 85) ? v : null }
    } catch { return { ...r, computedVdot: null } }
  }).filter(r => r.computedVdot !== null) as (RunSummary & { computedVdot: number })[]

  const earlyRuns  = withVdot.filter(r => r.date >= eightWeeksAgo && r.date <  fourWeeksAgo)
  const recentRuns = withVdot.filter(r => r.date >= fourWeeksAgo)

  if (recentRuns.length === 0) return null

  const threshold = currentVdot * MIN_VDOT_PCT

  function bestVdot(list: typeof withVdot): number {
    const hard = list.filter(r => r.computedVdot >= threshold)
    const src  = hard.length >= 2 ? hard : list.slice().sort((a, b) => b.computedVdot - a.computedVdot).slice(0, 3)
    const vals = src.map(r => r.computedVdot)
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0
  }

  const recent = Math.round(bestVdot(recentRuns) * 10) / 10
  const early  = earlyRuns.length >= 2 ? Math.round(bestVdot(earlyRuns) * 10) / 10 : recent
  const delta  = Math.round((recent - early) * 10) / 10
  const fromTraining = earlyRuns.filter(r => r.computedVdot >= threshold).length < 2 ||
                       recentRuns.filter(r => r.computedVdot >= threshold).length < 2

  let direction: '↑' | '↓' | '→'
  let label:     string
  let color:     string

  if (delta >= 0.3)       { direction = '↑'; label = `+${delta} VDOT Trend`;      color = '#4CAF50' }
  else if (delta <= -0.3) { direction = '↓'; label = `${delta} VDOT Trend`;       color = '#e53935' }
  else                    { direction = '→'; label = 'Stabiler VDOT-Trend';        color = '#FFC107' }

  return { delta, early, recent, direction, label, color, fromTraining }
}

export function thisWeekKm(activities: StravaActivity[]): number {
  const now    = new Date()
  const monday = mondayOf(now)
  return activities
    .filter(a => {
      const isRun = a.type === 'Run' || a.sport_type === 'Run' ||
                    a.type === 'TrailRun' || a.sport_type === 'TrailRun'
      const d = new Date(a.start_date_local || a.start_date)
      return isRun && d >= monday && d <= now
    })
    .reduce((sum, a) => sum + (a.distance || 0) / 1000, 0)
}

export function parseRuns(activities: StravaActivity[]): RunSummary[] {
  return activities
    .filter(a => a.type === 'Run' || a.sport_type === 'Run' ||
                 a.type === 'TrailRun' || a.sport_type === 'TrailRun')
    .map(a => {
      const distKm  = (a.distance || 0) / 1000
      const durSec  = a.moving_time || 0
      const paceSec = distKm > 0.1 ? durSec / distKm : 0
      const paceMin = Math.floor(paceSec / 60)
      const paceSc  = Math.round(paceSec % 60)
      return {
        id:          a.id,
        name:        a.name,
        date:        new Date(a.start_date_local || a.start_date),
        distanceKm:  Math.round(distKm * 100) / 100,
        durationSec: durSec,
        paceSec,
        paceFmt:     paceSec > 0 ? `${paceMin}:${paceSc.toString().padStart(2, '0')}` : '—',
        avgHr:       a.average_heartrate,
        maxHr:       a.max_heartrate,
        elevationM:  Math.round(a.total_elevation_gain || 0),
      }
    })
    .sort((a, b) => b.date.getTime() - a.date.getTime())
}

// ── Activity Streams (on-demand, not cached) ─────────────────────────────────

export interface ActivityStreams {
  time:             number[]   // elapsed seconds
  velocity_smooth:  number[]   // m/s
  heartrate?:       number[]   // bpm
  altitude?:        number[]   // meters
  distance?:        number[]   // cumulative meters
}

export async function fetchActivityStreams(activityId: number): Promise<ActivityStreams | null> {
  const token = await getValidToken()
  if (!token) return null
  const keys = 'time,velocity_smooth,heartrate,altitude,distance'
  const res = await fetch(
    `https://www.strava.com/api/v3/activities/${activityId}/streams?keys=${keys}&key_by_type=true`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  if (!res.ok) return null
  const raw = await res.json()
  return {
    time:            raw.time?.data            ?? [],
    velocity_smooth: raw.velocity_smooth?.data ?? [],
    heartrate:       raw.heartrate?.data,
    altitude:        raw.altitude?.data,
    distance:        raw.distance?.data,
  }
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
  strides:        StrideSegment[]
  strideCount:    number
  avgPeakPaceSec: number   // average of peak paces across strides
  fastestPaceSec: number
  thresholdMs:    number   // speed threshold used (m/s)
}

function fmtPace(secPerKm: number): string {
  const m = Math.floor(secPerKm / 60)
  const s = Math.round(secPerKm % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

export { fmtPace as formatPaceFromSec }

export function detectStrides(
  streams: ActivityStreams,
  avgPaceSec: number,   // overall average pace sec/km
): StrideAnalysis {
  const { time, velocity_smooth, heartrate } = streams
  if (velocity_smooth.length < 10) {
    return { strides: [], strideCount: 0, avgPeakPaceSec: 0, fastestPaceSec: 0, thresholdMs: 0 }
  }

  // Threshold: 20% faster than average pace = significantly above base pace
  const avgSpeedMs   = 1000 / avgPaceSec           // m/s from avg pace
  const thresholdMs  = avgSpeedMs * 1.20            // 20% faster triggers stride detection

  // Smooth velocity slightly (3-point moving average) to reduce GPS noise
  const smoothed = velocity_smooth.map((v, i) => {
    if (i === 0 || i === velocity_smooth.length - 1) return v
    return (velocity_smooth[i - 1] + v + velocity_smooth[i + 1]) / 3
  })

  // Find "fast" windows
  type Window = { start: number; end: number }
  const fastWindows: Window[] = []
  let inFast = false
  let wStart = 0

  for (let i = 0; i < smoothed.length; i++) {
    if (smoothed[i] >= thresholdMs) {
      if (!inFast) { inFast = true; wStart = i }
    } else {
      if (inFast) { fastWindows.push({ start: wStart, end: i - 1 }); inFast = false }
    }
  }
  if (inFast) fastWindows.push({ start: wStart, end: smoothed.length - 1 })

  // Merge windows within 8 seconds of each other
  const merged: Window[] = []
  for (const w of fastWindows) {
    const tStart = time[w.start]
    if (merged.length > 0) {
      const prev = merged[merged.length - 1]
      if (tStart - time[prev.end] <= 8) { prev.end = w.end; continue }
    }
    merged.push({ ...w })
  }

  // Filter: stride duration 8–50 seconds (100m at ~3:30–5:30 pace)
  const strides: StrideSegment[] = []
  for (const w of merged) {
    const tStart = time[w.start], tEnd = time[w.end]
    const dur = tEnd - tStart
    if (dur < 8 || dur > 55) continue

    const seg = smoothed.slice(w.start, w.end + 1)
    const peakMs = Math.max(...seg)
    const avgMs  = seg.reduce((s, v) => s + v, 0) / seg.length
    const distM  = avgMs * dur

    const hrSeg  = heartrate?.slice(w.start, w.end + 1)
    const peakHr = hrSeg ? Math.max(...hrSeg) : undefined

    strides.push({
      startSec:    tStart,
      endSec:      tEnd,
      durationSec: dur,
      distanceM:   Math.round(distM),
      peakPaceSec: peakMs > 0 ? Math.round(1000 / peakMs) : 0,
      avgPaceSec:  avgMs  > 0 ? Math.round(1000 / avgMs)  : 0,
      peakHr,
    })
  }

  const avgPeakPaceSec = strides.length > 0
    ? Math.round(strides.reduce((s, st) => s + st.peakPaceSec, 0) / strides.length) : 0
  const fastestPaceSec = strides.length > 0
    ? Math.min(...strides.map(st => st.peakPaceSec)) : 0

  return { strides, strideCount: strides.length, avgPeakPaceSec, fastestPaceSec, thresholdMs }
}
