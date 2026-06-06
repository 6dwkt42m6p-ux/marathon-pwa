// Strava OAuth2 + activity sync

const CLIENT_ID     = import.meta.env.VITE_STRAVA_CLIENT_ID || ''
const CLIENT_SECRET = import.meta.env.VITE_STRAVA_CLIENT_SECRET || ''
// Use env var if set explicitly, otherwise derive from current origin + Vite BASE_URL
// This works for both localhost dev and GitHub Pages (/marathon-pwa/) without any secrets config
export const REDIRECT_URI  = import.meta.env.VITE_STRAVA_REDIRECT_URI ||
  (window.location.origin + import.meta.env.BASE_URL)
const TOKEN_KEY          = 'strava_tokens'
const ACTS_KEY           = 'strava_activities'
export const STRAVA_LAST_SYNC_KEY = 'strava_last_sync'

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
    const trimmed = acts.slice(-500)
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
      `https://www.strava.com/api/v3/athlete/activities?after=${afterTs}&page=${page}&per_page=200`,
      { headers: { Authorization: `Bearer ${token}` } }
    )
    if (!r.ok) throw new Error(`Strava API error: ${r.status}`)
    const batch: StravaActivity[] = await r.json()
    if (!batch.length) break
    all.push(...batch)
    if (batch.length < 200) break
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
        date:        new Date(a.start_date_local || a.start_date),
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

export function computeWeeklyStats(runs: RunSummary[]): WeekStats[] {
  const map     = new Map<string, WeekStats>()
  const paceMap = new Map<string, number[]>()

  for (const r of runs) {
    const ws  = mondayOf(r.date)
    const key = ws.toISOString().slice(0, 10)
    if (!map.has(key)) {
      map.set(key, { weekStart: ws, actualKm: 0, runs: 0, avgHr: null, elevationM: 0, avgPaceSec: null })
      paceMap.set(key, [])
    }
    const s = map.get(key)!
    s.actualKm   += r.distanceKm
    s.runs        += 1
    s.elevationM  += r.elevationM
    if (r.avgHr) {
      s.avgHr = s.avgHr === null ? r.avgHr : (s.avgHr + r.avgHr) / 2
    }
    if (r.paceSec > 0 && r.distanceKm >= 2) paceMap.get(key)!.push(r.paceSec)
  }

  return Array.from(map.values())
    .map(s => {
      const paces = paceMap.get(s.weekStart.toISOString().slice(0, 10)) ?? []
      const avgPaceSec = paces.length > 0
        ? Math.round(paces.reduce((a, b) => a + b, 0) / paces.length)
        : null
      return { ...s, actualKm: Math.round(s.actualKm * 10) / 10, avgPaceSec }
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

import { vdotFromRace as _vdotFromRace, trainingPaces } from './vdot'

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
    (r.avgHr - restHr) / hrr * 100 < 70  // Z1–Z2
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
      const v = _vdotFromRace(r.distanceKm * 1000, r.durationSec)
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

  const MIN_VDOT_PCT = 0.82
  const threshold = currentVdot * MIN_VDOT_PCT

  function bestVdot(list: typeof withVdot): number {
    const hard = list.filter(r => r.computedVdot >= threshold)
    const src  = hard.length >= 2 ? hard : list.slice().sort((a, b) => b.computedVdot - a.computedVdot).slice(0, 3)
    const vals = src.map(r => r.computedVdot)
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0
  }

  const recent = Math.round(bestVdot(recentEffort) * 10) / 10
  const early  = earlyEffort.length >= 1 ? Math.round(bestVdot(earlyEffort) * 10) / 10 : recent
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
    const d = new Date(a.start_date_local || a.start_date)
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
    const d = new Date(a.start_date_local || a.start_date)
    if (d < cutoff) continue
    const ws  = mondayOf(d)
    const key = ws.toISOString().slice(0, 10)
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

function activityLoad(a: StravaActivity): number {
  if (a.suffer_score != null && a.suffer_score > 0) return a.suffer_score
  const durationMin = (a.moving_time || 0) / 60
  // workout_type: 0/1 = easy/default, 2 = run, 3 = long, 10 = race, 11 = interval, 12 = tempo
  let intensityFactor = 1.0
  const wt = a.workout_type ?? 0
  if (wt === 11) intensityFactor = 2.0        // interval
  else if (wt === 12 || wt === 10) intensityFactor = 1.5  // tempo / race
  return Math.round(durationMin * intensityFactor)
}

export function computeAtlCtl(activities: StravaActivity[]): AtlCtlResult {
  if (!activities.length) return { atl: 0, ctl: 0, tsb: 0 }

  // Build a map of load per calendar day (ISO date string → total load)
  const dayMap = new Map<string, number>()
  for (const a of activities) {
    const day = (a.start_date_local || a.start_date).slice(0, 10)
    dayMap.set(day, (dayMap.get(day) ?? 0) + activityLoad(a))
  }

  // Determine date range: oldest activity → today
  const dates = Array.from(dayMap.keys()).sort()
  const startDate = new Date(dates[0])
  const today     = new Date()
  today.setHours(0, 0, 0, 0)

  const K_CTL = 1 / 42
  const K_ATL = 1 / 7

  let ctl = 0
  let atl = 0

  for (let d = new Date(startDate); d <= today; d.setDate(d.getDate() + 1)) {
    const key  = d.toISOString().slice(0, 10)
    const load = dayMap.get(key) ?? 0
    ctl = ctl * (1 - K_CTL) + load * K_CTL
    atl = atl * (1 - K_ATL) + load * K_ATL
  }

  return {
    atl: Math.round(atl * 10) / 10,
    ctl: Math.round(ctl * 10) / 10,
    tsb: Math.round((ctl - atl) * 10) / 10,
  }
}

export function thisWeekKm(activities: StravaActivity[]): number {
  const now    = new Date()
  const monday = mondayOf(now)
  return activities
    .filter(a => {
      const d = new Date(a.start_date_local || a.start_date)
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
        date:        new Date(a.start_date_local || a.start_date),
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

// Strava lap raw data — variable structure, parsed in analyzeWorkoutLaps()
export async function fetchActivityLaps(activityId: number): Promise<any[] | null> {
  const token = await getValidToken()
  if (!token) return null
  const res = await fetch(
    `https://www.strava.com/api/v3/activities/${activityId}/laps`,
    { headers: { Authorization: `Bearer ${token}` } }
  )
  if (!res.ok) return null
  return res.json()
}

// ── Workout Classification v3 ────────────────────────────────────────────────

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

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid]
}

export function classifyWorkoutStructure(
  timeStream: number[],
  velocityStream: number[],
  heartrateStream?: number[],
): WorkoutClassification {
  const empty: WorkoutClassification = { workoutType: 'easy', strides: [], intervalBlocks: [], tempoBlocks: [] }
  if (velocityStream.length < 20) return empty

  // ── 5-point moving average smoothing ────────────────────────────────────────
  const smoothed = velocityStream.map((_v, i) => {
    const slice = velocityStream.slice(Math.max(0, i - 2), Math.min(velocityStream.length, i + 3))
    return slice.reduce((s, x) => s + x, 0) / slice.length
  })

  // ── Step 1: Varianz-Gate — CV of smoothed velocity ──────────────────────────
  const meanSpeed = smoothed.reduce((s, v) => s + v, 0) / smoothed.length
  if (meanSpeed <= 0) return empty
  const variance = smoothed.reduce((s, v) => s + (v - meanSpeed) ** 2, 0) / smoothed.length
  const cv = Math.sqrt(variance) / meanSpeed
  if (cv < 0.05) return empty

  // ── Baseline: median of smoothed speeds (captures the easy/base pace) ───────
  const baseSpeed = median(smoothed)
  if (baseSpeed <= 0) return empty

  // Peak threshold: +20% above median base
  const peakThreshold = baseSpeed * 1.20
  // Recovery check threshold: 108% of base
  const recoveryThreshold = baseSpeed * 1.08

  // ── Step 2: Find peaks — must stay ≥3s above threshold ──────────────────────
  // Mark all indices above threshold, then group into contiguous blocks
  const aboveThreshold = smoothed.map(v => v >= peakThreshold)

  interface PeakBlock { startIdx: number; endIdx: number; peakIdx: number; peakSpeed: number }
  const peakBlocks: PeakBlock[] = []

  let i = 0
  while (i < aboveThreshold.length) {
    if (!aboveThreshold[i]) { i++; continue }
    const blockStart = i
    while (i < aboveThreshold.length && aboveThreshold[i]) i++
    const blockEnd = i - 1

    const tStart = timeStream[blockStart]
    const tEnd   = timeStream[blockEnd]
    const dur    = tEnd - tStart

    // Must be ≥3s (prevents GPS spikes)
    if (dur < 3) continue

    let peakIdx = blockStart
    for (let j = blockStart + 1; j <= blockEnd; j++) {
      if (smoothed[j] > smoothed[peakIdx]) peakIdx = j
    }

    peakBlocks.push({ startIdx: blockStart, endIdx: blockEnd, peakIdx, peakSpeed: smoothed[peakIdx] })
  }

  if (peakBlocks.length === 0) return empty

  // ── Step 3 & 4: Classify each peak block, check recovery ────────────────────
  const strides:        WorkoutStrideSegment[] = []
  const intervalBlocks: IntervalBlock[]        = []
  const tempoBlocks:    TempoBlock[]           = []

  // Expand each peak block outward to the baseline crossing (recoveryThreshold)
  for (const block of peakBlocks) {
    let startIdx = block.startIdx
    while (startIdx > 0 && smoothed[startIdx - 1] > recoveryThreshold) startIdx--
    let endIdx = block.endIdx
    while (endIdx < smoothed.length - 1 && smoothed[endIdx + 1] > recoveryThreshold) endIdx++

    const tStart = timeStream[startIdx]
    const tEnd   = timeStream[endIdx]
    const dur    = tEnd - tStart
    if (dur <= 0) continue

    const seg    = smoothed.slice(startIdx, endIdx + 1)
    const avgMs  = seg.reduce((s, v) => s + v, 0) / seg.length
    const paceSec = avgMs > 0 ? Math.round(1000 / avgMs) : 0

    if (dur <= 25) {
      // Stride candidate — check recovery valley in 30s after block
      const recoveryEndTime = tEnd + 30
      const recoveryIdx = timeStream.findIndex((t, idx) => idx > endIdx && t >= recoveryEndTime)
      const checkEnd = recoveryIdx !== -1 ? recoveryIdx : Math.min(endIdx + 30, smoothed.length - 1)

      const recoverySlice = smoothed.slice(endIdx + 1, checkEnd + 1)
      // Empty slice = end of activity, no recovery data → treat as interval (no confirmed recovery)
      const recoveryReturned = recoverySlice.length > 0 &&
        recoverySlice.some(v => v < recoveryThreshold)

      if (recoveryReturned && dur >= 8) {
        strides.push({
          startSec:    tStart,
          durationSec: dur,
          peakSpeedMs: Math.round(block.peakSpeed * 100) / 100,
        })
      } else if (dur >= 8) {
        // No recovery → treat as interval
        const hrSeg  = heartrateStream?.slice(startIdx, endIdx + 1)
        const avgHr  = hrSeg && hrSeg.length > 0
          ? Math.round(hrSeg.reduce((s, v) => s + v, 0) / hrSeg.length)
          : undefined
        intervalBlocks.push({ startSec: tStart, durationSec: dur, avgPaceSec: paceSec, avgHr })
      }
      // dur < 8: below minimum stride/interval threshold — discard (GPS noise)
    } else if (dur <= 180) {
      // Interval block
      const hrSeg = heartrateStream?.slice(startIdx, endIdx + 1)
      const avgHr = hrSeg && hrSeg.length > 0
        ? Math.round(hrSeg.reduce((s, v) => s + v, 0) / hrSeg.length)
        : undefined
      intervalBlocks.push({ startSec: tStart, durationSec: dur, avgPaceSec: paceSec, avgHr })
    } else {
      // Tempo block — compute pace drift (end third vs start third)
      const third = Math.floor(seg.length / 3)
      const startSlice = seg.slice(0, Math.max(1, third))
      const endSlice   = seg.slice(seg.length - Math.max(1, third))
      const startAvgMs = startSlice.reduce((s, v) => s + v, 0) / startSlice.length
      const endAvgMs   = endSlice.reduce((s, v) => s + v, 0) / endSlice.length
      // Drift in pace: positive = pace got slower (higher sec/km), as %
      const startPace = startAvgMs > 0 ? 1000 / startAvgMs : 0
      const endPace   = endAvgMs   > 0 ? 1000 / endAvgMs   : 0
      const paceDeviation = startPace > 0
        ? Math.round(((endPace - startPace) / startPace) * 100 * 10) / 10
        : 0
      tempoBlocks.push({ startSec: tStart, durationSec: dur, avgPaceSec: paceSec, paceDeviation })
    }
  }

  // Merge adjacent tempo blocks (gap <15s means one sustained block)
  const mergedTempo: TempoBlock[] = []
  for (const tb of tempoBlocks) {
    if (mergedTempo.length === 0) { mergedTempo.push(tb); continue }
    const prev = mergedTempo[mergedTempo.length - 1]
    if (tb.startSec - (prev.startSec + prev.durationSec) < 15) {
      const totalDur = tb.startSec + tb.durationSec - prev.startSec
      const wPrev = prev.durationSec / totalDur
      const wCurr = tb.durationSec  / totalDur
      mergedTempo[mergedTempo.length - 1] = {
        startSec:      prev.startSec,
        durationSec:   totalDur,
        avgPaceSec:    Math.round(prev.avgPaceSec * wPrev + tb.avgPaceSec * wCurr),
        paceDeviation: Math.round((prev.paceDeviation + tb.paceDeviation) / 2 * 10) / 10,
      }
    } else {
      mergedTempo.push(tb)
    }
  }

  // ── Determine workoutType from what was found ────────────────────────────────
  const hasStrides    = strides.length > 0
  const hasIntervals  = intervalBlocks.length > 0
  const hasTempo      = mergedTempo.length > 0
  const typeCount     = [hasStrides, hasIntervals, hasTempo].filter(Boolean).length

  let workoutType: WorkoutClassification['workoutType']
  if (typeCount === 0) {
    workoutType = 'easy'
  } else if (typeCount > 1) {
    workoutType = 'mixed'
  } else if (hasStrides) {
    workoutType = 'strides'
  } else if (hasIntervals) {
    workoutType = 'intervals'
  } else {
    workoutType = 'tempo'
  }

  return { workoutType, strides, intervalBlocks, tempoBlocks: mergedTempo }
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
): StrideAnalysis {
  const { time, velocity_smooth, heartrate } = streams
  if (velocity_smooth.length < 10) {
    return { strides: [], strideCount: 0, avgPeakPaceSec: 0, fastestPaceSec: 0, thresholdMs: 0, avgRecoverySec: null }
  }

  const avgSpeedMs = 1000 / avgPaceSec
  // Peak threshold: stride peak must be ≥15% above avg (catches progressive acceleration)
  const peakThreshold  = avgSpeedMs * 1.15
  // Baseline: stride boundaries traced to where speed drops ≤8% above avg (captures full incl. run-up)
  const baselineFactor = 1.08

  // 5-point moving average — smoother than 3-point, better for finding true peaks
  const smoothed = velocity_smooth.map((_v, i) => {
    const slice = velocity_smooth.slice(Math.max(0, i - 2), Math.min(velocity_smooth.length, i + 3))
    return slice.reduce((s, x) => s + x, 0) / slice.length
  })

  // Step 1: Find local speed peaks above peakThreshold
  const peakIdxs: number[] = []
  for (let i = 2; i < smoothed.length - 2; i++) {
    if (
      smoothed[i] >= peakThreshold &&
      smoothed[i] >= smoothed[i - 1] && smoothed[i] >= smoothed[i - 2] &&
      smoothed[i] >= smoothed[i + 1] && smoothed[i] >= smoothed[i + 2]
    ) {
      peakIdxs.push(i)
    }
  }

  // Step 2: For each peak, expand outward to baseline crossings
  const baseline = avgSpeedMs * baselineFactor
  const strides: StrideSegment[] = []

  for (const peakIdx of peakIdxs) {
    // Trace back to find acceleration start (last crossing of baseline going upward)
    let startIdx = peakIdx
    while (startIdx > 0 && smoothed[startIdx - 1] > baseline) startIdx--
    // Trace forward to find deceleration end
    let endIdx = peakIdx
    while (endIdx < smoothed.length - 1 && smoothed[endIdx + 1] > baseline) endIdx++

    const tStart = time[startIdx]
    const tEnd   = time[endIdx]
    const dur    = tEnd - tStart

    // Sanity bounds: 8–60 s, 30–250 m (100m at 2:30–8:00 pace covers this range)
    if (dur < 8 || dur > 60) continue
    const seg    = smoothed.slice(startIdx, endIdx + 1)
    const peakMs = Math.max(...seg)
    const avgMs  = seg.reduce((s, v) => s + v, 0) / seg.length
    const distM  = Math.round(avgMs * dur)
    if (distM < 30 || distM > 250) continue

    // Skip if this overlaps with the previous stride (recovery must be ≥15 s)
    if (strides.length > 0) {
      const prevEnd = strides[strides.length - 1].endSec
      if (tStart - prevEnd < 15) {
        // Overlap — keep whichever has the higher peak
        if (peakMs > 1000 / strides[strides.length - 1].peakPaceSec) {
          strides.pop()
        } else {
          continue
        }
      }
    }

    const hrSeg  = heartrate?.slice(startIdx, endIdx + 1)
    const peakHr = hrSeg && hrSeg.length > 0 ? Math.max(...hrSeg) : undefined

    strides.push({
      startSec:    tStart,
      endSec:      tEnd,
      durationSec: dur,
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
