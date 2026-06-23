// T-124: Analytics functions ported from coach.py (faithful port — same formulas/thresholds).
// Functions: intensityDistribution, stagnationCheck, vdotAdherenceCheck, aggregateStrideTrend.
// Cross-app guardrail: coach.py is SSoT. Any change to coach.py thresholds must be mirrored here.

import { trainingPaces, formatPace } from './vdot'
import { mondayOf, localISODate } from './strava'
import type { RunSummary } from './strava'

// ── Karvonen HR zone helper (mirrors coach.py _hr_zone_code) ─────────────────
// hrPct = (avgHr - restHr) / (maxHr - restHr) * 100
function _hrZoneCode(hrPct: number): 'Z1' | 'Z2' | 'Z3' | 'Z4' | 'Z5' {
  if (hrPct < 60) return 'Z1'
  if (hrPct < 70) return 'Z2'
  if (hrPct < 80) return 'Z3'
  if (hrPct < 90) return 'Z4'
  return 'Z5'
}

// ── intensityDistribution ─────────────────────────────────────────────────────
// Ports coach.py intensity_distribution() — Path B only (avg-HR whole-activity bucket).
// Path A (per-second HR stream) is not available on the PWA without on-demand stream fetch,
// which would require an API call per activity. PWA uses avg-HR bucketing for all activities.
// This is the documented approximation for T-124 (see impl note).

export interface IntensityTotals {
  easyMin:    number
  greyMin:    number
  qualityMin: number
  totalMin:   number
  easyPct:    number
  greyPct:    number
  qualityPct: number
}

export interface IntensityWeekRow {
  weekStart:  Date
  easyMin:    number
  greyMin:    number
  qualityMin: number
  totalMin:   number
  easyPct:    number
  greyPct:    number
  qualityPct: number
}

export interface IntensityResult {
  weekly:       IntensityWeekRow[]
  totals:       IntensityTotals
  skippedCount: number
  warning:      string | null
  hasData:      boolean
}

export function intensityDistribution(
  runs: RunSummary[],
  maxHr  = 190,
  restHr = 50,
  weeks  = 12,
): IntensityResult {
  const empty: IntensityResult = {
    weekly: [], totals: { easyMin: 0, greyMin: 0, qualityMin: 0, totalMin: 0, easyPct: 0, greyPct: 0, qualityPct: 0 },
    skippedCount: 0, warning: null, hasData: false,
  }
  if (!runs.length) return empty

  const hrr = maxHr - restHr
  const cutoff = new Date(Date.now() - weeks * 7 * 24 * 3600 * 1000)
  const inWindow = runs.filter(r => r.date >= cutoff)
  if (!inWindow.length) return empty

  type ZoneBucket = 'easy' | 'grey' | 'quality'
  const records: { weekStart: Date; easy: number; grey: number; quality: number }[] = []
  let skipped = 0

  for (const r of inWindow) {
    if (!r.durationSec || r.durationSec <= 0) { skipped++; continue }
    const durMin = r.durationSec / 60

    const weekStart = mondayOf(r.date)

    let bucket: ZoneBucket | null = null

    if (hrr > 0 && r.avgHr && r.avgHr > 0) {
      const hrPct = (r.avgHr - restHr) / hrr * 100
      const zcode = _hrZoneCode(hrPct)
      if (zcode === 'Z1' || zcode === 'Z2') bucket = 'easy'
      else if (zcode === 'Z3')              bucket = 'grey'
      else                                   bucket = 'quality'
    } else {
      // No HR available: skip (we don't have pace-zone fallback without VDOT context here)
      skipped++
      continue
    }

    if (!bucket) { skipped++; continue }
    records.push({
      weekStart,
      easy:    bucket === 'easy'    ? durMin : 0,
      grey:    bucket === 'grey'    ? durMin : 0,
      quality: bucket === 'quality' ? durMin : 0,
    })
  }

  if (!records.length) return { ...empty, skippedCount: skipped }

  // Weekly aggregation (group by Monday key)
  const weekMap = new Map<string, { weekStart: Date; easy: number; grey: number; quality: number }>()
  for (const rec of records) {
    const key = localISODate(rec.weekStart)
    if (!weekMap.has(key)) weekMap.set(key, { weekStart: rec.weekStart, easy: 0, grey: 0, quality: 0 })
    const w = weekMap.get(key)!
    w.easy    += rec.easy
    w.grey    += rec.grey
    w.quality += rec.quality
  }

  const pct = (v: number, total: number): number => total > 0 ? Math.round(v / total * 100 * 10) / 10 : 0

  const weekly: IntensityWeekRow[] = Array.from(weekMap.values())
    .sort((a, b) => a.weekStart.getTime() - b.weekStart.getTime())
    .map(w => {
      const totalMin = w.easy + w.grey + w.quality
      return {
        weekStart:  w.weekStart,
        easyMin:    Math.round(w.easy * 10) / 10,
        greyMin:    Math.round(w.grey * 10) / 10,
        qualityMin: Math.round(w.quality * 10) / 10,
        totalMin:   Math.round(totalMin * 10) / 10,
        easyPct:    pct(w.easy, totalMin),
        greyPct:    pct(w.grey, totalMin),
        qualityPct: pct(w.quality, totalMin),
      }
    })

  // Overall totals
  const totEasy    = records.reduce((s, r) => s + r.easy,    0)
  const totGrey    = records.reduce((s, r) => s + r.grey,    0)
  const totQuality = records.reduce((s, r) => s + r.quality, 0)
  const totAll     = totEasy + totGrey + totQuality

  const totals: IntensityTotals = {
    easyMin:    Math.round(totEasy    * 10) / 10,
    greyMin:    Math.round(totGrey    * 10) / 10,
    qualityMin: Math.round(totQuality * 10) / 10,
    totalMin:   Math.round(totAll     * 10) / 10,
    easyPct:    pct(totEasy,    totAll),
    greyPct:    pct(totGrey,    totAll),
    qualityPct: pct(totQuality, totAll),
  }

  // Coach warning — mirrors coach.py thresholds exactly
  let warning: string | null = null
  if (totAll >= 60) {  // minimum 1h data
    const { greyPct, easyPct, qualityPct } = totals
    if (greyPct >= 30) {
      warning = `Graue Zone dominiert (${Math.round(greyPct)}% der Trainingszeit). Z3-Intensität ist weder Easy genug für Erholung noch hart genug für Anpassung — reduziere M-Tempo-Läufe und ersetze sie durch echte Easy-Läufe (Z1–Z2) oder echte Qualitätseinheiten (T/I).`
    } else if (greyPct >= 20) {
      warning = `Graue Zone erhöht (${Math.round(greyPct)}%). Ziel: <15% Z3. Zu viele Läufe im Marathon-Tempo-Bereich ohne klare Intensitätsstruktur.`
    } else if (easyPct < 65) {
      warning = `Easy-Anteil zu niedrig (${Math.round(easyPct)}%, Ziel ≥80%). Zu wenig regenerative Belastung — Verletzungsrisiko und Plateaugefahr steigen.`
    } else if (qualityPct > 30) {
      warning = `Qualitäts-Anteil zu hoch (${Math.round(qualityPct)}%, Ziel ~20%). Zu viele harte Einheiten — Erholung fehlt. Ersetze 1–2 Qualitätseinheiten durch Easy-Läufe.`
    }
  }

  return { weekly, totals, skippedCount: skipped, warning, hasData: true }
}

// ── stagnationCheck ───────────────────────────────────────────────────────────
// Ports coach.py stagnation_check() faithfully.
// trendInfo only needs { delta, insufficientEffortRuns } — the subset used here.

export interface StagnationCause {
  label:    string
  detail:   string
  severity: 'warn' | 'error'
}

export interface StagnationResult {
  stagnating:    boolean
  causes:        StagnationCause[]
  primaryCause:  string | null
  recommendation: string
  trendDelta:    number
  color:         string
}

export function stagnationCheck(
  runs:           RunSummary[],
  trendInfo:      { delta: number; insufficientEffortRuns: boolean } | null,
  maxHr  = 190,
  restHr = 50,
  weeks  = 8,
  stagnationThreshold = 0.3,
  efTrend?: { deltaPct?: number; noHrData?: boolean } | null,
): StagnationResult | null {
  if (trendInfo === null) return null

  const { delta, insufficientEffortRuns } = trendInfo
  const isStagnating = !insufficientEffortRuns && delta < stagnationThreshold
  if (!isStagnating) return { stagnating: false, causes: [], primaryCause: null, recommendation: '', trendDelta: delta, color: '#e6a817' }

  const causes: StagnationCause[] = []

  // Cause A: Intensity distribution (grey zone / quality deficit)
  try {
    const intdist = intensityDistribution(runs, maxHr, restHr, weeks)
    if (intdist.hasData && intdist.totals.totalMin > 0) {
      const { greyPct, qualityPct, easyPct, totalMin } = intdist.totals
      if (greyPct >= 25) {
        causes.push({
          label:    'Zu viel Graue Zone (Z3)',
          detail:   `${Math.round(greyPct)}% der Trainingszeit in Z3 — weder Easy noch hart genug für Anpassung (80/20-Ziel: <15% Z3).`,
          severity: greyPct >= 30 ? 'error' : 'warn',
        })
      } else if (qualityPct < 8 && totalMin >= 60) {
        causes.push({
          label:    'Zu wenig Qualitätseinheiten',
          detail:   `Nur ${Math.round(qualityPct)}% Trainingszeit in T/I-Zone — fehlender Speed-Reiz bremst VDOT-Entwicklung.`,
          severity: 'warn',
        })
      } else if (easyPct < 60 && totalMin >= 60) {
        causes.push({
          label:    'Easy-Anteil zu niedrig',
          detail:   `Nur ${Math.round(easyPct)}% Easy (Ziel ≥80%) — zu wenig Erholung hemmt Anpassungsfähigkeit.`,
          severity: 'warn',
        })
      }
    }
  } catch { /* ignore */ }

  // Cause B: Volume spike — weekly km jumped >20% in last 3w vs prior 3w
  try {
    const cutoff6w = new Date(Date.now() - 6 * 7 * 24 * 3600 * 1000)
    const cutoff3w = new Date(Date.now() - 3 * 7 * 24 * 3600 * 1000)
    const oldWindow = runs.filter(r => r.date >= cutoff6w && r.date < cutoff3w)
    const newWindow = runs.filter(r => r.date >= cutoff3w)
    if (oldWindow.length > 0 && newWindow.length > 0) {
      const oldKmWk = oldWindow.reduce((s, r) => s + r.distanceKm, 0) / 3
      const newKmWk = newWindow.reduce((s, r) => s + r.distanceKm, 0) / 3
      if (oldKmWk > 0 && (newKmWk - oldKmWk) / oldKmWk >= 0.20) {
        const jumpPct = Math.round((newKmWk - oldKmWk) / oldKmWk * 100)
        causes.push({
          label:    'Volumen zu schnell gestiegen',
          detail:   `Wöchentliches Laufvolumen +${jumpPct}% in den letzten 3 Wochen — Ermüdung kann VDOT-Fortschritt kurzfristig dämpfen.`,
          severity: 'warn',
        })
      }
    }
  } catch { /* ignore */ }

  // Cause C: EF trend (when provided)
  try {
    if (efTrend && !efTrend.noHrData && efTrend.deltaPct != null) {
      if (efTrend.deltaPct <= -2.0) {
        causes.push({
          label:    'Aerobe Effizienz sinkt (EF)',
          detail:   `Efficiency Factor ${efTrend.deltaPct > 0 ? '+' : ''}${efTrend.deltaPct.toFixed(1)}% — weniger Meter pro Herzschlag bei Easy-Läufen. Ursachen: Übermüdung, Hitzephase, zu wenig Easy-Volumen.`,
          severity: 'warn',
        })
      }
    }
  } catch { /* ignore */ }

  // Fallback when no specific evidence
  if (!causes.length) {
    causes.push({
      label:    'Trainingsreiz unverändert',
      detail:   'VDOT flat — kein spezifischer Auslöser gefunden. Variiere Stimuli: füge eine Qualitätseinheit pro Woche hinzu.',
      severity: 'warn',
    })
  }

  // Build recommendation
  const recParts: string[] = causes.map(c => {
    if (c.label === 'Zu viel Graue Zone (Z3)') return 'Ersetze 1–2 Marathon-Tempo-Läufe durch echte Easy-Läufe (Z1–Z2) oder echte Qualitätseinheiten (Schwelle/Intervall).'
    if (c.label === 'Zu wenig Qualitätseinheiten') return 'Füge eine gezielte Qualitätseinheit pro Woche ein (z.B. 5×1000 m Intervall oder 20 min Schwellenlauf).'
    if (c.label === 'Easy-Anteil zu niedrig') return 'Erhöhe den Easy-Anteil auf ≥80% — harte Einheiten auf 1–2 pro Woche begrenzen.'
    if (c.label === 'Volumen zu schnell gestiegen') return 'Reduziere das Volumen für 1 Woche auf ~80% des aktuellen Niveaus (Deload-Woche).'
    if (c.label === 'Aerobe Effizienz sinkt (EF)') return 'Fokus auf echte Easy-Läufe (Z1–Z2): Pace senken bis HR stabil <70% HRR. 1–2 Wochen Deload wenn Übermüdung möglich.'
    return 'Variiere den Trainingsreiz — füge eine Qualitätseinheit hinzu oder plane eine Deload-Woche ein.'
  })

  const hasError = causes.some(c => c.severity === 'error')
  return {
    stagnating:    true,
    causes,
    primaryCause:  causes[0].label,
    recommendation: recParts.join('  ·  '),
    trendDelta:    Math.round(delta * 10) / 10,
    color:         hasError ? '#dc3545' : '#e6a817',
  }
}

// ── vdotAdherenceCheck ────────────────────────────────────────────────────────
// Ports coach.py vdot_adherence_check().
// workSplits maps activityId (string) → list of interval-lap paces (sec/km).
// No fallback to session-average pace (same as coach.py).
// workoutType 3 = Strava Workout flag (same filter as coach.py wt==3).

export interface AdherenceSession {
  date:           string
  name:           string
  targetZone:     'T' | 'I'
  targetPaceFmt:  string
  actualPaceFmt:  string
  deltaSec:       number
  verdict:        string
}

export interface AdherenceResult {
  status:        'beating' | 'missing' | 'on_target'
  sessions:      AdherenceSession[]
  nSessions:     number
  beatRatio:     number
  missRatio:     number
  avgDeltaSec:   number
  suggestedVdot: number | null
  reason:        string
  currentVdot:   number
  tPaceFmt:      string
  iPaceFmt:      string
}

export function vdotAdherenceCheck(
  runs:       RunSummary[],
  currentVdot: number,
  workSplits: Record<string, number[]> | null,
  n          = 6,
): AdherenceResult | null {
  if (!runs.length || !currentVdot || currentVdot <= 20 || currentVdot >= 85) return null
  if (!workSplits) return null

  const BEAT_THRESHOLD = 5    // s/km faster than target
  const MISS_THRESHOLD = 8    // s/km slower than target
  const MIN_SESSIONS   = 3
  const BEAT_RATIO     = 0.60
  const MISS_RATIO     = 0.60

  const paces = trainingPaces(currentVdot)
  const iSec  = paces.I
  const tSec  = paces.T
  if (!isFinite(iSec) || !isFinite(tSec)) return null

  // Cutoff: last max(n*3, 12) weeks
  const cutoffMs = Date.now() - Math.max(n * 3, 12) * 7 * 24 * 3600 * 1000
  const cutoff   = new Date(cutoffMs)

  // Quality sessions: workoutType == 3 AND distanceKm >= 2
  const candidates = runs.filter(r =>
    r.date >= cutoff &&
    r.distanceKm >= 2.0 &&
    // workoutType is not on RunSummary — we need it from the raw activity
    // WorkoutType 3 is stored on StravaActivity; RunSummary doesn't carry it.
    // We match by checking workSplits has an entry (the caller builds workSplits from wt==3 runs).
    workSplits[String(r.id)] != null
  ).sort((a, b) => b.date.getTime() - a.date.getTime()).slice(0, n)

  if (!candidates.length) return null

  const sessions: AdherenceSession[] = []
  for (const r of candidates) {
    const splits = workSplits[String(r.id)]
    if (!splits || !splits.length) continue

    const actualPace = splits.reduce((s, v) => s + v, 0) / splits.length
    const distToI    = Math.abs(actualPace - iSec)
    const distToT    = Math.abs(actualPace - tSec)
    const targetZone = distToI <= distToT ? 'I' : 'T'
    const targetPace = targetZone === 'I' ? iSec : tSec
    const delta      = actualPace - targetPace  // negative = faster

    let verdict: string
    if (delta < -BEAT_THRESHOLD)  verdict = `${Math.abs(Math.round(delta))} s/km schneller als ${targetZone}-Pace`
    else if (delta > MISS_THRESHOLD) verdict = `${Math.round(delta)} s/km langsamer als ${targetZone}-Pace`
    else                           verdict = `${targetZone}-Pace getroffen (+/-${Math.abs(Math.round(delta))} s/km)`

    sessions.push({
      date:          r.date.toLocaleDateString('de-AT', { day: '2-digit', month: '2-digit', year: '2-digit' }),
      name:          r.name.slice(0, 30),
      targetZone:    targetZone as 'T' | 'I',
      targetPaceFmt: formatPace(targetPace),
      actualPaceFmt: formatPace(actualPace),
      deltaSec:      Math.round(delta * 10) / 10,
      verdict,
    })
  }

  if (!sessions.length) return null
  if (sessions.length < MIN_SESSIONS) return null

  const deltas    = sessions.map(s => s.deltaSec)
  const avgDelta  = deltas.reduce((s, v) => s + v, 0) / deltas.length
  const nBeating  = deltas.filter(d => d < -BEAT_THRESHOLD).length
  const nMissing  = deltas.filter(d => d >  MISS_THRESHOLD).length
  const beatRatio = nBeating / sessions.length
  const missRatio = nMissing / sessions.length

  let status: AdherenceResult['status'] = 'on_target'
  let suggestedVdot: number | null = null
  let reason = ''

  if (beatRatio >= BEAT_RATIO) {
    status = 'beating'
    reason = `${nBeating} von ${sessions.length} Qualitätseinheiten ≥${BEAT_THRESHOLD} s/km schneller als Ziel-Pace — VDOT möglicherweise zu niedrig.`
    // Simple heuristic: shift VDOT up by implied improvement (avg delta scaled)
    // Full binary-search inversion (coach.py) is complex in TS; we round to +0.5 suggestion
    const implied = currentVdot + Math.min(3, Math.abs(avgDelta) / 5 * 0.5)
    const cand    = Math.round(implied * 10) / 10
    if (cand > currentVdot + 0.4) suggestedVdot = cand
  } else if (missRatio >= MISS_RATIO) {
    status = 'missing'
    reason = `${nMissing} von ${sessions.length} Qualitätseinheiten ≥${MISS_THRESHOLD} s/km langsamer als Ziel-Pace — VDOT möglicherweise zu hoch.`
    const implied = currentVdot - Math.min(3, Math.abs(avgDelta) / 8 * 0.5)
    const cand    = Math.round(implied * 10) / 10
    if (cand < currentVdot - 0.4) suggestedVdot = cand
  } else {
    reason = `Paces innerhalb der Toleranz — VDOT ${currentVdot.toFixed(1)} passt gut.`
  }

  return {
    status, sessions, nSessions: sessions.length,
    beatRatio: Math.round(beatRatio * 100) / 100,
    missRatio: Math.round(missRatio * 100) / 100,
    avgDeltaSec: Math.round(avgDelta * 10) / 10,
    suggestedVdot, reason, currentVdot,
    tPaceFmt: formatPace(tSec),
    iPaceFmt: formatPace(iSec),
  }
}

// ── aggregateStrideTrend ──────────────────────────────────────────────────────
// Ports coach.py aggregate_stride_trend().
// strideDataById maps activityId (string) → { strideCount, strides, avgPeakPaceSec }
// where strides is an array of { peakPaceSec }.

export interface StrideTrendRow {
  weekStart:        Date
  strideCount:      number
  bestPeakPaceSec:  number
  avgPeakPaceSec:   number
  sessionCount:     number
}

export interface StrideDataEntry {
  strideCount:     number
  strides:         { peakPaceSec: number }[]
  avgPeakPaceSec?: number
}

export function aggregateStrideTrend(
  strideDataById: Record<string, StrideDataEntry>,
  runs:           RunSummary[],
): StrideTrendRow[] {
  const entries = Object.entries(strideDataById)
  if (!entries.length || !runs.length) return []

  // Build id→date lookup
  const idToDate = new Map<number, Date>()
  for (const r of runs) idToDate.set(r.id, r.date)

  type Flat = { weekStart: Date; sc: number; bestPp: number; avgPp: number }
  const records: Flat[] = []

  for (const [rawId, sd] of entries) {
    if (!sd || sd.strideCount === 0) continue
    const actId = parseInt(rawId, 10)
    if (isNaN(actId)) continue

    const date = idToDate.get(actId)
    if (!date) continue

    const weekStart = mondayOf(date)
    const peakPaces = sd.strides.map(s => s.peakPaceSec).filter(p => p != null && isFinite(p))
    if (!peakPaces.length) continue

    const bestPp = Math.min(...peakPaces)
    const avgPp  = sd.avgPeakPaceSec ?? Math.round(peakPaces.reduce((s, p) => s + p, 0) / peakPaces.length)

    records.push({ weekStart, sc: sd.strideCount, bestPp, avgPp })
  }

  if (!records.length) return []

  // Aggregate by week
  const weekMap = new Map<string, { weekStart: Date; strideCount: number; bestPps: number[]; avgPps: number[]; sessionCount: number }>()
  for (const r of records) {
    const key = localISODate(r.weekStart)
    if (!weekMap.has(key)) weekMap.set(key, { weekStart: r.weekStart, strideCount: 0, bestPps: [], avgPps: [], sessionCount: 0 })
    const w = weekMap.get(key)!
    w.strideCount  += r.sc
    w.bestPps.push(r.bestPp)
    w.avgPps.push(r.avgPp)
    w.sessionCount += 1
  }

  return Array.from(weekMap.values())
    .sort((a, b) => a.weekStart.getTime() - b.weekStart.getTime())
    .map(w => ({
      weekStart:       w.weekStart,
      strideCount:     w.strideCount,
      bestPeakPaceSec: Math.min(...w.bestPps),       // fastest of the week
      avgPeakPaceSec:  Math.round(w.avgPps.reduce((s, v) => s + v, 0) / w.avgPps.length * 10) / 10,
      sessionCount:    w.sessionCount,
    }))
}
