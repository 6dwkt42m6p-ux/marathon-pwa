// Inhalt: Trainingslast (TSS-Varianten, Tageslast-Reihe, ATL/CTL/TSB).
// Zweck: Ports von coach_load.py (_daily_load, compute_atl_ctl, run_rtss/run_hrtss)
//   und coach_multisport.py (bike_tss) — Python ist die Referenz.
// Einstieg: activityLoad, dailyLoadSeries (auch von injuryRisk genutzt), computeAtlCtl,
//   ctlRising, bikeTss, runRtss, runHrtss, classifyHike, SyncedThreshold.
// Abschnitte: Faktor-Tabellen · TSS-Formeln · activityLoad · Tagesreihe · EWMA.
// Regeln: importiert ./parse, ./types, ../pyRound.
import { localISODate } from './parse'
import { pyRound } from '../pyRound'
import type { StravaActivity } from './types'

export interface AtlCtlResult {
  atl: number
  ctl: number
  tsb: number
}

// Factor maps mirroring coach_load.py:_WORKOUT_TYPE_FACTOR and _SPORT_TYPE_FACTOR (T-122).
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

// T-125: Power-based Training Stress Score — faithful port of coach_multisport.py:bike_tss.
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

// T-138: rTSS/hrTSS — formelgleich zu coach_load.py:run_rtss/run_hrtss.
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

// T-134-Zwilling (coach_load.py): Schwellen fuer Bergtour vs. Recovery-Spaziergang.
export const HIKE_ENDURANCE_MIN_ELEV_M = 400
export const HIKE_ENDURANCE_MIN_DURATION_MIN = 150

/** Zwilling von coach_load.classify_hike: 'bergtour' bei Hoehenmetern ODER Dauer ueber der
 * Schwelle, sonst 'spaziergang'. Hoehenmeter wie parse_to_df auf ganze Meter gerundet
 * (Python-round), fehlende Werte -> 0. Hintergrund: T-134 / T-292 */
export function classifyHike(a: StravaActivity): 'bergtour' | 'spaziergang' {
  const elevM = pyRound(Number(a.total_elevation_gain) || 0)
  const durMin = (Number(a.moving_time) || 0) / 60
  return elevM >= HIKE_ENDURANCE_MIN_ELEV_M || durMin >= HIKE_ENDURANCE_MIN_DURATION_MIN
    ? 'bergtour' : 'spaziergang'
}

/** _daily_load ueberspringt Recovery-Spaziergaenge (kein Eintrag, auch nicht fuer den Serienstart).
 * Typ wie parse_to_df: legacy `type` vor `sport_type`. Hintergrund: T-134 / T-292 */
function isRecoveryWalk(a: StravaActivity): boolean {
  const t = a.type || a.sport_type || ''
  return (t === 'Hike' || t === 'Walk') && classifyHike(a) === 'spaziergang'
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
  // Mirrors coach_load.py:_daily_load priority: power path runs FIRST, before suffer_score.
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
    // Wie parse_to_df: pace_sec_km auf 0.1 s (Python-round), nur bei > 100 m.
    const distKm = (a.distance || 0) / 1000
    const paceSec = distKm > 0.1 ? pyRound(durSec / distKm, 1) : null
    const rtss = runRtss(durSec, paceSec, threshold.threshold_pace_sec)
    const hrtss = runHrtss(durSec, a.average_heartrate, threshold.lthr, threshold.rest_hr)
    const structured = a.workout_type === 3 ||
      (rtss != null && hrtss != null && hrtss >= rtss * STRUCTURED_DIVERGENCE)
    if (structured && hrtss != null) return hrtss
    if (rtss != null) return rtss
    if (hrtss != null) return hrtss
    // Both null → fall through to suffer_score/factor path
  }

  // Priority 2: suffer_score when present and > 0 (Strava HR-based load).
  if (a.suffer_score != null && a.suffer_score > 0) return a.suffer_score

  // Priority 3: duration × factor (no HR data / suffer_score absent / no power path).
  const durationMin = (a.moving_time || 0) / 60
  const wt = a.workout_type ?? 0

  // Auswahllogik identical to coach_load.py:_daily_load:
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

  // Ungerundet wie _daily_load; gerundet wird nur das Ergebnis (ATL/CTL/TSB, ACWR).
  return durationMin * factor
}

// T-144: per-Kalendertag-Last oldest→today (gefüllt 0). Geteilt von computeAtlCtl + injuryRisk,
// spiegelt coach_load.py:_daily_load + reindex-to-today.
export function dailyLoadSeries(
  activities: StravaActivity[], ftp?: number, threshold?: SyncedThreshold,
): number[] {
  if (!activities.length) return []
  const dayMap = new Map<string, number>()
  for (const a of activities) {
    if (isRecoveryWalk(a)) continue
    const day = (a.start_date_local || a.start_date).slice(0, 10)
    dayMap.set(day, (dayMap.get(day) ?? 0) + activityLoad(a, ftp, threshold))
  }
  if (!dayMap.size) return []
  const dates = Array.from(dayMap.keys()).sort()
  // Lokal parsen: new Date('YYYY-MM-DD') ist UTC-Mitternacht und schloss in UTC+ den heutigen Tag aus (P-02).
  const [sy, sm, sd] = dates[0].split('-').map(Number)
  const startDate = new Date(sy, sm - 1, sd)
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
    atl: pyRound(atl, 1),
    ctl: pyRound(ctl, 1),
    tsb: pyRound(ctl - atl, 1),
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
