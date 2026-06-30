// Jack Daniels VDOT methodology — ported from coach.py

export const ZONES = {
  E_low:  0.62,
  E_high: 0.74,
  M:      0.81,
  T:      0.88,
  I:      0.95,
  R:      1.05,
} as const

export type ZoneKey = keyof typeof ZONES

function vo2AtVelocity(v: number): number {
  return -4.60 + 0.182258 * v + 0.000104 * v * v
}

function velocityAtVo2(vo2: number): number {
  const a = 0.000104
  const b = 0.182258
  const c = vo2 + 4.60
  if (c <= 0) return 0
  const disc = b * b + 4 * a * c
  return (-b + Math.sqrt(disc)) / (2 * a)
}

function pctVo2max(tMin: number): number {
  return (
    0.8 +
    0.1894393 * Math.exp(-0.012778 * tMin) +
    0.2989558 * Math.exp(-0.1932605 * tMin)
  )
}

export function vdotFromRace(distanceM: number, timeSec: number): number {
  const tMin = timeSec / 60
  const v    = distanceM / tMin
  const vo2  = vo2AtVelocity(v)
  const pct  = pctVo2max(tMin)
  return vo2 / pct
}

export function trainingPaces(vdot: number): Record<ZoneKey, number> {
  const result = {} as Record<ZoneKey, number>
  for (const [zone, pct] of Object.entries(ZONES) as [ZoneKey, number][]) {
    const vo2 = vdot * pct
    const v   = velocityAtVo2(vo2)
    result[zone] = v > 0 ? (1000 / v) * 60 : NaN
  }
  return result
}

export function formatPace(secPerKm: number): string {
  if (!isFinite(secPerKm) || isNaN(secPerKm)) return '—'
  const total = Math.round(secPerKm)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

// Temperature performance adjustment (based on ACSM / Havenith research).
// Returns the fractional pace slowdown due to temperature (0.07 = 7% slower).
// Optimal zone: 10–15°C. Above 15°C: +0.5%/°C. Below 10°C: +0.2%/°C.
export function tempAdjFactor(tempC: number): number {
  if (tempC >= 10 && tempC <= 15) return 0
  if (tempC > 15) return Math.min((tempC - 15) * 0.005, 0.15)
  return Math.min((10 - tempC) * 0.002, 0.06)
}

// T-140: GAP + Hitze-Normalisierung — formelgleich coach.py effort_normalization_factor.
// Eliminiert Gelände- und Hitzeverzerrung aus EF und VDOT-Trend.
const GAP_GRADE_FLOOR_PCT = 1.0   // < 1% Ø-Steigung gilt als flach
const GAP_COST_PER_PCT   = 0.02  // 2% Pace-Vorteil je 1% Ø-Steigung über Floor
const GAP_CAP            = 0.12  // max. 12% GAP-Aufschlag

// T-142: uphill-only Gelände-Kostenfaktor (≥ 1.0). Eine Quelle für die GAP-Konstanten,
// genutzt von durability.ts (formelgleich coach.py _gap_factor_for_grade / effort_normalization).
export function gapFactorForGrade(gradePct: number): number {
  const gap = Math.min(GAP_COST_PER_PCT * Math.max(gradePct - GAP_GRADE_FLOOR_PCT, 0), GAP_CAP)
  return 1 + gap
}

export function effortNormalizationFactor(
  distanceKm: number, elevationM: number, tempC?: number,
): number {
  let heat = 0
  if (tempC != null && !Number.isNaN(tempC)) {
    heat = tempAdjFactor(tempC)
    if (heat < 0.015) heat = 0
  }
  let gap = 0
  if (distanceKm > 0 && Number.isFinite(elevationM)) {
    const gradePct = (elevationM / (distanceKm * 1000)) * 100
    gap = Math.min(GAP_COST_PER_PCT * Math.max(gradePct - GAP_GRADE_FLOOR_PCT, 0), GAP_CAP)
  }
  return (1 + heat) * (1 + gap)
}

export function parsePaceToSec(paceStr: string): number | null {
  const match = paceStr.match(/^(\d+):(\d{2})$/)
  if (!match) return null
  return parseInt(match[1]) * 60 + parseInt(match[2])
}

export interface PaceTable {
  E_low:  string
  E_high: string
  M:      string
  T:      string
  I:      string
  R:      string
  I_400m:  string
  I_600m:  string
  I_800m:  string
  I_1000m: string
  I_1200m: string
}

export function buildPaceTable(vdot: number): PaceTable {
  const p = trainingPaces(vdot)
  const iSec = p.I
  return {
    E_low:   formatPace(p.E_low),
    E_high:  formatPace(p.E_high),
    M:       formatPace(p.M),
    T:       formatPace(p.T),
    I:       formatPace(p.I),
    R:       formatPace(p.R),
    I_400m:  formatPace(iSec * 0.40),
    I_600m:  formatPace(iSec * 0.60),
    I_800m:  formatPace(iSec * 0.80),
    I_1000m: formatPace(iSec),
    I_1200m: formatPace(iSec * 1.20),
  }
}

export function classifyRun(paceSec: number, vdot: number): { code: string; name: string; color: string } {
  const p = trainingPaces(vdot)
  if (paceSec < p.I * 1.02)        return { code: 'I/R', name: 'Intervall / Rep',   color: '#e53935' }
  if (paceSec < p.T * 1.02)        return { code: 'T',   name: 'Schwelle (T)',       color: '#FF9800' }
  if (paceSec < p.E_high * 0.99)   return { code: 'M',   name: 'Marathon-Pace (M)', color: '#FFC107' }
  if (paceSec < p.E_low * 1.06)    return { code: 'E',   name: 'Easy (E)',           color: '#4CAF50' }
  return { code: 'Z1', name: 'Regeneration (Z1)', color: '#42A5F5' }
}

export function feasibilityCheck(currentVdot: number, targetVdot: number, weeks: number) {
  const delta = targetVdot - currentVdot
  if (delta <= 0) return { rating: 'Bereits erreicht', emoji: '✅', color: '#28a745', delta, message: `Aktueller VDOT ${currentVdot.toFixed(1)} reicht bereits!` }
  const rate = delta / weeks
  if (rate < 0.12) return { rating: 'Realistisch',        emoji: '🟢', color: '#28a745', delta, message: `+${delta.toFixed(1)} VDOT in ${weeks} Wochen. Mit regelmäßigem Training gut erreichbar.` }
  if (rate < 0.20) return { rating: 'Ambitioniert',       emoji: '🟡', color: '#e6a817', delta, message: `+${delta.toFixed(1)} VDOT in ${weeks} Wochen. Machbar mit konsequentem Training.` }
  if (rate < 0.30) return { rating: 'Sehr ambitioniert',  emoji: '🟠', color: '#fd7e14', delta, message: `+${delta.toFixed(1)} VDOT in ${weeks} Wochen. Setzt verletzungsfreies Toptraining voraus.` }
  return { rating: 'Unrealistisch', emoji: '🔴', color: '#dc3545', delta, message: `+${delta.toFixed(1)} VDOT in ${weeks} Wochen. Physiologisch kaum erreichbar.` }
}

export interface RunAnalysis {
  zoneCode:       string
  zoneName:       string
  zoneColor:      string
  verdict:        string
  note:           string
  devSec:         number
  devStr:         string
  hrZone:         string | null
  hrNote:         string | null
  strideDetected: boolean
  maxHrZone:      string | null
  maxHrPct:       number | null
  hrSpikeBpm:     number | null
  tempNote:       string | null  // temp adjustment info, null when < 1.5% impact
  adjPaceSec:     number | null  // heat/cold-corrected pace used for zone classification
}

export function analyzeRun(
  paceSec: number,
  distanceKm: number,
  avgHr: number | undefined,
  activityMaxHr: number | undefined,
  vdot: number,
  maxHr: number,
  restHr: number,
  phase: string,
  isWorkout = false,
  isTrail = false,
  tempC?: number,
): RunAnalysis {
  const p = trainingPaces(vdot)
  const TOL = 0.02

  // Temperature-adjusted pace: what this effort equals at the optimal 10–15°C range.
  // Zone classification uses the adjusted value so a hot-day run isn't penalised.
  const adj      = tempC !== undefined ? tempAdjFactor(tempC) : 0
  const adjPace  = adj >= 0.015 ? Math.round(paceSec / (1 + adj)) : null
  const effPace  = adjPace ?? paceSec   // pace used for zone classification

  let tempNote: string | null = null
  if (adj >= 0.015 && tempC !== undefined) {
    const pctStr    = `${Math.round(adj * 100)}%`
    const adjFmtStr = formatPace(effPace)
    tempNote = tempC > 15
      ? `🌡️ ${Math.round(tempC)}°C — Pace-Malus ~${pctStr}. Leistungsäquivalent bei 15°C: ${adjFmtStr}/km`
      : `🥶 ${Math.round(tempC)}°C — Kälteeinfluss ~${pctStr}. Leistungsäquivalent: ${adjFmtStr}/km`
  }

  let zoneCode:  string
  let zoneName:  string
  let zoneColor: string

  // Trail runs: pace is not comparable to road pace — use HR-based zone if available,
  // otherwise flag as trail and skip pace-zone classification
  if (isTrail) {
    if (avgHr && avgHr > 0 && maxHr > restHr) {
      const hrPct = (avgHr - restHr) / (maxHr - restHr) * 100
      if      (hrPct < 60) { zoneCode = 'Z1'; zoneName = 'Regeneration (Z1)'; zoneColor = '#42A5F5' }
      else if (hrPct < 70) { zoneCode = 'E';  zoneName = 'Easy (E)';          zoneColor = '#4CAF50' }
      else if (hrPct < 80) { zoneCode = 'M';  zoneName = 'Aerob (Z3)';        zoneColor = '#FFC107' }
      else if (hrPct < 90) { zoneCode = 'T';  zoneName = 'Schwelle (Z4)';     zoneColor = '#FF9800' }
      else                  { zoneCode = 'I/R'; zoneName = 'Intensiv (Z5)';   zoneColor = '#e53935' }
    } else {
      zoneCode = 'E'; zoneName = 'Trail (kein HF)'; zoneColor = '#4CAF50'
    }
    const eCenter = (p.E_high + p.E_low) / 2
    const devSec  = Math.round(paceSec - eCenter)
    const devStr  = devSec >= 0 ? `+${devSec}s/km` : `${devSec}s/km`
    const verdict = '🏔️ Trailrun'
    const note    = `Geländekorrigierte Auswertung — Pace nicht mit Straßenlauf vergleichbar. ${distanceKm >= 20 ? 'Tolle Langstrecke!' : 'Gute Einheit.'}`
    const hrZone  = zoneCode === 'I/R' ? 'Z5' : zoneCode === 'T' ? 'Z4' : zoneCode === 'M' ? 'Z3' : zoneCode === 'E' ? 'Z2' : 'Z1'
    return { zoneCode, zoneName, zoneColor, verdict, note, devSec, devStr, hrZone, hrNote: null, strideDetected: false, maxHrZone: null, maxHrPct: null, hrSpikeBpm: null, tempNote, adjPaceSec: adjPace }
  }

  if (effPace < p.I * (1 + TOL)) {
    zoneCode = 'I/R'; zoneName = 'Intervall / Rep';   zoneColor = '#e53935'
  } else if (effPace < p.T * (1 + TOL)) {
    zoneCode = 'T';   zoneName = 'Schwelle (T)';       zoneColor = '#FF9800'
  } else if (effPace < p.E_high * (1 - TOL)) {
    zoneCode = 'M';   zoneName = 'Marathon-Pace (M)'; zoneColor = '#FFC107'
  } else if (effPace < p.E_low * (1 + TOL)) {
    zoneCode = 'E';   zoneName = 'Easy (E)';           zoneColor = '#4CAF50'
  } else {
    zoneCode = 'Z1';  zoneName = 'Regeneration (Z1)'; zoneColor = '#42A5F5'
  }

  const eCenter = (p.E_high + p.E_low) / 2
  const devSec  = Math.round(effPace - eCenter)  // deviation uses temp-adjusted pace
  const devStr  = devSec >= 0 ? `+${devSec}s/km` : `${devSec}s/km`

  const basePhase = phase.split(' ')[0].split('(')[0].trim()
  const isBasisTaper = basePhase === 'Basis' || basePhase === 'Tapering' ||
                       basePhase === 'HM-Tapering' || basePhase === 'HM-Erholung'

  let verdict: string
  let note: string

  if (zoneCode === 'I/R' || zoneCode === 'T') {
    if (isBasisTaper) { verdict = '⚠️ Zu intensiv';        note = 'Intensität zu hoch für aktuelle Phase. Easy halten.' }
    else               { verdict = '✅ Qualitätseinheit';   note = 'Schwellen- oder Intervalltraining erkannt.' }
  } else if (zoneCode === 'M') {
    if (isBasisTaper)  { verdict = '🟡 Leicht zu schnell'; note = 'Marathon-Pace in Basis/Erholungsphase — etwas zurücknehmen.' }
    else               { verdict = '✅ Marathon-Pace';      note = 'Renntempo — gute Einheit.' }
  } else if (zoneCode === 'E') {
    verdict = '✅ Zone korrekt'
    note    = 'Easy-Pace korrekt. Aerobe Basis wird gestärkt.'
  } else {
    // Z1
    const isPeak  = basePhase === 'Peak' || basePhase === 'Aufbau'
    if (isPeak && distanceKm > 10) {
      verdict = '🔵 Sehr konservativ'
      note    = 'Für Peak-/Aufbauphase etwas langsam — leicht anlehnen.'
    } else {
      verdict = '✅ Regenerationstempo'
      note    = 'Locker und regenerativ. Genau richtig.'
    }
  }

  // HR cross-check (Karvonen)
  let hrZone:         string | null = null
  let hrNote:         string | null = null
  let strideDetected  = false
  let maxHrZone:      string | null = null
  let maxHrPct:       number | null = null
  let hrSpikeBpm:     number | null = null

  if (avgHr && avgHr > 0 && maxHr > restHr) {
    const hrPct = (avgHr - restHr) / (maxHr - restHr) * 100
    if      (hrPct < 60) hrZone = 'Z1'
    else if (hrPct < 70) hrZone = 'Z2'
    else if (hrPct < 80) hrZone = 'Z3'
    else if (hrPct < 90) hrZone = 'Z4'
    else                  hrZone = 'Z5'

    const spikeBpm = (activityMaxHr ?? 0) - avgHr
    const hasSpikes = isWorkout || spikeBpm >= 22

    // HF-max zone
    if (activityMaxHr && activityMaxHr > 0) {
      const mPct = (activityMaxHr - restHr) / (maxHr - restHr) * 100
      maxHrPct = Math.round(mPct)
      if      (mPct < 60) maxHrZone = 'Z1'
      else if (mPct < 70) maxHrZone = 'Z2'
      else if (mPct < 80) maxHrZone = 'Z3'
      else if (mPct < 90) maxHrZone = 'Z4'
      else                 maxHrZone = 'Z5'
      hrSpikeBpm = Math.round(spikeBpm)
    }

    // Stride detection: Easy/Z1 average pace but clear HR spikes ≥ 22 bpm
    // Threshold raised (was 15): wrist/watch HR has ±10–15 bpm noise; 22 bpm requires
    // a sustained cardiac response, not just sensor artefact.
    if ((zoneCode === 'E' || zoneCode === 'Z1') && spikeBpm >= 22 && distanceKm >= 4) {
      strideDetected = true
      verdict = '⚡ Mögliche Strides / Beschleunigungen'
      note    = `Durchschnittspace Easy — korrekt für Stride-Einheit. HF-Spitzen +${Math.round(spikeBpm)} bpm über Ø könnten auf Beschleunigungen hindeuten. Pace-Verlauf laden für genaue Erkennung.`
    }

    // Heat elevates HR by ~0.5 bpm/°C above 15°C — suppress false mismatch warnings in hot conditions
    const heatHrBpm = tempC !== undefined && tempC > 15 ? Math.round((tempC - 15) * 0.5) : 0

    // Mismatch notes (only when no stride detected)
    if (!strideDetected) {
      if ((zoneCode === 'E' || zoneCode === 'Z1') && (hrZone === 'Z4' || hrZone === 'Z5') && !hasSpikes) {
        hrNote = heatHrBpm >= 3
          ? `HF ${Math.round(hrPct)}% HFR — bei ${Math.round(tempC!)}°C normal erhöht (+${heatHrBpm} bpm Hitzeeinfluss erwartet).`
          : `HF ${Math.round(hrPct)}% HFR — höher als Pace andeutet. Hitze, Ermüdung oder Stress?`
      } else if ((zoneCode === 'I/R' || zoneCode === 'T') && (hrZone === 'Z1' || hrZone === 'Z2')) {
        hrNote = `HF ${Math.round(hrPct)}% HFR — niedriger als Pace andeutet. Kurze Einheit?`
      } else if (zoneCode === 'M' && hrZone === 'Z2') {
        hrNote = `HF ${Math.round(hrPct)}% HFR — sehr kontrolliert bei M-Pace. Guter Fitnessstand.`
      } else if (hrZone && hasSpikes) {
        hrNote = `Ø ${Math.round(avgHr)} bpm (${hrZone}) mit Spitzen — Workout oder Intervalle enthalten.`
      }
    }
  }

  return { zoneCode, zoneName, zoneColor, verdict, note, devSec, devStr, hrZone, hrNote, strideDetected, maxHrZone, maxHrPct, hrSpikeBpm, tempNote, adjPaceSec: adjPace }
}

export interface RideAnalysis {
  hrZone:          string
  hrZoneCode:      string
  verdict:         string
  note:            string
  runEquivMin:     number
  speedKmh:        number
  trainingBenefit: string
  color:           string
}

export function analyzeRide(
  durationSec: number,
  speedKmh: number,
  avgHr: number | undefined,
  maxHr: number,
  restHr: number,
): RideAnalysis {
  const durationMin = durationSec / 60

  let hrZone     = 'Z2'
  let hrZoneCode = 'Z2'

  if (avgHr && avgHr > 0 && maxHr > restHr) {
    const hrPct = (avgHr - restHr) / (maxHr - restHr) * 100
    if      (hrPct < 60) { hrZone = 'Z1 (Erholung)';    hrZoneCode = 'Z1' }
    else if (hrPct < 70) { hrZone = 'Z2 (Grundlage)';   hrZoneCode = 'Z2' }
    else if (hrPct < 80) { hrZone = 'Z3 (Tempo)';        hrZoneCode = 'Z3' }
    else if (hrPct < 90) { hrZone = 'Z4 (Schwelle)';    hrZoneCode = 'Z4' }
    else                  { hrZone = 'Z5 (VO2max)';      hrZoneCode = 'Z5' }
  } else {
    // Fallback to speed
    if      (speedKmh < 18) { hrZone = 'Z1 (Erholung)';  hrZoneCode = 'Z1' }
    else if (speedKmh < 25) { hrZone = 'Z2 (Grundlage)'; hrZoneCode = 'Z2' }
    else if (speedKmh < 32) { hrZone = 'Z3 (Tempo)';      hrZoneCode = 'Z3' }
    else                     { hrZone = 'Z4 (Schwelle)';  hrZoneCode = 'Z4' }
  }

  const factors: Record<string, number> = { Z1: 0.55, Z2: 0.67, Z3: 0.72, Z4: 0.78, Z5: 0.80 }
  const factor     = factors[hrZoneCode] ?? 0.67
  const runEquivMin = Math.round(durationMin * factor)

  let verdict:         string
  let note:            string
  let trainingBenefit: string
  let color:           string

  if (hrZoneCode === 'Z1') {
    verdict = '🔵 Aktive Erholung'; note = 'Sehr lockere Ausfahrt — fördert Regeneration.'; trainingBenefit = 'Erholung'; color = '#42A5F5'
  } else if (hrZoneCode === 'Z2') {
    verdict = '✅ Grundlagenausdauer'; note = 'Aerobes Radfahren stärkt die Grundlagenausdauer.'; trainingBenefit = 'Ausdauer'; color = '#4CAF50'
  } else if (hrZoneCode === 'Z3') {
    verdict = '🟡 Tempoausfahrt'; note = 'Mittlere Intensität — wertvoll für Gesamtfitness.'; trainingBenefit = 'Tempo'; color = '#FFC107'
  } else {
    verdict = '🔴 Hochintensiv'; note = 'Intensive Ausfahrt — zählt wie ein Qualitätslauf.'; trainingBenefit = 'Intensität'; color = '#e53935'
  }

  return { hrZone, hrZoneCode, verdict, note, runEquivMin, speedKmh, trainingBenefit, color }
}

export interface HrZoneRow {
  zone:    string
  hfRange: string
  pctMax:  string
  pctHrr:  string
  jdZone:  string
}

export function hrZones(maxHr: number, restHr: number): HrZoneRow[] {
  const hrr = maxHr - restHr
  const zones = [
    { zone: 'Z1 — Erholung',   pctLo: 0.50, pctHi: 0.60, jdZone: 'E/Z1' },
    { zone: 'Z2 — Grundlage',  pctLo: 0.60, pctHi: 0.70, jdZone: 'E' },
    { zone: 'Z3 — Tempo',       pctLo: 0.70, pctHi: 0.80, jdZone: 'M/T' },
    { zone: 'Z4 — Schwelle',   pctLo: 0.80, pctHi: 0.90, jdZone: 'T/I' },
    { zone: 'Z5 — VO2max',     pctLo: 0.90, pctHi: 1.00, jdZone: 'I/R' },
  ]
  return zones.map(z => {
    const hfLo = Math.round(restHr + z.pctLo * hrr)
    const hfHi = Math.round(restHr + z.pctHi * hrr)
    const maxLo = Math.round(z.pctLo * maxHr * 100) / 100
    const maxHi = Math.round(z.pctHi * maxHr * 100) / 100
    return {
      zone:    z.zone,
      hfRange: `${hfLo}–${hfHi} bpm`,
      pctMax:  `${Math.round(maxLo)}–${Math.round(maxHi)}%`,
      pctHrr:  `${Math.round(z.pctLo * 100)}–${Math.round(z.pctHi * 100)}%`,
      jdZone:  z.jdZone,
    }
  })
}

export interface LapResult {
  idx:         number
  paceSec:     number
  paceFmt:     string
  distKm:      number
  durationSec: number
  avgHr?:      number
  role:        'warmup' | 'interval' | 'recovery' | 'cooldown' | 'easy'
}

export interface WorkoutLapAnalysis {
  laps:        LapResult[]
  intervals:   { verdict: string; hrStr: string; dev: number }[]
  nIntervals:  number
  iPaceTarget: string
  wuNote:      string
  cdNote:      string
  rvNote:      string
  isAutoSplit: boolean
}

export function analyzeWorkoutLaps(
  laps: any[],
  vdot: number,
): WorkoutLapAnalysis | null {
  if (!laps || laps.length === 0) return null

  const p    = trainingPaces(vdot)
  const iSec = p.I
  const tSec = p.T
  const ehSec = p.E_high

  const parsed: LapResult[] = []
  for (const lap of laps) {
    const spd = lap.average_speed || 0
    if (spd <= 0) continue
    const paceSec = 1000 / spd
    parsed.push({
      idx:         lap.lap_index ?? parsed.length + 1,
      paceSec:     Math.round(paceSec * 10) / 10,
      paceFmt:     formatPace(paceSec),
      distKm:      Math.round((lap.distance || 0) / 1000 * 100) / 100,
      durationSec: lap.moving_time || 0,
      avgHr:       lap.average_heartrate,
      role:        'easy',
    })
  }
  if (parsed.length < 3) return null

  // Classify each lap by pace
  for (const lp of parsed) {
    if (lp.paceSec < tSec * 1.06)       lp.role = 'interval'
    else if (lp.paceSec < ehSec * 1.03) lp.role = 'recovery'
    else                                  lp.role = 'easy'
  }

  // Leading easy/recovery laps = warmup
  let i = 0
  while (i < parsed.length && (parsed[i].role === 'easy' || parsed[i].role === 'recovery')) {
    parsed[i].role = 'warmup'
    i++
    if (i < parsed.length && parsed[i].role === 'interval') break
  }

  // Trailing easy/recovery laps = cooldown
  i = parsed.length - 1
  while (i >= 0 && (parsed[i].role === 'easy' || parsed[i].role === 'recovery')) {
    parsed[i].role = 'cooldown'
    i--
    if (i >= 0 && parsed[i].role === 'interval') break
  }

  // Evaluate intervals vs I-pace
  const intervals: { verdict: string; hrStr: string; dev: number }[] = []
  for (const lp of parsed) {
    if (lp.role !== 'interval') continue
    const dev = lp.paceSec - iSec
    let verdict: string
    if (dev < -8)       verdict = `⚡ Zu schnell (${lp.paceFmt}, ${Math.abs(Math.round(dev))} s/km ü. I-Pace)`
    else if (dev <= 6)  verdict = `✅ I-Pace erreicht (${lp.paceFmt})`
    else if (dev <= 15) verdict = `🟡 Knapp langsam (${lp.paceFmt}, +${Math.round(dev)} s/km u. I-Pace)`
    else                verdict = `⚠️ Zu langsam (${lp.paceFmt}, +${Math.round(dev)} s/km u. I-Pace)`
    intervals.push({ verdict, hrStr: lp.avgHr ? ` · HF Ø ${Math.round(lp.avgHr)}` : '', dev })
  }

  const wuDist = parsed.filter(lp => lp.role === 'warmup').reduce((s, lp) => s + lp.distKm, 0)
  const cdDist = parsed.filter(lp => lp.role === 'cooldown').reduce((s, lp) => s + lp.distKm, 0)
  const rvLaps = parsed.filter(lp => lp.role === 'recovery')

  const wuNote = wuDist >= 1.5 ? `✅ Einlaufen: ${wuDist.toFixed(1)} km` : `⚠️ Einlaufen kurz (${wuDist.toFixed(1)} km — min. 1.5 km)`
  const cdNote = cdDist >= 1.0 ? `✅ Auslaufen: ${cdDist.toFixed(1)} km` : `⚠️ Auslaufen kurz (${cdDist.toFixed(1)} km — min. 1 km)`
  const rvNote = rvLaps.every(lp => lp.paceSec >= ehSec * 0.92)
    ? '✅ Pausen im Easy-Bereich' : '⚠️ Pausen zu schnell — mehr Erholung einplanen'

  const dists  = parsed.map(lp => lp.distKm)
  const mean   = dists.reduce((a, b) => a + b, 0) / dists.length
  const stdDev = Math.sqrt(dists.reduce((s, d) => s + (d - mean) ** 2, 0) / dists.length)

  return { laps: parsed, intervals, nIntervals: intervals.length, iPaceTarget: formatPace(iSec), wuNote, cdNote, rvNote, isAutoSplit: stdDev < 0.15 }
}

// T-123: Single canonical VDOT source.
// Desktop-derived syncedVdot (from sync.json plan.vdot) is authoritative when present;
// settingsVdot is the offline / no-sync fallback.
// vdot=0 is treated as absent (not a valid fitness value).
export function selectEffectiveVdot(
  syncedVdot: number | null | undefined,
  settingsVdot: number,
): number {
  if (syncedVdot) return syncedVdot
  return settingsVdot
}

// T-146: Bisection-inverse of vdotFromRace. Port of coach._time_for_vdot.
export function timeForVdot(distanceM: number, targetVdot: number): number {
  let lo = 60, hi = 36000
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2
    if (vdotFromRace(distanceM, mid) > targetVdot) lo = mid; else hi = mid
  }
  return (lo + hi) / 2
}

// T-146: Race-Predictor — faithful port of coach.race_predictor (T-145). Konservativ.
const PRED_FITNESS_RATE_VDOT = 0.05
const PRED_FITNESS_CAP_VDOT  = 0.4
const PRED_FITNESS_MAX_WEEKS = 8
const PRED_FADE_PENALTY_CAP  = 0.04
const PRED_TAPER_WEEKS       = 3
const PRED_MARATHON_MIN_M    = 30000

export interface RacePredictorOpts {
  weeksToRace?:      number | null
  tsb?:              number | null
  ctlRising?:        boolean | null
  durabilityFactor?: number | null
  paceFadeRecent?:   number | null
  lowData?:          boolean
}

export interface RacePredictorResult {
  predictedSec:     number | null
  rangeLowSec:      number | null
  rangeHighSec:     number | null
  baseSec:          number | null
  bandPct:          number
  confidence:       'hoch' | 'mittel' | 'niedrig'
  effVdot:          number | null
  fitnessGainVdot:  number
  durabilityMult:   number
  taperMult:        number
  notes:            string[]
}

function _clampP(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x))
}

function _isFiniteNum(x: number | null | undefined): x is number {
  return x != null && Number.isFinite(x)
}

export function racePredictor(
  currentVdot: number | null,
  goalDistM: number,
  opts: RacePredictorOpts = {},
): RacePredictorResult {
  const neutral: RacePredictorResult = {
    predictedSec: null, rangeLowSec: null, rangeHighSec: null, baseSec: null,
    bandPct: 0.10, confidence: 'niedrig', effVdot: null, fitnessGainVdot: 0,
    durabilityMult: 1, taperMult: 1,
    notes: ['Zu wenig Fitness-Daten für eine Prognose.'],
  }
  if (!_isFiniteNum(currentVdot) || currentVdot <= 0 || !goalDistM || goalDistM <= 0) return neutral

  const {
    weeksToRace = null, tsb = null, ctlRising = null,
    durabilityFactor = null, paceFadeRecent = null, lowData = false,
  } = opts
  const notes: string[] = []
  const baseSec = timeForVdot(goalDistM, currentVdot)

  // 1. Fitness-Projektion (nur bei steigendem CTL)
  let fitnessGain = 0
  if (weeksToRace != null && ctlRising) {
    const w = Math.max(Math.floor(weeksToRace), 0)
    fitnessGain = _clampP(
      Math.min(w, PRED_FITNESS_MAX_WEEKS) * PRED_FITNESS_RATE_VDOT,
      0, PRED_FITNESS_CAP_VDOT,
    )
    if (fitnessGain > 0) notes.push(`Aufbau-Projektion +${fitnessGain.toFixed(2)} VDOT (CTL steigt).`)
  }
  let effVdot = currentVdot + fitnessGain

  // 2. Durability (nur Marathon-Distanz >= 30 km)
  let durabilityMult = 1
  if (goalDistM >= PRED_MARATHON_MIN_M) {
    if (_isFiniteNum(durabilityFactor) && durabilityFactor > 0) {
      durabilityMult = durabilityFactor
      if (durabilityMult < 1) notes.push(`Durability-Abschlag ×${durabilityMult.toFixed(3)} (Marathon-Renn-Historie).`)
    } else if (_isFiniteNum(paceFadeRecent) && paceFadeRecent > 0) {
      const fadePenalty = _clampP(paceFadeRecent / 100 * 0.5, 0, PRED_FADE_PENALTY_CAP)
      durabilityMult = 1 - fadePenalty
      if (fadePenalty > 0) notes.push(`Durability-Abschlag −${(fadePenalty * 100).toFixed(1)}% (Longrun-Pace-Fade).`)
    }
  }
  effVdot *= durabilityMult

  let predicted = timeForVdot(goalDistM, effVdot)

  // 3. Taper (nur im Taper-Fenster weeks_to_race <= PRED_TAPER_WEEKS)
  let taperMult = 1
  if (weeksToRace != null && _isFiniteNum(tsb) && weeksToRace <= PRED_TAPER_WEEKS) {
    taperMult = 1 - _clampP(tsb, -20, 25) / 25 * 0.02
    if (taperMult < 1) notes.push(`Taper-Bonus ×${taperMult.toFixed(3)} (frisch, TSB ${tsb >= 0 ? '+' : ''}${Math.round(tsb)}).`)
    else if (taperMult > 1) notes.push(`Ermüdungs-Malus ×${taperMult.toFixed(3)} (TSB ${tsb >= 0 ? '+' : ''}${Math.round(tsb)}).`)
  }
  predicted *= taperMult

  // 4. Konfidenzband (additiv aus Unsicherheitsquellen)
  let bandPct = goalDistM >= PRED_MARATHON_MIN_M ? 0.03 : (goalDistM >= 20000 ? 0.02 : 0.015)
  if (goalDistM >= PRED_MARATHON_MIN_M && durabilityFactor == null) bandPct += 0.02
  bandPct += Math.min(weeksToRace ?? 0, 16) / 16 * 0.02
  if (_isFiniteNum(paceFadeRecent) && paceFadeRecent > 3) bandPct += 0.01
  if (lowData) bandPct += 0.02
  bandPct = _clampP(bandPct, 0.015, 0.10)

  const bandSec = Math.round(predicted * bandPct)
  predicted = Math.round(predicted)
  const confidence: 'hoch' | 'mittel' | 'niedrig' = bandPct < 0.025 ? 'hoch' : (bandPct < 0.05 ? 'mittel' : 'niedrig')

  return {
    predictedSec:  predicted,
    rangeLowSec:   predicted - bandSec,
    rangeHighSec:  predicted + bandSec,
    baseSec:       Math.round(baseSec),
    bandPct:       Math.round(bandPct * 10000) / 10000,
    confidence,
    effVdot:       Math.round(effVdot * 100) / 100,
    fitnessGainVdot: Math.round(fitnessGain * 100) / 100,
    durabilityMult:  Math.round(durabilityMult * 1000) / 1000,
    taperMult:       Math.round(taperMult * 1000) / 1000,
    notes,
  }
}

export const RACE_TARGETS: Record<string, { label: string; distM: number; targetSec: number }[]> = {
  hm: [
    { label: 'Sub 1:30', distM: 21097, targetSec: 89 * 60 + 59 },
    { label: 'Sub 1:35', distM: 21097, targetSec: 94 * 60 + 59 },
    { label: 'Sub 1:40', distM: 21097, targetSec: 99 * 60 + 59 },
  ],
  marathon: [
    { label: 'Sub 3:00', distM: 42195, targetSec: 179 * 60 + 59 },
    { label: 'Sub 3:15', distM: 42195, targetSec: 194 * 60 + 59 },
    { label: 'Sub 3:30', distM: 42195, targetSec: 209 * 60 + 59 },
  ],
}
