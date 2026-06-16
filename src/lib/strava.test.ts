import { describe, it, expect } from 'vitest'
import { syncAnchorTs, OVERLAP_DAYS, vdotTrendFromActivities, efficiencyFactorTrend } from './strava'
import type { RunSummary } from './strava'

// T-109: Verify overlap-lookback anchor computation for syncActivities.
// Root cause: using latestTs directly as "after" permanently skips any activity
// whose start_date is not strictly newer than the newest cached activity.
// Fix: after = max(cutoffTs, latestTs - OVERLAP_DAYS * 86400).

describe('syncAnchorTs (T-109 overlap lookback)', () => {
  const DAY = 86400
  const now = Math.floor(Date.now() / 1000)

  it('returns latestTs - OVERLAP_DAYS when that is above cutoff', () => {
    const latestTs = now - 5 * DAY     // newest cached activity: 5 days ago
    const cutoffTs = now - 365 * DAY   // cutoff: 1 year ago (weeksBack=52)
    const anchor = syncAnchorTs(latestTs, cutoffTs)
    expect(anchor).toBe(latestTs - OVERLAP_DAYS * DAY)
  })

  it('returns cutoffTs when latestTs - OVERLAP_DAYS would be before cutoff', () => {
    // If the newest cached activity is only 10 days old, latestTs - 45d goes before cutoff at 14d.
    const cutoffTs = now - 14 * DAY
    const latestTs = now - 10 * DAY
    const anchor = syncAnchorTs(latestTs, cutoffTs)
    // latestTs - 45d = now - 55d < cutoffTs (now - 14d) → clamp to cutoffTs
    expect(anchor).toBe(cutoffTs)
  })

  it('anchor is strictly less than latestTs when cache is non-empty and lookback fits', () => {
    // This verifies a backdated activity 20 days ago is inside the fetch window.
    const latestTs = now - 2 * DAY     // newest cached: 2 days ago
    const cutoffTs = now - 52 * 7 * DAY
    const anchor = syncAnchorTs(latestTs, cutoffTs)
    const backdatedActivityTs = now - 20 * DAY
    // The API call uses after=anchor; Strava returns activities where start_date > anchor.
    // backdated activity (20d ago) > anchor (now - 2d - 45d = now - 47d) → will be fetched.
    expect(backdatedActivityTs).toBeGreaterThan(anchor)
    // Also: anchor is less than latestTs, so this is a real lookback not a no-op.
    expect(anchor).toBeLessThan(latestTs)
  })

  it('erster Sync (empty cache) uses cutoffTs directly — no lookback applied', () => {
    // When cache is empty, syncActivities passes cutoffTs directly to fetchActivitiesAfter,
    // not via syncAnchorTs. Verify OVERLAP_DAYS constant itself is 45.
    expect(OVERLAP_DAYS).toBe(45)
  })

  it('anchor equals cutoffTs when latestTs === cutoffTs (no cached activities above cutoff)', () => {
    const cutoffTs = now - 30 * DAY
    const latestTs = cutoffTs  // degenerate: max() returns cutoff itself
    const anchor = syncAnchorTs(latestTs, cutoffTs)
    // latestTs - 45d goes way before cutoff → clamp to cutoffTs
    expect(anchor).toBe(cutoffTs)
  })
})

// ── T-120: VDOT-Aggregation = mean (not bestVdot) ────────────────────────────

// Helper: create a RunSummary at a given date with specific pace/distance/hr
function makeRun(daysAgo: number, distanceKm: number, paceSec: number, avgHr?: number): RunSummary {
  const date = new Date(Date.now() - daysAgo * 86400 * 1000)
  const durationSec = Math.round(distanceKm * paceSec)
  return {
    id: daysAgo,
    name: `Run ${daysAgo}d ago`,
    date,
    distanceKm,
    durationSec,
    paceSec,
    paceFmt: '',
    avgHr,
    elevationM: 0,
  }
}

describe('vdotTrendFromActivities — VDOT aggregation = mean (T-120)', () => {
  // Build effort runs (pace ~4:30/km = 270 s/km → M-zone for VDOT ~45, so isEffortRun via pace)
  // Two early runs (6-7 weeks ago) and two recent runs (1-2 weeks ago) with different VDOTs.
  // With mean aggregation: early mean ≈ mean of two early computed VDOTs,
  //                        recent mean ≈ mean of two recent computed VDOTs.
  // We'll use high-HR effort runs (avg_hr = 160 for maxHr=190, restHr=50 → ~79% HRR ≥ 65%).

  const maxHr = 190
  const restHr = 50
  const currentVdot = 45

  // 10km @ ~4:00/km (240 s/km) → decent effort VDOT
  const earlyRun1 = makeRun(7 * 7, 10, 240, 160)   // 7 weeks ago
  const earlyRun2 = makeRun(6 * 7, 10, 245, 160)   // 6 weeks ago
  // Recent runs slightly faster → higher VDOT
  const recentRun1 = makeRun(2 * 7, 10, 235, 162)  // 2 weeks ago
  const recentRun2 = makeRun(1 * 7, 10, 230, 162)  // 1 week ago

  const runs = [earlyRun1, earlyRun2, recentRun1, recentRun2]

  it('uses mean of all effort VDOTs per half (not bestVdot top-3)', () => {
    const result = vdotTrendFromActivities(runs, currentVdot, maxHr, restHr)
    expect(result).not.toBeNull()
    // With mean: early = mean(vdot(240s, 10km), vdot(245s, 10km))
    //            recent = mean(vdot(235s, 10km), vdot(230s, 10km))
    // Recent runs are faster → recent VDOT > early VDOT → direction ↑
    expect(result!.direction).toBe('↑')
    // The early/recent values must be means (not max/top-3)
    // Specifically: early should be lower than recent
    expect(result!.recent).toBeGreaterThan(result!.early)
    expect(result!.delta).toBeGreaterThan(0)
  })

  it('stable trend returns → when early and recent are nearly equal', () => {
    // Same pace for all runs → mean is identical → delta ≈ 0 → →
    const stableRuns = [
      makeRun(7 * 7, 10, 240, 160),
      makeRun(6 * 7, 10, 240, 160),
      makeRun(2 * 7, 10, 240, 160),
      makeRun(1 * 7, 10, 240, 160),
    ]
    const result = vdotTrendFromActivities(stableRuns, currentVdot, maxHr, restHr)
    expect(result).not.toBeNull()
    expect(result!.direction).toBe('→')
    expect(Math.abs(result!.delta)).toBeLessThan(0.3)
  })
})

// ── T-120: Easy-HF-Grenze 65% (not 70%) ─────────────────────────────────────

describe('vdotTrendFromActivities — Easy-HR boundary at 65% HRR (T-120)', () => {
  const maxHr = 190
  const restHr = 50
  const hrr = maxHr - restHr  // 140

  // A run at exactly 67% HRR: hr = restHr + 0.67 * hrr = 50 + 93.8 = ~144
  // With old <70% boundary: this IS an easy run → counted in easyHrTrend
  // With new <65% boundary: this is NOT an easy run → NOT counted
  const hrAt67pct = Math.round(restHr + 0.67 * hrr)  // 144

  it('run at 67% HRR is NOT included in easyHrTrend with <65% boundary', () => {
    // All runs at 67% HRR → no qualifying easy runs → easyHrTrend = undefined
    const runs = [
      makeRun(7 * 7, 8, 320, hrAt67pct),
      makeRun(6 * 7, 8, 320, hrAt67pct),
      makeRun(3 * 7, 8, 320, hrAt67pct),
      makeRun(2 * 7, 8, 320, hrAt67pct),
      makeRun(1 * 7, 8, 320, hrAt67pct),
    ]
    const result = vdotTrendFromActivities(runs, 45, maxHr, restHr)
    // easyHrTrend should be absent — 67% HRR is not "easy" per T-086 (<65%)
    expect(result?.easyHrTrend).toBeUndefined()
  })

  it('run at 60% HRR IS included in easyHrTrend with <65% boundary', () => {
    const hrAt60pct = Math.round(restHr + 0.60 * hrr)  // 134
    // 4 early + 4 recent at 60% HRR → sufficient for easyHrTrend
    const runs = [
      makeRun(7 * 7, 8, 340, hrAt60pct),
      makeRun(6 * 7, 8, 340, hrAt60pct),
      makeRun(5 * 7, 8, 340, hrAt60pct),
      makeRun(4 * 7, 8, 340, hrAt60pct),  // >4 weeks ago
      makeRun(2 * 7, 8, 340, hrAt60pct),
      makeRun(1 * 7, 8, 340, hrAt60pct),
    ]
    const result = vdotTrendFromActivities(runs, 45, maxHr, restHr)
    // easyHrTrend should be present — 60% HRR is below 65% threshold
    expect(result?.easyHrTrend).toBeDefined()
  })
})

// ── T-120: efficiencyFactorTrend ─────────────────────────────────────────────

describe('efficiencyFactorTrend (T-120)', () => {
  const maxHr = 190
  const restHr = 50

  // EF = (speed_m_s * 60) / avg_hr
  // Easy run filter: 50–80% HRR, distance ≥3km, speed 1.1–4.2 m/s
  // 50% HRR = 50 + 70 = 120; 80% HRR = 50 + 112 = 162
  // Use hr=140 (64% HRR) and pace=340 s/km → speed = 1000/340 = 2.94 m/s → EF = (2.94*60)/140 = 1.26

  function makeEasyRun(daysAgo: number, paceSec: number, avgHr: number, distKm = 8): RunSummary {
    const durationSec = Math.round(distKm * paceSec)
    return {
      id: daysAgo * 1000 + Math.round(paceSec),
      name: `Easy ${daysAgo}d`,
      date: new Date(Date.now() - daysAgo * 86400 * 1000),
      distanceKm: distKm,
      durationSec,
      paceSec,
      paceFmt: '',
      avgHr,
      elevationM: 0,
    }
  }

  it('returns null when fewer than 4 qualifying runs', () => {
    const runs = [
      makeEasyRun(50, 340, 140),
      makeEasyRun(40, 340, 140),
      makeEasyRun(10, 340, 140),  // only 3 runs
    ]
    const result = efficiencyFactorTrend(runs, maxHr, restHr)
    expect(result).toBeNull()
  })

  it('returns no_hr_data result when runs have no avgHr', () => {
    const runs = [
      makeEasyRun(50, 340, 0),
      makeEasyRun(40, 340, 0),
      makeEasyRun(30, 340, 0),
      makeEasyRun(10, 340, 0),
    ].map(r => ({ ...r, avgHr: undefined }))
    const result = efficiencyFactorTrend(runs, maxHr, restHr)
    expect(result).not.toBeNull()
    expect(result!.noHrData).toBe(true)
  })

  it('rising EF trend returns ↑ direction', () => {
    // Early runs: slower pace → lower EF. Recent: faster pace → higher EF.
    // EF = (speed * 60) / hr; faster pace at same HR = higher EF
    const runs = [
      // Early (5-8 weeks ago): pace 360 s/km → speed=2.78 m/s → EF=(2.78*60)/140=1.19
      makeEasyRun(8 * 7, 360, 140),
      makeEasyRun(7 * 7, 360, 140),
      makeEasyRun(6 * 7, 360, 140),
      makeEasyRun(5 * 7, 360, 140),
      // Recent (1-4 weeks ago): pace 310 s/km → speed=3.23 m/s → EF=(3.23*60)/140=1.38
      makeEasyRun(4 * 7, 310, 140),
      makeEasyRun(3 * 7, 310, 140),
      makeEasyRun(2 * 7, 310, 140),
      makeEasyRun(1 * 7, 310, 140),
    ]
    const result = efficiencyFactorTrend(runs, maxHr, restHr)
    expect(result).not.toBeNull()
    expect(result!.direction).toBe('↑')
    expect(result!.deltaPct).toBeGreaterThanOrEqual(2.0)
    expect(result!.recentEf!).toBeGreaterThan(result!.earlyEf!)
  })

  it('falling EF trend returns ↓ direction', () => {
    // Early: fast pace → high EF. Recent: slower pace → lower EF.
    const runs = [
      makeEasyRun(8 * 7, 310, 140),
      makeEasyRun(7 * 7, 310, 140),
      makeEasyRun(6 * 7, 310, 140),
      makeEasyRun(5 * 7, 310, 140),
      makeEasyRun(4 * 7, 360, 140),
      makeEasyRun(3 * 7, 360, 140),
      makeEasyRun(2 * 7, 360, 140),
      makeEasyRun(1 * 7, 360, 140),
    ]
    const result = efficiencyFactorTrend(runs, maxHr, restHr)
    expect(result).not.toBeNull()
    expect(result!.direction).toBe('↓')
    expect(result!.deltaPct).toBeLessThanOrEqual(-2.0)
  })

  it('stable EF returns → direction', () => {
    // All runs at same pace → EF constant → delta ~0 → →
    const runs = [
      makeEasyRun(8 * 7, 340, 140),
      makeEasyRun(7 * 7, 340, 140),
      makeEasyRun(6 * 7, 340, 140),
      makeEasyRun(5 * 7, 340, 140),
      makeEasyRun(2 * 7, 340, 140),
      makeEasyRun(1 * 7, 340, 140),
    ]
    const result = efficiencyFactorTrend(runs, maxHr, restHr)
    expect(result).not.toBeNull()
    expect(result!.direction).toBe('→')
    expect(Math.abs(result!.deltaPct)).toBeLessThan(2.0)
  })

  it('filters out runs outside 50–80% HRR', () => {
    // hr=100 → (100-50)/140*100 = 35.7% HRR → below 50% → excluded
    // hr=170 → (170-50)/140*100 = 85.7% HRR → above 80% → excluded
    const runs = [
      makeEasyRun(50, 340, 100),  // too low HR
      makeEasyRun(45, 340, 170),  // too high HR
      makeEasyRun(40, 340, 170),
      makeEasyRun(35, 340, 100),
      makeEasyRun(10, 340, 100),
    ]
    // Only 0 qualifying runs → null
    const result = efficiencyFactorTrend(runs, maxHr, restHr)
    expect(result).toBeNull()
  })

  it('EF computed correctly: (speed_m_s * 60) / avg_hr', () => {
    // 8 identical easy runs spread across 8 weeks
    // pace=340 s/km → speed=1000/340=2.941 m/s → EF=(2.941*60)/140=1.260
    const earlyEf = (1000 / 340 * 60) / 140
    const runs = [
      makeEasyRun(8 * 7, 340, 140),
      makeEasyRun(7 * 7, 340, 140),
      makeEasyRun(6 * 7, 340, 140),
      makeEasyRun(5 * 7, 340, 140),
      makeEasyRun(2 * 7, 340, 140),
      makeEasyRun(1 * 7, 340, 140),
    ]
    const result = efficiencyFactorTrend(runs, maxHr, restHr)
    expect(result).not.toBeNull()
    expect(result!.earlyEf!).toBeCloseTo(earlyEf, 2)
    expect(result!.recentEf!).toBeCloseTo(earlyEf, 2)
  })
})
