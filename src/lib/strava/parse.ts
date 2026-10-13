// Inhalt: Parsing und Wochen-Aggregation von Strava-Aktivitaeten.
// Zweck: Rohaktivitaeten -> RunSummary/ActivitySummary, lokale Datums-Helfer, Wochenstatistik.
// Einstieg: parseRuns, parseAllActivities, parseStravaLocal (Z-Suffix strippen!),
//   mondayOf, localISODate (kein toISOString), computeWeeklyStats, thisWeekKm,
//   thisWeekStatsBySport, computeWeeklyStatsBySport, isRunType, DAY_TAGS.
// Abschnitte: Sport-Typen · Temperatur/Parse · Wochenstatistik · Sport-Wochen · Laeufe.
// Regeln: importiert nur ./types; Blatt-Modul, von trend/load genutzt.
import type { StravaActivity, RunSummary, ActivitySummary } from './types'

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

// T-184: Desktop (T-183) resolves real per-activity weather (Open-Meteo) and ships it via
// sync.json's top-level `activityTemps` map (id-as-string → °C). The PWA deliberately does
// NOT re-implement the weather lookup here — the privacy-sensitive coordinate rounding (D-031)
// stays in exactly one place (Desktop).
//
// Fix-loop (coordinator review): an earlier version of this held `activityTemps` as a hidden
// module-level store, mutated by a `setActivityTemps()` side effect once sync.json arrived.
// Components memoize parseAllActivities/parseRuns on `useMemo(..., [cached])` — a mutation to
// a store outside that dependency array is invisible to React, so the UI kept showing
// temperature-less values until the NEXT unrelated Strava sync bumped `cached`. Fix: no hidden
// state — activityTemps is an explicit parameter. Callers (Analysis.tsx, TrainingPlan.tsx,
// TodayWorkout.tsx) hold the fetched map in component state and include it in their useMemo
// deps, so a resolved sync now correctly triggers a re-parse.
//
// Nullish-coalescing (not `||`): a real 0 °C reading on either source must survive.
// Same falsy-zero trap as `plannedKm === 0` in T-169.
function resolveTempC(a: StravaActivity, activityTemps: Record<string, number>): number | undefined {
  return a.average_temp ?? activityTemps[String(a.id)]
}

// Strava sends start_date_local as LOCAL wallclock time with a misleading 'Z' (or +HH:MM) suffix.
// Stripping the TZ designator makes JS parse the string as local time → correct week bucketing.
// Falls back to start_date (true UTC) when start_date_local is absent.
export function parseStravaLocal(a: StravaActivity): Date {
  const s = a.start_date_local || a.start_date
  return new Date(s.replace(/(Z|[+-]\d{2}:?\d{2})$/, ''))
}

// activityTemps (T-184): sync.json-derived °C map (id-as-string → value), defaults to `{}`
// when no sync has happened yet — callers pass this explicitly so it can participate in their
// own memoization (see comment on resolveTempC above for why this must not be a hidden store).
export function parseAllActivities(activities: StravaActivity[], activityTemps: Record<string, number> = {}): ActivitySummary[] {
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
        tempC:       resolveTempC(a, activityTemps),
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

export function parseRuns(activities: StravaActivity[], activityTemps: Record<string, number> = {}): RunSummary[] {
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
        tempC:       resolveTempC(a, activityTemps),
      }
    })
    .sort((a, b) => b.date.getTime() - a.date.getTime())
}
