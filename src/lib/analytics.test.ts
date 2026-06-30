// T-124: Tests for four new analytics functions
// Test-first approach: expected values derived from coach.py formulas, not from the TS implementation.

import { describe, it, expect } from 'vitest'
import {
  intensityDistribution,
  stagnationCheck,
  vdotAdherenceCheck,
  aggregateStrideTrend,
  injuryRisk,
} from './analytics'
import { trainingPaces } from './vdot'
import { dailyLoadSeries } from './strava'
import type { RunSummary, StravaActivity } from './strava'

// ── T-144: injuryRisk helpers ─────────────────────────────────────────────────

function _act(daysAgo: number, suffer: number, id: number): StravaActivity {
  const d = new Date(); d.setDate(d.getDate() - daysAgo); d.setHours(8, 0, 0, 0)
  return {
    id, name: `a${id}`, type: 'Run', sport_type: 'Run',
    start_date: d.toISOString(), start_date_local: d.toISOString(),
    distance: 10000, moving_time: 3600, elapsed_time: 3600,
    total_elevation_gain: 0, suffer_score: suffer,
  } as unknown as StravaActivity
}

function _steady(loadPerDay: number, days: number): StravaActivity[] {
  const out: StravaActivity[] = []
  for (let d = 0; d < days; d++) out.push(_act(d, loadPerDay, d + 1))
  return out
}

// ── T-144: injuryRisk tests ───────────────────────────────────────────────────

describe('injuryRisk', () => {
  it('steady load → ACWR ~1, sweet', () => {
    const r = injuryRisk(_steady(50, 80))
    expect(r.enoughData).toBe(true)
    expect(r.acwr).not.toBeNull()
    expect(r.acwr!).toBeGreaterThanOrEqual(0.9)
    expect(r.acwr!).toBeLessThanOrEqual(1.15)
    expect(r.acwrZone).toBe('sweet')
  })

  it('acwr matches coupled EWMA formula (cross-app fidelity)', () => {
    const acts: StravaActivity[] = []
    for (let d = 0; d < 35; d++) acts.push(_act(d, 40 + d, d + 1))
    const series = dailyLoadSeries(acts)
    const ewma = (k: number) => series.reduce((v, load) => v * (1 - k) + load * k, 0)
    const expected = ewma(1 / 7) / ewma(1 / 28)
    const r = injuryRisk(acts)
    expect(Math.abs(r.acwr! - expected)).toBeLessThan(0.02)
  })

  it('acute spike → high risk', () => {
    const acts: StravaActivity[] = []
    for (let d = 7; d < 40; d++) acts.push(_act(d, 20, d + 1))
    for (let d = 0; d < 5; d++) acts.push(_act(d, 120, 100 + d))
    const r = injuryRisk(acts)
    expect(r.acwr!).toBeGreaterThan(1.5)
    expect(r.acwrZone).toBe('high')
    expect(r.riskLevel).toBe('high')
  })

  it('flat load → ramp safe green', () => {
    const r = injuryRisk(_steady(50, 90))
    expect(r.rampPerWeek).not.toBeNull()
    expect(r.rampPerWeek!).toBeLessThanOrEqual(5)
    expect(r.rampColor).toBe('#2ECC71')
  })

  it('steep recent build → ramp red', () => {
    const acts: StravaActivity[] = []
    for (let d = 8; d < 60; d++) acts.push(_act(d, 10, d + 1))
    for (let d = 0; d < 8; d++) acts.push(_act(d, 200, 100 + d))
    const r = injuryRisk(acts)
    expect(r.rampPerWeek!).toBeGreaterThan(8)
    expect(r.rampColor).toBe('#E74C3C')
  })

  it('< 28 days → insufficient', () => {
    const r = injuryRisk(_steady(50, 10))
    expect(r.enoughData).toBe(false)
    expect(r.riskLevel).toBe('insufficient')
  })

  it('empty → enoughData false, acwr null', () => {
    const r = injuryRisk([])
    expect(r.enoughData).toBe(false)
    expect(r.acwr).toBeNull()
  })
})

// ── Helpers ──────────────────────────────────────────────────────────────────

let _idCounter = 1
function makeRun(opts: {
  id?: number
  date?: Date
  distanceKm?: number
  durationSec?: number
  avgHr?: number
  workoutType?: number
}): RunSummary {
  const distanceKm = opts.distanceKm ?? 10
  const durationSec = opts.durationSec ?? 3600
  return {
    id: opts.id ?? _idCounter++,
    name: 'Test run',
    date: opts.date ?? new Date(),
    distanceKm,
    durationSec,
    paceSec: distanceKm > 0 ? durationSec / distanceKm : 360,
    paceFmt: '6:00',
    avgHr: opts.avgHr,
    elevationM: 0,
  }
}

function weeksAgo(n: number): Date {
  return new Date(Date.now() - n * 7 * 24 * 3600 * 1000)
}

// ── intensityDistribution ────────────────────────────────────────────────────

describe('intensityDistribution', () => {
  it('returns hasData=false for empty input', () => {
    const result = intensityDistribution([], 190, 50)
    expect(result.hasData).toBe(false)
    expect(result.skippedCount).toBe(0)
  })

  it('returns hasData=false for activities outside 12-week window', () => {
    const oldRun = makeRun({ date: weeksAgo(14), avgHr: 140, durationSec: 3600 })
    const result = intensityDistribution([oldRun], 190, 50)
    expect(result.hasData).toBe(false)
  })

  it('classifies Easy run (<70% HRR) into easy bucket', () => {
    // maxHr=190, restHr=50, hrr=140. Z1/Z2 = HRR < 70% → HR < 50+98=148
    // avgHr=130 → HRR pct = (130-50)/140*100 = 57.1% → Z1 → easy
    const run = makeRun({ date: weeksAgo(1), avgHr: 130, durationSec: 3600 })
    const result = intensityDistribution([run], 190, 50)
    expect(result.hasData).toBe(true)
    expect(result.totals.easyPct).toBeGreaterThan(90)
    expect(result.totals.greyPct).toBe(0)
    expect(result.totals.qualityPct).toBe(0)
  })

  it('classifies Grey Zone run (70–80% HRR) into grey bucket', () => {
    // avgHr=155: HRR pct = (155-50)/140*100 = 75% → Z3 → grey
    const run = makeRun({ date: weeksAgo(1), avgHr: 155, durationSec: 3600 })
    const result = intensityDistribution([run], 190, 50)
    expect(result.hasData).toBe(true)
    expect(result.totals.greyPct).toBeGreaterThan(90)
  })

  it('classifies Quality run (>=80% HRR) into quality bucket', () => {
    // avgHr=165: HRR pct = (165-50)/140*100 = 82.1% → Z4 → quality
    const run = makeRun({ date: weeksAgo(1), avgHr: 165, durationSec: 3600 })
    const result = intensityDistribution([run], 190, 50)
    expect(result.hasData).toBe(true)
    expect(result.totals.qualityPct).toBeGreaterThan(90)
  })

  it('emits grey zone warning when grey >= 30%', () => {
    // 2 easy runs 60min each + 1 grey run 60min + 1 quality 20min
    // grey total=60min, all total=200min → grey%=30%
    const runs = [
      makeRun({ date: weeksAgo(1), avgHr: 130, durationSec: 3600 }),
      makeRun({ date: weeksAgo(1), avgHr: 130, durationSec: 3600 }),
      makeRun({ date: weeksAgo(1), avgHr: 155, durationSec: 3600 }), // grey
      makeRun({ date: weeksAgo(1), avgHr: 165, durationSec: 1200 }), // quality 20min
    ]
    const result = intensityDistribution(runs, 190, 50)
    expect(result.hasData).toBe(true)
    expect(result.totals.greyPct).toBeCloseTo(30, 0)
    expect(result.warning).toBeTruthy()
    expect(result.warning).toContain('Graue Zone')
  })

  it('zone percentages sum to ~100', () => {
    const runs = [
      makeRun({ date: weeksAgo(1), avgHr: 130, durationSec: 3600 }),
      makeRun({ date: weeksAgo(1), avgHr: 155, durationSec: 1800 }),
      makeRun({ date: weeksAgo(1), avgHr: 165, durationSec: 1800 }),
    ]
    const result = intensityDistribution(runs, 190, 50)
    const total = (result.totals.easyPct ?? 0) + (result.totals.greyPct ?? 0) + (result.totals.qualityPct ?? 0)
    expect(total).toBeCloseTo(100, 0)
  })
})

// ── stagnationCheck ──────────────────────────────────────────────────────────

describe('stagnationCheck', () => {
  it('returns null when trendInfo is null', () => {
    expect(stagnationCheck([], null, 190, 50)).toBeNull()
  })

  it('returns { stagnating: false } when delta > threshold (0.3)', () => {
    const result = stagnationCheck([], { delta: 1.5, insufficientEffortRuns: false }, 190, 50)
    expect(result).not.toBeNull()
    expect(result!.stagnating).toBe(false)
  })

  it('returns stagnating=true and at least one cause when delta < threshold', () => {
    // Grey-zone heavy load so cause A fires
    const runs = [
      makeRun({ date: weeksAgo(1), avgHr: 155, durationSec: 3600 }),
      makeRun({ date: weeksAgo(2), avgHr: 155, durationSec: 3600 }),
      makeRun({ date: weeksAgo(3), avgHr: 155, durationSec: 3600 }),
    ]
    const result = stagnationCheck(runs, { delta: 0.1, insufficientEffortRuns: false }, 190, 50)
    expect(result!.stagnating).toBe(true)
    expect(result!.causes.length).toBeGreaterThanOrEqual(1)
    expect(result!.recommendation).toBeTruthy()
    // color: warn (#e6a817) or error (#dc3545) — must be one of those
    expect(['#e6a817', '#dc3545']).toContain(result!.color)
  })

  it('returns stagnating=true when delta is negative', () => {
    const result = stagnationCheck([], { delta: -0.5, insufficientEffortRuns: false }, 190, 50)
    expect(result!.stagnating).toBe(true)
  })

  it('detects volume spike cause (>20% increase last 3w vs prior 3w)', () => {
    // prior 3w: 30km/week average; recent 3w: 40km/week average → +33% spike
    const prior = Array.from({ length: 9 }, (_, i) => makeRun({
      date: weeksAgo(4 + Math.floor(i / 3)),
      distanceKm: 10,
      durationSec: 3600,
    }))
    const recent = [
      makeRun({ date: weeksAgo(1), distanceKm: 40, durationSec: 14400 }),
      makeRun({ date: weeksAgo(2), distanceKm: 40, durationSec: 14400 }),
      makeRun({ date: weeksAgo(3), distanceKm: 40, durationSec: 14400 }),
    ]
    const result = stagnationCheck([...prior, ...recent], { delta: 0.0, insufficientEffortRuns: false }, 190, 50)
    expect(result!.stagnating).toBe(true)
    const volumeCause = result!.causes.find(c => c.label.includes('Volumen'))
    expect(volumeCause).toBeDefined()
  })

  it('returns fallback cause when no specific evidence is found', () => {
    // Empty run list → no cause evidence → fallback
    const result = stagnationCheck([], { delta: 0.0, insufficientEffortRuns: false }, 190, 50)
    expect(result!.stagnating).toBe(true)
    expect(result!.causes.length).toBeGreaterThanOrEqual(1)
  })
})

// ── vdotAdherenceCheck ───────────────────────────────────────────────────────

describe('vdotAdherenceCheck', () => {
  it('returns null for empty activities', () => {
    expect(vdotAdherenceCheck([], 48, {})).toBeNull()
  })

  it('returns null when workSplits is null', () => {
    const run = makeRun({ date: weeksAgo(1), workoutType: 3, distanceKm: 10 })
    expect(vdotAdherenceCheck([run], 48, null)).toBeNull()
  })

  it('returns null when fewer than 3 quality sessions have splits', () => {
    const runs = [
      makeRun({ id: 100, date: weeksAgo(1), distanceKm: 10, workoutType: 3 }),
      makeRun({ id: 101, date: weeksAgo(2), distanceKm: 10, workoutType: 3 }),
    ]
    const result = vdotAdherenceCheck(runs, 48, { '100': [230], '101': [230] })
    expect(result).toBeNull()
  })

  it('detects beating status when >=60% sessions beat target by >5 s/km', () => {
    // VDOT 48: trainingPaces gives I-pace. Beat by 10 s/km = clearly beating
    const vdot = 48
    const paces = trainingPaces(vdot)
    const fastPace = paces.I - 10  // 10 s/km faster than I-pace
    const runs = [
      makeRun({ id: 200, date: weeksAgo(1), distanceKm: 10, workoutType: 3 }),
      makeRun({ id: 201, date: weeksAgo(2), distanceKm: 10, workoutType: 3 }),
      makeRun({ id: 202, date: weeksAgo(3), distanceKm: 10, workoutType: 3 }),
    ]
    const splits: Record<string, number[]> = {
      '200': [fastPace, fastPace],
      '201': [fastPace, fastPace],
      '202': [fastPace, fastPace],
    }
    const result = vdotAdherenceCheck(runs, vdot, splits)
    expect(result).not.toBeNull()
    expect(result!.status).toBe('beating')
    expect(result!.nSessions).toBe(3)
  })

  it('detects missing status when >=60% sessions miss target by >8 s/km', () => {
    // Use T-pace + 15 s/km so the pace is closer to T (slower zone) and delta = 15 > MISS_THRESHOLD(8)
    // For VDOT 48: T-pace ~229, I-pace ~216. Using tSec+15=244: distToT=15, distToI=28 → zone T, delta=15 > 8
    const vdot = 48
    const paces = trainingPaces(vdot)
    const slowPace = paces.T + 15  // 15 s/km slower than T-pace → misses MISS_THRESHOLD(8)
    const runs = [
      makeRun({ id: 300, date: weeksAgo(1), distanceKm: 10, workoutType: 3 }),
      makeRun({ id: 301, date: weeksAgo(2), distanceKm: 10, workoutType: 3 }),
      makeRun({ id: 302, date: weeksAgo(3), distanceKm: 10, workoutType: 3 }),
    ]
    const splits = { '300': [slowPace], '301': [slowPace], '302': [slowPace] }
    const result = vdotAdherenceCheck(runs, vdot, splits)
    expect(result!.status).toBe('missing')
  })

  it('returns on_target when deltas are within tolerance', () => {
    const vdot = 48
    const paces = trainingPaces(vdot)
    const runs = [
      makeRun({ id: 400, date: weeksAgo(1), distanceKm: 10, workoutType: 3 }),
      makeRun({ id: 401, date: weeksAgo(2), distanceKm: 10, workoutType: 3 }),
      makeRun({ id: 402, date: weeksAgo(3), distanceKm: 10, workoutType: 3 }),
    ]
    // within ±4 s/km of I-pace
    const splits = {
      '400': [paces.I + 2],
      '401': [paces.I - 2],
      '402': [paces.I + 1],
    }
    const result = vdotAdherenceCheck(runs, vdot, splits)
    expect(result!.status).toBe('on_target')
  })
})

// ── aggregateStrideTrend ─────────────────────────────────────────────────────

describe('aggregateStrideTrend', () => {
  it('returns empty array for no stride data', () => {
    expect(aggregateStrideTrend({}, [])).toHaveLength(0)
  })

  it('returns empty array when stride_count is 0', () => {
    const run = makeRun({ id: 500, date: weeksAgo(1) })
    expect(aggregateStrideTrend({ '500': { strideCount: 0, strides: [] } }, [run])).toHaveLength(0)
  })

  it('aggregates strides in the same week into one row', () => {
    // Deterministisch dieselbe ISO-Woche (Mo + Mi einer vergangenen Woche),
    // unabhängig vom heutigen Wochentag. now-1/now-2 würden sonst je nach
    // Wochentag die Wochengrenze straddeln (gotchas#test-zeitberechnungen, T-109).
    const monday = new Date()
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7) - 14) // Montag vor 2 Wochen
    monday.setHours(12, 0, 0, 0)
    const d1 = new Date(monday)                               // Montag
    const d2 = new Date(monday); d2.setDate(d2.getDate() + 2) // Mittwoch (gleiche Woche)

    const run1 = makeRun({ id: 600, date: d1 })
    const run2 = makeRun({ id: 601, date: d2 })

    const strideData = {
      '600': { strideCount: 3, strides: [{ peakPaceSec: 210 }, { peakPaceSec: 215 }, { peakPaceSec: 220 }], avgPeakPaceSec: 215 },
      '601': { strideCount: 2, strides: [{ peakPaceSec: 205 }, { peakPaceSec: 210 }], avgPeakPaceSec: 208 },
    }
    const result = aggregateStrideTrend(strideData, [run1, run2])
    // Both in same week → 1 row
    expect(result).toHaveLength(1)
    expect(result[0].strideCount).toBe(5)       // 3+2
    expect(result[0].bestPeakPaceSec).toBe(205) // min(210,215,220,205,210)=205
    expect(result[0].sessionCount).toBe(2)
  })

  it('groups strides from different weeks into separate rows', () => {
    const run1 = makeRun({ id: 700, date: weeksAgo(2) })
    const run2 = makeRun({ id: 701, date: weeksAgo(1) })
    const strideData = {
      '700': { strideCount: 2, strides: [{ peakPaceSec: 200 }, { peakPaceSec: 205 }], avgPeakPaceSec: 203 },
      '701': { strideCount: 3, strides: [{ peakPaceSec: 195 }, { peakPaceSec: 198 }, { peakPaceSec: 202 }], avgPeakPaceSec: 198 },
    }
    const result = aggregateStrideTrend(strideData, [run1, run2])
    expect(result).toHaveLength(2)
    expect(result[0].strideCount).toBe(2) // older week
    expect(result[1].strideCount).toBe(3) // newer week
  })
})
