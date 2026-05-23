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
  zoneCode:  string
  zoneName:  string
  zoneColor: string
  verdict:   string
  note:      string
  devSec:    number
  devStr:    string
  hrZone:    string | null
  hrNote:    string | null
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
): RunAnalysis {
  const p = trainingPaces(vdot)
  const TOL = 0.02

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
    return { zoneCode, zoneName, zoneColor, verdict, note, devSec, devStr, hrZone, hrNote: null }
  }

  if (paceSec < p.I * (1 + TOL)) {
    zoneCode = 'I/R'; zoneName = 'Intervall / Rep';   zoneColor = '#e53935'
  } else if (paceSec < p.T * (1 + TOL)) {
    zoneCode = 'T';   zoneName = 'Schwelle (T)';       zoneColor = '#FF9800'
  } else if (paceSec < p.E_high * (1 - TOL)) {
    zoneCode = 'M';   zoneName = 'Marathon-Pace (M)'; zoneColor = '#FFC107'
  } else if (paceSec < p.E_low * (1 + TOL)) {
    zoneCode = 'E';   zoneName = 'Easy (E)';           zoneColor = '#4CAF50'
  } else {
    zoneCode = 'Z1';  zoneName = 'Regeneration (Z1)'; zoneColor = '#42A5F5'
  }

  const eCenter = (p.E_high + p.E_low) / 2
  const devSec  = Math.round(paceSec - eCenter)
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
  let hrZone:  string | null = null
  let hrNote:  string | null = null

  if (avgHr && avgHr > 0 && maxHr > restHr) {
    const hrPct = (avgHr - restHr) / (maxHr - restHr) * 100
    if      (hrPct < 60) hrZone = 'Z1'
    else if (hrPct < 70) hrZone = 'Z2'
    else if (hrPct < 80) hrZone = 'Z3'
    else if (hrPct < 90) hrZone = 'Z4'
    else                  hrZone = 'Z5'

    const hasSpikes = isWorkout || ((activityMaxHr ?? 0) - avgHr > 20)

    // Mismatch notes
    if ((zoneCode === 'E' || zoneCode === 'Z1') && (hrZone === 'Z4' || hrZone === 'Z5') && !hasSpikes) {
      hrNote = `HF ${Math.round(hrPct)}% HFR — höher als Pace andeutet. Hitze, Ermuedung oder Stress?`
    } else if ((zoneCode === 'I/R' || zoneCode === 'T') && (hrZone === 'Z1' || hrZone === 'Z2')) {
      hrNote = `HF ${Math.round(hrPct)}% HFR — niedriger als Pace andeutet. Kurze Einheit?`
    } else if (zoneCode === 'M' && hrZone === 'Z2') {
      hrNote = `HF ${Math.round(hrPct)}% HFR — sehr kontrolliert bei M-Pace. Guter Fitnessstand.`
    } else if (hrZone && hasSpikes) {
      hrNote = `Durchschnitt ${Math.round(avgHr)} bpm (${hrZone}) mit Spitzen — Workout oder Intervalle enthalten.`
    }
  }

  return { zoneCode, zoneName, zoneColor, verdict, note, devSec, devStr, hrZone, hrNote }
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
