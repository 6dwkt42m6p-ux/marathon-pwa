// Inhalt: Fitness-Trends aus Laufreihen (VDOT-Trend, Best-VDOT, Efficiency Factor).
// Zweck: Ports von coach_analysis.py (vdot_trend, best_vdot_from_activities,
//   efficiency_factor_trend) — Python ist die Referenz.
// Einstieg: vdotTrendFromActivities, MIN_TREND_EFFORT_RUNS, bestVdotFromActivities,
//   efficiencyFactorTrend.
// Paritaet: vdotTrendFromActivities <-> coach.vdot_trend ist per T-194-Golden-Paar
//   gespiegelt (strava.test.ts / test_coach.py) — Aenderung nur mit beiden Seiten.
// Regeln: importiert ../vdot, ./parse, ./types.
import { vdotFromRace as _vdotFromRace, trainingPaces, effortNormalizationFactor } from '../vdot'
import { mondayOf, localISODate } from './parse'
import type { RunSummary } from './types'

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
  nEarly:                 number   // T-194: Stichprobengroessen — die UI zeigt sie
  nRecent:                number   //        statt der absoluten VDOT-Werte
  easyHrTrend?:           EasyHrTrend
}

// T-194: Mindestzahl an Effort-Laeufen JE Fensterhaelfte. Spiegelt
// coach.MIN_TREND_EFFORT_RUNS — Python ist die Referenz (CLAUDE.md).
export const MIN_TREND_EFFORT_RUNS = 3

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
    // T-086/T-120: unified boundary at <65% HRR (same as coach_analysis.py:vdot_trend).
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
  const nEarly  = earlyEffort.length
  const nRecent = recentEffort.length

  // T-194: Mindeststichprobe JE Haelfte (vorher genuegte EIN Lauf pro Haelfte).
  // Am Realdatensatz verschob ein einzelner Lauf das Verdikt um bis zu 3.1
  // VDOT-Punkte — gemeldet wurde die Zusammensetzung der Stichprobe, nicht die
  // Form. Spiegelt coach.vdot_trend.
  if (nEarly < MIN_TREND_EFFORT_RUNS || nRecent < MIN_TREND_EFFORT_RUNS) {
    if (!easyHrTrend) return null
    return {
      delta: 0, early: 0, recent: 0,
      direction: easyHrTrend.direction, label: easyHrTrend.label, color: easyHrTrend.color,
      fromTraining: true, insufficientEffortRuns: true, nEarly, nRecent, easyHrTrend,
    }
  }

  // T-194: Median je Haelfte statt Mittelwert (T-120 hatte den Mittelwert von
  // coach.py gespiegelt; coach.py nutzt jetzt den Median). Effort-Laeufe sind
  // kein homogener Typ — Intervalle, Tempolaeufe und zuegige Dauerlaeufe
  // passieren dasselbe HR-Gate, weshalb Einzelwerte weit abliegen.
  // SSoT bleibt coach.py → PWA zieht nach.
  const threshold = currentVdot * 0.82
  const medianVdot = (list: typeof withVdot): number => {
    if (!list.length) return 0
    const xs = list.map(r => r.computedVdot).sort((a, b) => a - b)
    const mid = Math.floor(xs.length / 2)
    return xs.length % 2 === 0 ? (xs[mid - 1] + xs[mid]) / 2 : xs[mid]
  }

  // T-194-Nachzug: delta MUSS aus den UNGERUNDETEN Medianen kommen. Vorher wurde
  // es aus `recent - early` gebildet, also aus bereits auf 0.1 gerundeten Werten —
  // das wich in bis zu 0.1 VDOT von coach.vdot_trend ab (dort: erst Differenz,
  // dann runden). Betroffen war ausgerechnet die Zahl im Trend-Badge. Gefunden
  // von den erweiterten Golden-Faellen, nicht vom urspruenglichen Einzelpaar.
  const recentRaw = medianVdot(recentEffort)
  const earlyRaw  = medianVdot(earlyEffort)
  const recent = Math.round(recentRaw * 10) / 10
  const early  = Math.round(earlyRaw * 10) / 10
  const delta  = Math.round((recentRaw - earlyRaw) * 10) / 10

  const fromTraining           = earlyEffort.filter(r => r.computedVdot >= threshold).length < 2 ||
                                  recentEffort.filter(r => r.computedVdot >= threshold).length < 2
  const insufficientEffortRuns = false

  let direction: '↑' | '↓' | '→', label: string, color: string
  if (delta >= 0.3)       { direction = '↑'; label = `+${delta} VDOT`;      color = '#4CAF50' }
  else if (delta <= -0.3) { direction = '↓'; label = `${delta} VDOT`;       color = '#e53935' }
  else                    { direction = '→'; label = 'Stabiler VDOT-Trend'; color = '#FFC107' }

  return { delta, early, recent, direction, label, color, fromTraining, insufficientEffortRuns, nEarly, nRecent, easyHrTrend }
}

export interface BestVdotResult {
  vdot:       number
  name:       string
  distanceKm: number
  paceFmt:    string
  date:       Date
}

/**
 * Best-effort VDOT estimate — faithful port of coach_analysis.py:best_vdot_from_activities (T-186).
 * Before T-186, the (since removed, T-258) StravaSync.tsx computed the displayed VDOT on raw, uncorrected times
 * (no GAP/Hitze), diverging from the Desktop by up to 1.6 points and even picking a
 * different "best" run.
 *
 * Window: 12 weeks. Min distance 3 km. Raw pace guard 180–420 s/km (data-quality bound
 * on pace_sec_km, mirrors coach.py's DataFrame filter — excludes GPS/sensor artifacts
 * before normalization even runs). Normalize FIRST (durationSec / effortNormalizationFactor),
 * THEN compute VDOT — order matters (T-186 AC). Plausibility 20 < VDOT < 85.
 * Robust estimate = median of the top-3 normalized VDOTs (guards against a one-off outlier
 * inflating the number). T-219 (coach_analysis.py:best_vdot_from_activities, T-194): the displayed run/pace/date come
 * from the effort whose OWN VDOT is closest to that median — searched across ALL efforts,
 * not just the top-3 — so the shown workout is the one that actually produced the reported
 * number. Before T-219, metadata came from the single fastest effort (`efforts[0]`) while the
 * number was the median of the top-3: the UI could name a run that never produced the shown VDOT.
 */
export function bestVdotFromActivities(runs: RunSummary[]): BestVdotResult | null {
  const cutoff = new Date(Date.now() - 12 * 7 * 24 * 3600 * 1000)
  const candidates = runs.filter(r =>
    r.date >= cutoff && r.distanceKm >= 3.0 && r.durationSec > 0 &&
    Number.isFinite(r.paceSec) && r.paceSec > 180 && r.paceSec < 420
  )
  if (candidates.length === 0) return null

  const efforts: { v: number; r: RunSummary }[] = []
  for (const r of candidates) {
    try {
      const factor  = effortNormalizationFactor(r.distanceKm, r.elevationM, r.tempC)
      const normDur = r.durationSec / factor   // flach+kühl-äquivalent (schneller)
      const v = _vdotFromRace(r.distanceKm * 1000, normDur)
      if (v > 20 && v < 85) efforts.push({ v, r })
    } catch { /* malformed row — skip, mirrors coach.py's except Exception: continue */ }
  }
  if (efforts.length === 0) return null

  efforts.sort((a, b) => b.v - a.v)
  const top3   = efforts.slice(0, 3).map(e => e.v)
  const sorted = [...top3].sort((a, b) => a - b)
  const mid    = Math.floor(sorted.length / 2)
  const medianV = sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2

  // T-219: closest-to-median search over the FULL efforts list (coach.py's `min(efforts, ...)`
  // iterates all efforts, not just the top-3). On a tie, keep the earliest match in the
  // (desc-sorted) list — mirrors Python's `min()`, which keeps the first minimal element.
  let bestEffort = efforts[0]
  let bestDiff   = Math.abs(efforts[0].v - medianV)
  for (const e of efforts) {
    const diff = Math.abs(e.v - medianV)
    if (diff < bestDiff) {
      bestDiff   = diff
      bestEffort = e
    }
  }
  const best = bestEffort.r
  return {
    vdot:       Math.round(medianV * 10) / 10,
    name:       best.name,
    distanceKm: best.distanceKm,
    paceFmt:    best.paceFmt,
    date:       best.date,
  }
}

// ── Efficiency Factor trend (Friel EF) — faithful port of coach_analysis.py:efficiency_factor_trend ───────

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
