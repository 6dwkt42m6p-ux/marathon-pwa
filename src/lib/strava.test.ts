import { describe, it, expect } from 'vitest'
import { syncAnchorTs, OVERLAP_DAYS, vdotTrendFromActivities, efficiencyFactorTrend, activityLoad, bikeTss, computeAtlCtl, runRtss, runHrtss } from './strava'
import type { RunSummary, StravaActivity, SyncedThreshold } from './strava'
import { effortNormalizationFactor, tempAdjFactor } from './vdot'

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

// ── T-122: activityLoad — factor-map parity with coach.py _daily_load ────────
// Expected values derived from the DESKTOP factor maps (NOT from the PWA function),
// ensuring tests catch regressions, not just mirror the implementation.
//
// _WORKOUT_TYPE_FACTOR (coach.py):
//   run:  0→1.0, 1→1.4 (race), 2→0.9 (long), 3→1.3 (workout)
//   ride: 10→1.4, 11→1.3, 12→0.9
//
// _SPORT_TYPE_FACTOR (coach.py):
//   Swim→0.8, Hike→0.8, Walk→0.8, VirtualRide→1.0, EBikeRide→0.6
//
// Auswahllogik:
//   if (wt not in _WORKOUT_TYPE_FACTOR) and (sport_type in _SPORT_TYPE_FACTOR) → sport factor
//   elif (wt == 0) and (sport_type in _SPORT_TYPE_FACTOR)                      → sport factor
//   else                                                                        → workout_type factor (default 1.0)

function makeActivity(overrides: Partial<StravaActivity>): StravaActivity {
  return {
    id: 1,
    name: 'Test',
    type: 'Run',
    sport_type: 'Run',
    start_date: '2026-06-17T08:00:00Z',
    start_date_local: '2026-06-17T10:00:00+0200',
    distance: 10000,
    moving_time: 3600,   // 60 min default
    total_elevation_gain: 0,
    average_speed: 2.78,
    ...overrides,
  }
}

describe('activityLoad (T-122) — Run workout_type factors', () => {
  // All tests: 60 min (moving_time=3600), no suffer_score → duration×factor path

  it('wt=0 (default/easy): 60 min × 1.0 = 60', () => {
    const a = makeActivity({ workout_type: 0 })
    expect(activityLoad(a)).toBe(60)
  })

  it('wt=1 (race): 60 min × 1.4 = 84', () => {
    const a = makeActivity({ workout_type: 1 })
    expect(activityLoad(a)).toBe(84)
  })

  it('wt=2 (long run): 60 min × 0.9 = 54', () => {
    const a = makeActivity({ workout_type: 2 })
    expect(activityLoad(a)).toBe(54)
  })

  it('wt=3 (workout/interval): 60 min × 1.3 = 78', () => {
    const a = makeActivity({ workout_type: 3 })
    expect(activityLoad(a)).toBe(78)
  })
})

describe('activityLoad (T-122) — Ride workout_type factors', () => {
  it('wt=10 (ride race): 60 min × 1.4 = 84', () => {
    const a = makeActivity({ type: 'Ride', sport_type: 'Ride', workout_type: 10 })
    expect(activityLoad(a)).toBe(84)
  })

  it('wt=11 (ride workout): 60 min × 1.3 = 78', () => {
    const a = makeActivity({ type: 'Ride', sport_type: 'Ride', workout_type: 11 })
    expect(activityLoad(a)).toBe(78)
  })

  it('wt=12 (ride long): 60 min × 0.9 = 54', () => {
    const a = makeActivity({ type: 'Ride', sport_type: 'Ride', workout_type: 12 })
    expect(activityLoad(a)).toBe(54)
  })
})

describe('activityLoad (T-122) — Sport-type factors (Swim/Hike)', () => {
  // sport_type in _SPORT_TYPE_FACTOR + wt=0 → sport factor
  it('Swim wt=0: 60 min × 0.8 = 48', () => {
    const a = makeActivity({ type: 'Swim', sport_type: 'Swim', workout_type: 0 })
    expect(activityLoad(a)).toBe(48)
  })

  it('Hike wt=0: 60 min × 0.8 = 48', () => {
    const a = makeActivity({ type: 'Hike', sport_type: 'Hike', workout_type: 0 })
    expect(activityLoad(a)).toBe(48)
  })

  it('Walk wt=0: 60 min × 0.8 = 48', () => {
    const a = makeActivity({ type: 'Walk', sport_type: 'Walk', workout_type: 0 })
    expect(activityLoad(a)).toBe(48)
  })

  it('VirtualRide wt=0: 60 min × 1.0 = 60', () => {
    // VirtualRide has wt=0 and sport_type "VirtualRide" → sport factor 1.0
    const a = makeActivity({ type: 'VirtualRide', sport_type: 'VirtualRide', workout_type: 0 })
    expect(activityLoad(a)).toBe(60)
  })
})

describe('activityLoad (T-122) — suffer_score priority', () => {
  it('suffer_score > 0 takes priority over factor calculation', () => {
    // Run wt=1 (race factor 1.4 × 60 = 84) but suffer_score=100 → returns 100
    const a = makeActivity({ workout_type: 1, suffer_score: 100 })
    expect(activityLoad(a)).toBe(100)
  })

  it('suffer_score = 0 falls through to factor calculation (Run wt=3: 78)', () => {
    const a = makeActivity({ workout_type: 3, suffer_score: 0 })
    expect(activityLoad(a)).toBe(78)
  })

  it('suffer_score = null falls through to factor calculation (Swim 48)', () => {
    const a = makeActivity({ type: 'Swim', sport_type: 'Swim', workout_type: 0, suffer_score: undefined })
    expect(activityLoad(a)).toBe(48)
  })
})

// ── T-125: bikeTss formula ────────────────────────────────────────────────────
// Reference: coach.py bike_tss: TSS = duration_sec * IF^2 / 3600 * 100
// where IF = np_watts / ftp.
// Expected values computed from the formula directly, NOT from the function
// (anti-tautology: a coding error would produce wrong result, not a passing test).

describe('bikeTss (T-125)', () => {
  it('1h @ NP=FTP → IF=1 → TSS=100 (canonical test)', () => {
    // IF = 250/250 = 1.0; TSS = 3600 * 1^2 / 3600 * 100 = 100
    expect(bikeTss(250, 3600, 250)).toBeCloseTo(100, 2)
  })

  it('1h @ NP=0.75×FTP → IF=0.75 → TSS=56.25', () => {
    // IF = 0.75; TSS = 3600 * 0.75^2 / 3600 * 100 = 56.25
    expect(bikeTss(187.5, 3600, 250)).toBeCloseTo(56.25, 2)
  })

  it('2h @ NP=0.8×FTP → TSS=128', () => {
    // IF = 0.8; TSS = 7200 * 0.64 / 3600 * 100 = 128
    expect(bikeTss(200, 7200, 250)).toBeCloseTo(128, 2)
  })

  it('ftp <= 0 returns 0 (ZeroDivision guard)', () => {
    expect(bikeTss(250, 3600, 0)).toBe(0)
    expect(bikeTss(250, 3600, -10)).toBe(0)
  })

  it('np_watts = 0 returns 0', () => {
    expect(bikeTss(0, 3600, 250)).toBe(0)
  })
})

// ── T-125: activityLoad with FTP — conditional bike_tss path ─────────────────

describe('activityLoad (T-125) — bike_tss path with FTP', () => {
  // Ride with device_watts=true, weighted_average_watts as NP proxy, no suffer_score.
  // FTP=250, NP=200 (0.8×FTP), moving_time=3600s → TSS=64
  // IF = 200/250 = 0.8; TSS = 3600 * 0.64 / 3600 * 100 = 64
  const npWatts = 200
  const ftp = 250
  const expectedTss = Math.round((3600 * Math.pow(npWatts / ftp, 2) / 3600) * 100)  // 64

  it('Ride with device_watts + ftp → bikeTss (not duration factor)', () => {
    const a = makeActivity({
      type: 'Ride', sport_type: 'Ride', workout_type: 0,
      moving_time: 3600,
      weighted_average_watts: npWatts,
      device_watts: true,
    })
    const load = activityLoad(a, ftp)
    expect(load).toBeCloseTo(expectedTss, 1)
    // Explicitly not the factor path: duration*1.0=60, TSS=64 — distinct
    expect(load).not.toBe(60)
  })

  it('Ride without ftp → falls back to duration factor (regression guard)', () => {
    const a = makeActivity({
      type: 'Ride', sport_type: 'Ride', workout_type: 0,
      moving_time: 3600,
      weighted_average_watts: npWatts,
      device_watts: true,
    })
    // No ftp passed → old Ride factor path (wt=0, Ride sport → factor from map or 1.0)
    const load = activityLoad(a)
    // wt=0 and sport_type='Ride' not in _SPORT_TYPE_FACTOR → factor 1.0 → 60 min × 1.0 = 60
    expect(load).toBe(60)
  })

  it('Ride with ftp but device_watts=false → duration factor (no power measurement)', () => {
    const a = makeActivity({
      type: 'Ride', sport_type: 'Ride', workout_type: 0,
      moving_time: 3600,
      weighted_average_watts: npWatts,
      device_watts: false,
    })
    expect(activityLoad(a, ftp)).toBe(60)
  })

  it('Ride with ftp but no weighted_average_watts → duration factor', () => {
    const a = makeActivity({
      type: 'Ride', sport_type: 'Ride', workout_type: 0,
      moving_time: 3600,
      device_watts: true,
      // no weighted_average_watts
    })
    expect(activityLoad(a, ftp)).toBe(60)
  })

  it('Run with ftp → does NOT use bike_tss (run factor path)', () => {
    const a = makeActivity({ type: 'Run', sport_type: 'Run', workout_type: 0, moving_time: 3600 })
    // Run with ftp → ftp has no effect on runs
    expect(activityLoad(a, ftp)).toBe(60)
  })

  it('Power-TSS takes priority over suffer_score (T-125-fix: matches coach.py _daily_load)', () => {
    // Ride with suffer_score=200 AND device_watts+NP+FTP → Power-TSS wins, NOT suffer_score.
    // NP=FTP=250, 1h → IF=1.0 → TSS=100. suffer_score=200 must NOT win.
    const a = makeActivity({
      type: 'Ride', sport_type: 'Ride', workout_type: 0,
      moving_time: 3600, weighted_average_watts: 250,
      device_watts: true, suffer_score: 200,
    })
    expect(activityLoad(a, 250)).toBe(100)
    expect(activityLoad(a, 250)).not.toBe(200)
  })

  it('Same Ride WITHOUT ftp → falls back to suffer_score (regression guard)', () => {
    // Same ride, ftp not provided → power path skipped → suffer_score=200 wins.
    const a = makeActivity({
      type: 'Ride', sport_type: 'Ride', workout_type: 0,
      moving_time: 3600, weighted_average_watts: 250,
      device_watts: true, suffer_score: 200,
    })
    expect(activityLoad(a)).toBe(200)
  })
})

// ── T-125: computeAtlCtl with ftp parameter propagates ────────────────────────

describe('computeAtlCtl (T-125) — ftp parameter propagates to activityLoad', () => {
  it('computeAtlCtl with ftp produces different ATL than without ftp for rides with power', () => {
    // Single Ride 1h, NP=250, device_watts=true: with FTP=250 → TSS=100; without → 60
    const ride = makeActivity({
      type: 'Ride', sport_type: 'Ride', workout_type: 0,
      moving_time: 3600,
      weighted_average_watts: 250,
      device_watts: true,
      start_date: new Date(Date.now() - 1 * 86400 * 1000).toISOString(),
      start_date_local: new Date(Date.now() - 1 * 86400 * 1000).toISOString(),
    })
    const resultNoFtp  = computeAtlCtl([ride])
    const resultWithFtp = computeAtlCtl([ride], 250)
    // With FTP: load=100 → ATL > without FTP (load=60)
    expect(resultWithFtp.atl).toBeGreaterThan(resultNoFtp.atl)
  })
})

// ── T-138: runRtss / runHrtss — formula identical to coach.py ─────────────────

describe('runRtss / runHrtss (T-138) — formelgleich zu coach.py', () => {
  it('rTSS: 1 h @ threshold pace = 100', () => {
    // IF = thresholdPace/avgPace = 240/240 = 1.0 → TSS = 1h * 1.0^2 * 100 = 100
    expect(runRtss(3600, 240, 240)!).toBeCloseTo(100, 1)
  })
  it('rTSS: IF=√2 (pace=threshold/√2) → 200 für 1 h', () => {
    // IF = 240 / (240/√2) = √2 → TSS = 1 * 2 * 100 = 200
    expect(runRtss(3600, 240 / Math.sqrt(2), 240)!).toBeCloseTo(200, 0)
  })
  it('rTSS: guards → null', () => {
    expect(runRtss(0, 240, 240)).toBeNull()
    expect(runRtss(3600, null as unknown as number, 240)).toBeNull()
    expect(runRtss(3600, 240, 0)).toBeNull()
  })
  it('rTSS: pace out of plausible range → null', () => {
    expect(runRtss(3600, 100, 240)).toBeNull()  // 100 s/km = implausibly fast
    expect(runRtss(3600, 1000, 240)).toBeNull() // 1000 s/km = implausibly slow
  })
  it('hrTSS: 1 h @ LTHR = 100', () => {
    // IF_hr = (170-50)/(170-50) = 1.0 → hrTSS = 1h * 1.0^2 * 100 = 100
    expect(runHrtss(3600, 170, 170, 50)!).toBeCloseTo(100, 1)
  })
  it('hrTSS: IF_hr=0.5 → 25 für 1 h', () => {
    // avg_hr=110, lthr=170, rest_hr=50 → IF=(110-50)/(170-50) = 60/120 = 0.5
    // TSS = 1 * 0.25 * 100 = 25
    expect(runHrtss(3600, 110, 170, 50)!).toBeCloseTo(25, 0)
  })
  it('hrTSS: lthr==restHr → null (division by zero guard)', () => {
    expect(runHrtss(3600, 170, 170, 170)).toBeNull()
  })
  it('hrTSS: IF_hr ≤ 0 (avgHr below restHr) → null', () => {
    expect(runHrtss(3600, 40, 170, 50)).toBeNull()
  })
})

// ── T-138: activityLoad Smart-Run-Block + computeAtlCtl threshold ─────────────

const _THR: SyncedThreshold = {
  lthr: 170, threshold_pace_sec: 240, rest_hr: 50, is_fallback: false, source: 'manual',
}

function _run(over: Partial<StravaActivity> = {}): StravaActivity {
  // 15 km in 3600 s → pace = 3600/(15000/1000) = 240 s/km = threshold
  return makeActivity({
    type: 'Run', sport_type: 'Run', moving_time: 3600, distance: 15000,
    average_heartrate: 170, suffer_score: 80, workout_type: 0,
    ...over,
  })
}

describe('activityLoad (T-138) — rTSS/hrTSS mit threshold', () => {
  it('steady run: pace=threshold → rTSS=100 (not suffer_score=80)', () => {
    // 15 km / 3600 s → 240 s/km = threshold → IF=1.0 → rTSS=100
    expect(activityLoad(_run(), undefined, _THR)).toBeCloseTo(100, 0)
  })
  it('workout_type=3 → hrTSS wins (avg_hr=LTHR → 100)', () => {
    // 12 km in 3600 s → pace=300, rTSS=(240/300)^2*100=64; HF=LTHR=170 → hrTSS=100
    // structured=true (wt===3) → hrTSS wins; ratio also 1.5625 ≥ 1.15 (covered by Divergenz test too)
    expect(activityLoad(_run({ distance: 12000, workout_type: 3 }), undefined, _THR)).toBeCloseTo(100, 0)
  })
  it('Divergenz: slow pace + high HF → hrTSS wins', () => {
    // 11250m in 3600s → pace=320 s/km → rTSS=(240/320)^2*100=56.25
    // hrTSS=100, ratio=100/56.25=1.78 ≥ 1.15 → structured → hrTSS
    expect(activityLoad(_run({ distance: 11250, workout_type: 0 }), undefined, _THR)).toBeCloseTo(100, 0)
  })
  it('Lauf ohne HF → rTSS (no hrTSS fallback)', () => {
    // avg_hr=undefined → hrTSS=null → rTSS wins (pace=threshold → 100)
    expect(activityLoad(_run({ average_heartrate: undefined }), undefined, _THR)).toBeCloseTo(100, 0)
  })
  it('threshold undefined → Backward-Compat suffer_score', () => {
    // No threshold → Smart-Run-Block skipped → suffer_score=80 wins
    expect(activityLoad(_run({ suffer_score: 80 }))).toBe(80)
  })
  it('Ride with threshold → Power path still takes priority (Ride not Run)', () => {
    const ride = makeActivity({
      type: 'Ride', sport_type: 'Ride', workout_type: 0, moving_time: 3600,
      weighted_average_watts: 250, device_watts: true,
    })
    // Power-TSS path wins (ftp=250, NP=250 → TSS=100); threshold ignored for Rides
    expect(activityLoad(ride, 250, _THR)).toBeCloseTo(100, 0)
  })
})

describe('computeAtlCtl (T-138) — threshold propagiert', () => {
  it('ATL mit threshold ≠ ATL ohne (für Runs)', () => {
    // Run 15km in 3600s, suffer_score=80. With threshold → rTSS=100; without → 80 (suffer_score)
    const acts = [_run({
      start_date: new Date(Date.now() - 86400 * 1000).toISOString(),
      start_date_local: new Date(Date.now() - 86400 * 1000).toISOString(),
    })]
    const withT = computeAtlCtl(acts, undefined, _THR)
    const withoutT = computeAtlCtl(acts, undefined)
    expect(withT.atl).not.toBeCloseTo(withoutT.atl, 1)
  })
})

// ── T-140: effortNormalizationFactor — formelgleich coach.py ──────────────────

describe('effortNormalizationFactor (T-140) — formelgleich coach.py', () => {
  it('flach + kühl → 1.0', () => {
    expect(effortNormalizationFactor(10, 0, 12)).toBe(1.0)
  })
  it('fehlende Daten → 1.0', () => {
    expect(effortNormalizationFactor(10, 0, undefined)).toBe(1.0)
    // dist<=0 → kein GAP; kühl → factor=1.0
    expect(effortNormalizationFactor(0, 500, 12)).toBe(1.0)
    expect(effortNormalizationFactor(10, NaN, NaN)).toBe(1.0)
  })
  it('heiß == 1 + tempAdjFactor(28)', () => {
    expect(effortNormalizationFactor(10, 0, 28)).toBeCloseTo(1 + tempAdjFactor(28), 9)
  })
  it('hügelig 5 % (600 m / 12 km) → 1.08', () => {
    // grade = 600/(12000)*100 = 5%; gap = 0.02*(5-1)=0.08; heat=0 → factor=(1+0)*(1+0.08)=1.08
    expect(effortNormalizationFactor(12, 600, 12)).toBeCloseTo(1.08, 6)
  })
  it('Gelände gedeckelt (8 % → cap 0.12 → 1.12)', () => {
    // grade = 800/(10000)*100 = 8%; gap=0.02*(8-1)=0.14 → capped at 0.12 → factor=1.12
    expect(effortNormalizationFactor(10, 800, 12)).toBeCloseTo(1.12, 6)
  })
  it('unter Floor (0.5 %) → kein GAP', () => {
    // grade = 50/(10000)*100 = 0.5%; below 1% floor → gap=0 → factor=1.0
    expect(effortNormalizationFactor(10, 50, 12)).toBe(1.0)
  })
  it('kombiniert heat und grade', () => {
    // grade=5% → gap=0.08; heat=tempAdjFactor(28) → factor=(1+heat)*(1+0.08)
    expect(effortNormalizationFactor(12, 600, 28)).toBeCloseTo((1 + tempAdjFactor(28)) * 1.08, 6)
  })
})

// ── T-140: GAP/Hitze in efficiencyFactorTrend + vdotTrendFromActivities ───────

function _makeEasyRuns(elevationM: number, n = 6): RunSummary[] {
  const now = Date.now()
  return Array.from({ length: n }, (_, i) => ({
    id: i,
    name: `Easy ${i}`,
    date: new Date(now - (4 + i * 5) * 24 * 3600 * 1000),
    distanceKm: 10,
    durationSec: 3000,
    paceSec: 300,
    paceFmt: '',
    avgHr: 140,
    elevationM,
    tempC: 12,
  } as RunSummary))
}

describe('GAP/Hitze in efficiencyFactorTrend (T-140)', () => {
  it('hügelig → höhere recentEf als flach', () => {
    const flat  = efficiencyFactorTrend(_makeEasyRuns(0),   8, 190, 50)
    const hilly = efficiencyFactorTrend(_makeEasyRuns(500), 8, 190, 50)  // 5% grade → factor 1.08
    expect(flat).not.toBeNull()
    expect(hilly).not.toBeNull()
    expect(flat!.noHrData).toBe(false)
    expect(hilly!.recentEf!).toBeGreaterThan(flat!.recentEf!)
  })
  it('ohne Höhe (elevationM=0) → backward-compat (Faktor 1.0)', () => {
    const a = efficiencyFactorTrend(_makeEasyRuns(0), 8, 190, 50)
    expect(a).not.toBeNull()
    expect(a!.recentEf).toBeTruthy()
  })
})

describe('GAP/Hitze in vdotTrendFromActivities (T-140)', () => {
  function _makeEffortRuns(elevationM: number): RunSummary[] {
    const now = Date.now()
    return Array.from({ length: 6 }, (_, i) => ({
      id: i,
      name: `Effort ${i}`,
      date: new Date(now - (4 + i * 5) * 24 * 3600 * 1000),
      distanceKm: 10,
      durationSec: 2400,  // 240 s/km = M-pace for VDOT ~45
      paceSec: 240,
      paceFmt: '',
      avgHr: 170,
      elevationM,
      tempC: 12,
    } as RunSummary))
  }

  it('hügeliger Effort → höheres recent VDOT als flach', () => {
    const flat  = vdotTrendFromActivities(_makeEffortRuns(0),   50, 190, 50)
    const hilly = vdotTrendFromActivities(_makeEffortRuns(600), 50, 190, 50)  // 6% grade
    expect(flat).not.toBeNull()
    expect(hilly).not.toBeNull()
    expect(hilly!.recent).toBeGreaterThan(flat!.recent)
  })
})
