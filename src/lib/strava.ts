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
  workoutType?: number
  speedKmh?:    number
}

export function parseAllActivities(activities: StravaActivity[]): ActivitySummary[] {
  const isRun   = (a: StravaActivity) => a.type === 'Run'  || a.sport_type === 'Run'
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
      const isRun = a.type === 'Run' || a.sport_type === 'Run'
      const d = new Date(a.start_date_local || a.start_date)
      return isRun && d >= monday && d <= now
    })
    .reduce((sum, a) => sum + (a.distance || 0) / 1000, 0)
}

export function parseRuns(activities: StravaActivity[]): RunSummary[] {
  return activities
    .filter(a => a.type === 'Run' || a.sport_type === 'Run')
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
