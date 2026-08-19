// T-124: Analytics functions ported from coach.py (faithful port — same formulas/thresholds).
// Functions: intensityDistribution, stagnationCheck, vdotAdherenceCheck, aggregateStrideTrend.
// T-144: injuryRisk added — faithful port of coach.injury_risk (ACWR + CTL-Ramp).
// T-148: executionQuality, sessionExecutionQuality, dataQualityScore — faithful port of T-147.
// T-193/D-040: asymmetrische Toleranz + Zielzone aus Block-`zone` (jetzt in strava.ts
//   IntervalBlock/TempoBlock ergaenzt, faithful port von streams._pace_zone) statt workoutType.
// Cross-app guardrail: coach.py is SSoT. Any change to coach.py thresholds must be mirrored here.

import { trainingPaces, formatPace } from './vdot'
import { mondayOf, localISODate, dailyLoadSeries } from './strava'
import type { RunSummary, StravaActivity, SyncedThreshold, WorkoutClassification, ActivityStreams } from './strava'

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

// T-168: below this weekly-km baseline a Cause-B %-jump is a rounding artifact of a
// comeback after a break, not an overload signal (mirrors coach.py
// STAGNATION_VOL_MIN_BASELINE_KM_WK). Triple-digit %-jumps are capped for display —
// always a calculation artifact in a coaching context, never a meaningful statement.
const STAGNATION_VOL_MIN_BASELINE_KM_WK = 15.0
const STAGNATION_VOL_DISPLAY_CAP_PCT = 100

export interface StagnationCause {
  label:    string
  detail:   string
  severity: 'info' | 'warn' | 'error'
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
  // T-168: ACWR zone from injuryRisk(). When "underload", Cause B (volume spike) is
  // suppressed even above the baseline floor — a simultaneous "overload" + "underload"
  // verdict would be incoherent. Default undefined preserves pre-T-168 behaviour.
  acwrZone?: 'underload' | 'sweet' | 'caution' | 'high' | null,
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
        if (oldKmWk < STAGNATION_VOL_MIN_BASELINE_KM_WK) {
          // T-168: Baseline zu winzig, um einen %-Sprung als Überlastung zu deuten —
          // das ist ein normaler Wiedereinstieg nach Pause, kein Übertrainings-Signal.
          // NIE als Warnung ausgeben.
          causes.push({
            label:    'Wiedereinstieg nach Trainingspause',
            detail:   `Wochenvolumen wächst von einer niedrigen Basis (${oldKmWk.toFixed(1)} km/Woche) — das ist ein normaler Wiedereinstieg, kein Übertrainings-Signal. Der VDOT-Stillstand ist hier erwartungsgemäß und kein Warnzeichen.`,
            severity: 'info',
          })
        } else if (acwrZone === 'underload') {
          // T-168 Kohärenz-Guard: injuryRisk meldet gleichzeitig Unterlast — eine
          // Überlastungs-Warnung wäre hier ein Widerspruch im selben Atemzug.
          // Unterdrücken statt zwei sich widersprechende Signale zeigen.
        } else {
          const pctDisplay = jumpPct > STAGNATION_VOL_DISPLAY_CAP_PCT
            ? `> ${STAGNATION_VOL_DISPLAY_CAP_PCT} %`
            : `+${jumpPct}%`
          causes.push({
            label:    'Volumen zu schnell gestiegen',
            detail:   `Wöchentliches Laufvolumen ${pctDisplay} in den letzten 3 Wochen — Ermüdung kann VDOT-Fortschritt kurzfristig dämpfen.`,
            severity: 'warn',
          })
        }
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
    if (c.label === 'Wiedereinstieg nach Trainingspause') return 'Kein Handlungsbedarf — Volumen langsam weiter aufbauen, die Fitness holt den Rückstand in den nächsten Wochen von selbst auf.'
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
  avgPeakPaceSec?: number | null
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

// ── injuryRisk ────────────────────────────────────────────────────────────────
// T-144: Faithful port of coach.injury_risk (T-143).
// ACWR = 7d-EWMA / 28d-EWMA; CTL-Ramp = 42d-CTL delta over 7 calendar days.
// SSoT: coach.py constants ACWR_SWEET_LOW/HIGH, ACWR_CAUTION_HIGH, RAMP_DETRAIN, RAMP_SAFE, RAMP_CAUTION, ACWR_MIN_DAYS.

const ACWR_SWEET_LOW    = 0.8
const ACWR_SWEET_HIGH   = 1.3
const ACWR_CAUTION_HIGH = 1.5
const RAMP_DETRAIN      = -3.0
const RAMP_SAFE         = 5.0
const RAMP_CAUTION      = 8.0
const ACWR_MIN_DAYS     = 28

// T-177 Review-Nachtrag: v >= 0 (nicht > 0) — Python f"{ramp:+.1f}" liefert bei ramp===0 "+0.0"
// (explizites Vorzeichen auch bei exakt Null). Negative Werte, die auf -0.0 runden (z.B. -0.04),
// erhalten ihr Vorzeichen bereits von toFixed(1) selbst ("-0.0") — kein zusaetzliches "+" davor.
const rampStr = (v: number) => (v >= 0 ? '+' : '') + v.toFixed(1)

// T-177: isolierter Branch aus injuryRisk (faithful port coach.py:_ramp_zone, T-167).
// Getrennt exportiert, damit die Gitterpunkte unabhaengig von der EWMA-Berechnung
// getestet werden koennen. Prueft Ober- UND Untergrenze: eine stark negative Ramp
// ist Formverlust/Detraining, kein "Aufbau" (vorher faelschlich gruen).
export function rampZone(rampPerWeek: number | null): { color: string; label: string } {
  if (rampPerWeek === null) return { color: '#888888', label: '' }
  if (rampPerWeek <= RAMP_DETRAIN) {
    return { color: '#3498DB', label: `CTL ${rampStr(rampPerWeek)}/Woche — Formverlust, CTL fällt (Detraining)` }
  }
  if (rampPerWeek <= RAMP_SAFE) {
    return { color: '#2ECC71', label: `CTL ${rampStr(rampPerWeek)}/Woche — Aufbau im sicheren Bereich` }
  }
  if (rampPerWeek <= RAMP_CAUTION) {
    return { color: '#F1C40F', label: `CTL ${rampStr(rampPerWeek)}/Woche — Aufbau zügig, Steigerung dämpfen` }
  }
  return { color: '#E74C3C', label: `CTL ${rampStr(rampPerWeek)}/Woche — Aufbau zu schnell (Verletzungsrisiko)` }
}

export interface InjuryRiskResult {
  acwr:        number | null
  acwrZone:    'underload' | 'sweet' | 'caution' | 'high' | null
  acwrLabel:   string
  acwrColor:   string
  rampPerWeek: number | null
  rampLabel:   string
  rampColor:   string
  riskLevel:   'ok' | 'caution' | 'high' | 'underload' | 'insufficient'
  riskEmoji:   string
  enoughData:  boolean
}

export function injuryRisk(
  activities: StravaActivity[], ftp?: number, threshold?: SyncedThreshold,
): InjuryRiskResult {
  const neutral: InjuryRiskResult = {
    acwr: null, acwrZone: null, acwrLabel: 'Datenbasis zu kurz', acwrColor: '#888888',
    rampPerWeek: null, rampLabel: '', rampColor: '#888888',
    riskLevel: 'insufficient', riskEmoji: '⚪', enoughData: false,
  }
  if (!activities || !activities.length) return neutral
  const series = dailyLoadSeries(activities, ftp, threshold)
  // series.length - 1 = span_days (oldest-to-today inclusive means length entries = length-1 gaps)
  if (!series.length || series.length - 1 < ACWR_MIN_DAYS) return neutral

  const k7 = 1 / 7, k28 = 1 / 28, k42 = 1 / 42
  let acute = 0, chronic = 0, ctl42 = 0
  const ctl42Series: number[] = []
  for (const load of series) {
    acute   = acute   * (1 - k7)  + load * k7
    chronic = chronic * (1 - k28) + load * k28
    ctl42   = ctl42   * (1 - k42) + load * k42
    ctl42Series.push(ctl42)
  }

  // ── ACWR ──
  const acwr = chronic > 0 ? Math.round((acute / chronic) * 100) / 100 : null
  let acwrZone: InjuryRiskResult['acwrZone'], acwrColor: string, acwrLabel: string
  if (acwr === null) {
    acwrZone = null; acwrColor = '#888888'; acwrLabel = 'Keine chronische Last'
  } else if (acwr < ACWR_SWEET_LOW) {
    acwrZone = 'underload'; acwrColor = '#3498DB'
    acwrLabel = `ACWR ${acwr.toFixed(2)} — Unterlast (Detraining-Bereich)`
  } else if (acwr <= ACWR_SWEET_HIGH) {
    acwrZone = 'sweet'; acwrColor = '#2ECC71'
    acwrLabel = `ACWR ${acwr.toFixed(2)} — Sweet-Spot, Last gut balanciert`
  } else if (acwr <= ACWR_CAUTION_HIGH) {
    acwrZone = 'caution'; acwrColor = '#F1C40F'
    acwrLabel = `ACWR ${acwr.toFixed(2)} — erhöhte akute Last, beobachten`
  } else {
    acwrZone = 'high'; acwrColor = '#E74C3C'
    acwrLabel = `ACWR ${acwr.toFixed(2)} — akute Last deutlich über Chronic; 1–2 Tage zurücknehmen`
  }

  // ── CTL-Ramp (7 calendar days = ctl42[-1] − ctl42[-8]) ──
  let rampPerWeek: number | null = null
  if (ctl42Series.length >= 8) {
    rampPerWeek = Math.round((ctl42Series[ctl42Series.length - 1] - ctl42Series[ctl42Series.length - 8]) * 10) / 10
  }
  const { color: rampColor, label: rampLabel } = rampZone(rampPerWeek)

  // ── Kombiniertes Verdikt (schlechtere Ampel; Unterlast = Hinweis) ──
  const sev: Record<string, number> = { '#2ECC71': 0, '#3498DB': 0, '#F1C40F': 1, '#E74C3C': 2, '#888888': 0 }
  const worst = Math.max(sev[acwrColor] ?? 0, sev[rampColor] ?? 0)
  let riskLevel: InjuryRiskResult['riskLevel'], riskEmoji: string
  if (worst >= 2)                  { riskLevel = 'high';     riskEmoji = '🔴' }
  else if (worst === 1)            { riskLevel = 'caution';  riskEmoji = '🟡' }
  else if (acwrZone === 'underload') { riskLevel = 'underload'; riskEmoji = '🔵' }
  else                             { riskLevel = 'ok';       riskEmoji = '🟢' }

  return { acwr, acwrZone, acwrLabel, acwrColor, rampPerWeek, rampLabel, rampColor, riskLevel, riskEmoji, enoughData: true }
}

// ── T-148/T-193: Execution Quality + Data Quality ─────────────────────────────
// Faithful port of coach.execution_quality, streams.session_execution_quality, streams.data_quality_score.
// T-193/D-040: Toleranz asymmetrisch (schneller als Ziel zaehlt immer als getroffen), Zielzone
// aus der tatsaechlichen Blockintensitaet (IntervalBlock/TempoBlock.zone, T-193 auch in strava.ts
// ergaenzt) statt aus workoutType, n=1 liefert Fade/CV weiter als 0.0 (Formel-Artefakt) --
// executionBadgeParts() unten macht das UI-seitig ehrlich sichtbar statt als Messwert "0%".

const EXEC_CLEAN_INTARGET = 70, EXEC_CLEAN_FADE = 3, EXEC_CLEAN_CV = 4
const EXEC_FAIL_INTARGET = 40, EXEC_FAIL_FADE = 8
const EXEC_TOL_I = 12, EXEC_TOL_T = 20, EXEC_TOL_M = 25
const EXEC_TOL_BY_ZONE: Record<'I' | 'T' | 'M', number> = { I: EXEC_TOL_I, T: EXEC_TOL_T, M: EXEC_TOL_M }
const ZONE_SPEED_RANK: Record<'I' | 'T' | 'M', number> = { I: 3, T: 2, M: 1 }
const EXEC_LONGRUN_MIN_KM = 25, EXEC_FF_FASTER_PCT = 4
const DQ_FROZEN_S = 30, DQ_EARLY_S = 120, DQ_EARLY_BPM = 12, DQ_SPIKE_MS = 8

export interface ExecutionQualityResult {
  repFadePct: number; splitCvPct: number; timeInTargetPct: number
  nReps: number; verdict: 'sauber' | 'leicht abgebaut' | 'verfehlt'; label: string; color: string
}

export interface ExecutionBadgeParts {
  label: string; color: string; verdict: ExecutionQualityResult['verdict']
  timeInTargetPct: number; showFadeCv: boolean
  repFadePct: number; splitCvPct: number
}

/** T-193/D-040 Task 4: Bei n_reps==1 sind repFadePct/splitCvPct Formel-Artefakte (kein
 * Messwert -- es gibt nichts, wovon ein Fade oder eine Streuung abgeleitet werden koennte),
 * duerfen im UI daher NICHT als irrefuehrende "0%" gezeigt werden. Faithful port von
 * coach.execution_badge_parts. */
export function executionBadgeParts(exq: ExecutionQualityResult | SessionExecutionResult | null): ExecutionBadgeParts | null {
  if (!exq) return null
  return {
    label: exq.label, color: exq.color, verdict: exq.verdict,
    timeInTargetPct: exq.timeInTargetPct, showFadeCv: exq.nReps > 1,
    repFadePct: exq.repFadePct, splitCvPct: exq.splitCvPct,
  }
}

export interface SessionExecutionResult extends ExecutionQualityResult {
  sessionType: 'intervals' | 'tempo' | 'longrun_ff'; zone: 'I' | 'T' | 'M'
}

export interface DataQualityResult {
  score: number; reliability: 'zuverlässig' | 'eingeschränkt' | 'unzuverlässig'
  color: string; flags: string[]; frozenPct: number; hasHr: boolean; hasVelocity: boolean
}

export function executionQuality(repPaces: number[], targetPaceSec: number, toleranceSec: number): ExecutionQualityResult | null {
  const paces = (repPaces || []).filter(p => Number.isFinite(p) && p > 0)
  const n = paces.length
  if (n < 1) return null
  const mean = paces.reduce((a, b) => a + b, 0) / n
  let first: number, last: number
  if (n >= 3) {
    const third = Math.max(1, Math.floor(n / 3))
    first = paces.slice(0, third).reduce((a, b) => a + b, 0) / third
    last  = paces.slice(-third).reduce((a, b) => a + b, 0) / third
  } else { first = paces[0]; last = paces[n - 1] }
  const repFadePct = first > 0 ? Math.round((last - first) / first * 1000) / 10 : 0
  let splitCvPct = 0
  if (n >= 2 && mean > 0) {
    const variance = paces.reduce((a, p) => a + (p - mean) ** 2, 0) / n
    splitCvPct = Math.round(Math.sqrt(variance) / mean * 1000) / 10
  }
  // T-193/D-040: asymmetrisch -- schneller als das Ziel (p < target) ergibt eine negative
  // Differenz und ist damit IMMER <= der (positiven) Toleranz -> zaehlt immer als "im Ziel".
  // Nur ein Ueberschreiten der Zielpace um mehr als die Toleranz gilt als verfehlt.
  const inTarget = paces.filter(p => (p - targetPaceSec) <= toleranceSec).length
  const timeInTargetPct = Math.round(inTarget / n * 1000) / 10
  let verdict: ExecutionQualityResult['verdict'], color: string, label: string
  if (timeInTargetPct >= EXEC_CLEAN_INTARGET && repFadePct <= EXEC_CLEAN_FADE && splitCvPct <= EXEC_CLEAN_CV) {
    verdict = 'sauber'; color = '#2ECC71'; label = 'Sauber ausgeführt'
  } else if (timeInTargetPct < EXEC_FAIL_INTARGET || repFadePct > EXEC_FAIL_FADE) {
    verdict = 'verfehlt'; color = '#E74C3C'; label = 'Ziel verfehlt'
  } else { verdict = 'leicht abgebaut'; color = '#F1C40F'; label = 'Leicht abgebaut' }
  return { repFadePct, splitCvPct, timeInTargetPct, nReps: n, verdict, label, color }
}

function _fastFinishReps(streams: ActivityStreams | null | undefined, distanceKm?: number | null): number[] | null {
  const d = Number.isFinite(distanceKm as number) ? (distanceKm as number) : null
  if (d === null || d < EXEC_LONGRUN_MIN_KM || !streams) return null
  const vel = streams.velocity_smooth
  if (!vel || vel.length < 8) return null
  const n = vel.length
  // 2nd quartile (25–50%) as reference, last quartile (75–100%) as finish
  const mid = vel.slice(Math.floor(n / 4), Math.floor(n / 2))
  const lastQ = vel.slice(Math.floor(n * 0.75))
  if (!mid.length || !lastQ.length) return null
  const meanMid = mid.reduce((a, b) => a + b, 0) / mid.length
  const meanLast = lastQ.reduce((a, b) => a + b, 0) / lastQ.length
  if (meanMid <= 0 || meanLast <= 0) return null
  const paceMid = 1000 / meanMid, paceLast = 1000 / meanLast
  // faster = smaller pace; last must be >= FF% faster
  if (paceLast <= paceMid * (1 - EXEC_FF_FASTER_PCT / 100)) return [Math.round(paceMid), Math.round(paceLast)]
  return null
}

/** T-193/D-040 Task 2: haeufigste `zone` unter den Bloecken einer Schluesseleinheit; bei
 * Gleichstand konservativ die LANGSAMERE Zone (min() ueber ZONE_SPEED_RANK). null bei
 * leerer/zonenloser Blockliste -- Aufrufer faellt dann auf die alte workoutType-Zuordnung
 * zurueck (Rueckwaertskompatibilitaet fuer Bloecke ohne `zone`-Feld, z.B. handgebaute Test-
 * Objekte). Faithful port von streams._majority_block_zone. */
function _majorityBlockZone(blocks: { zone?: 'I' | 'T' | 'M' }[]): 'I' | 'T' | 'M' | null {
  const zones = (blocks || []).map(b => b.zone).filter((z): z is 'I' | 'T' | 'M' => z !== undefined)
  if (!zones.length) return null
  const counts: Record<string, number> = {}
  for (const z of zones) counts[z] = (counts[z] ?? 0) + 1
  const top = Math.max(...Object.values(counts))
  const tied = (Object.keys(counts) as ('I' | 'T' | 'M')[]).filter(z => counts[z] === top)
  return tied.reduce((a, b) => (ZONE_SPEED_RANK[b] < ZONE_SPEED_RANK[a] ? b : a))
}

export function sessionExecutionQuality(cls: WorkoutClassification | null, vdot: number | null, distanceKm?: number | null, streams?: ActivityStreams | null): SessionExecutionResult | null {
  if (!cls || !Number.isFinite(vdot as number) || (vdot as number) <= 0) return null
  const paces = trainingPaces(vdot as number)
  let reps: number[] = [], zone: 'I' | 'T' | 'M' | null = null
  let sessionType: SessionExecutionResult['sessionType'] | null = null
  // T-193/D-040 Task 2: Zielzone kommt aus der tatsaechlich gelaufenen Blockintensitaet
  // (Mehrheit der Block-`zone`-Felder, bei Gleichstand die langsamere), nicht mehr hart aus
  // workoutType. Ein einzelner Block >=180s wurde sonst stur als "tempo"/Zone T eingestuft,
  // selbst wenn er faktisch auf Intervall-Tempo (Zone I) gelaufen wurde (Realfall 18.08.).
  if (cls.workoutType === 'intervals') {
    reps = cls.intervalBlocks.map(b => b.avgPaceSec).filter(p => Number.isFinite(p) && p > 0)
    zone = _majorityBlockZone(cls.intervalBlocks) ?? 'I'; sessionType = 'intervals'
  } else if (cls.workoutType === 'tempo') {
    reps = cls.tempoBlocks.map(b => b.avgPaceSec).filter(p => Number.isFinite(p) && p > 0)
    zone = _majorityBlockZone(cls.tempoBlocks) ?? 'T'; sessionType = 'tempo'
  } else {
    // Fast-Finish-Longrun check (also on easy/mixed) -- kein Block-`zone`-Feld (ff sind reine
    // Paces), Zone bleibt "M" wie bisher.
    const ff = _fastFinishReps(streams, distanceKm)
    if (ff) { reps = ff; zone = 'M'; sessionType = 'longrun_ff' }
  }
  if (!reps.length || !zone || !sessionType) return null
  const tolerance = EXEC_TOL_BY_ZONE[zone]
  const target = paces[zone as keyof typeof paces]
  if (!Number.isFinite(target)) return null
  const res = executionQuality(reps, target, tolerance)
  if (!res) return null
  return { ...res, sessionType, zone }
}

export function dataQualityScore(streams: ActivityStreams | null): DataQualityResult {
  const flags: string[] = []
  let score = 100
  const s = streams || ({} as ActivityStreams)
  const time = s.time || []
  const hr = s.heartrate, vel = s.velocity_smooth
  const hasHr = !!(hr && hr.length), hasVelocity = !!(vel && vel.length)
  if (!hasHr) { score -= 25; flags.push('Keine HF-Daten') }
  if (!hasVelocity) { score -= 25; flags.push('Keine Pace-Daten') }

  const dur = (i0: number, i1: number) =>
    (time.length && i1 < time.length && i0 < time.length) ? time[i1] - time[i0] : i1 - i0

  // Frozen segments: longest run of identical values >= DQ_FROZEN_S
  let frozenSec = 0
  for (const [seq, name] of [[hr, 'HF'], [vel, 'Pace']] as [number[] | undefined, string][]) {
    if (!seq) continue
    let i = 0; const n = seq.length
    while (i < n - 1) {
      let j = i
      while (j < n - 1 && seq[j + 1] === seq[i]) j++
      if (j > i) {
        // Velocity == 0 = normal standstill (Ampel, Trinkpause, Auto-Pause off) — not sensor freeze.
        // Only flag non-zero constant velocity runs; HR is checked unchanged.
        const d = dur(i, j)
        if (d >= DQ_FROZEN_S && !(name === 'Pace' && seq[i] === 0)) {
          frozenSec += d; flags.push(`${name}-Sensor eingefroren (${Math.round(d)} s)`)
        }
      }
      i = j + 1
    }
  }
  const totalSec = time.length >= 2 ? time[time.length - 1] - time[0] : Math.max((hr || vel || []).length, 1)
  const frozenPct = totalSec > 0 ? Math.min(Math.round(frozenSec / totalSec * 1000) / 10, 100) : 0
  if (frozenSec > 0) score -= Math.min(frozenPct, 30)

  // Early HR artefact: first DQ_EARLY_S seconds avg >= +DQ_EARLY_BPM over median of rest
  if (hasHr && time.length && hr!.length >= 20) {
    const early = hr!.filter((_, i) => i < time.length && time[i] - time[0] <= DQ_EARLY_S)
    const rest  = hr!.filter((_, i) => i < time.length && time[i] - time[0] >  DQ_EARLY_S)
    if (early.length && rest.length) {
      const meanEarly = early.reduce((a, b) => a + b, 0) / early.length
      const srt = [...rest].sort((a, b) => a - b); const medRest = srt[Math.floor(srt.length / 2)]
      if (meanEarly - medRest >= DQ_EARLY_BPM) { score -= 10; flags.push('HF-Anlauf-Artefakt (Watch)') }
    }
  }

  // GPS spikes: velocity > DQ_SPIKE_MS AND > 3× neighbour average
  if (vel) {
    let spikes = 0
    for (let k = 1; k < vel.length - 1; k++) {
      const v = vel[k]
      if (v > DQ_SPIKE_MS) { const nb = (vel[k - 1] + vel[k + 1]) / 2; if (nb <= 0 || v > 3 * nb) spikes++ }
    }
    if (spikes > 0) { score -= Math.min(spikes / Math.max(vel.length, 1) * 100 * 3, 15); flags.push(`GPS-Aussetzer (${spikes})`) }
  }

  score = Math.max(0, Math.min(100, Math.round(score * 10) / 10))
  let reliability: DataQualityResult['reliability'], color: string
  if (score >= 80) { reliability = 'zuverlässig'; color = '#2ECC71' }
  else if (score >= 55) { reliability = 'eingeschränkt'; color = '#F1C40F' }
  else { reliability = 'unzuverlässig'; color = '#E74C3C' }
  return { score, reliability, color, flags, frozenPct, hasHr, hasVelocity }
}
