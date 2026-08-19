import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { detectStrides, syncAnchorTs, OVERLAP_DAYS, vdotTrendFromActivities, efficiencyFactorTrend, activityLoad, bikeTss, computeAtlCtl, runRtss, runHrtss, ctlRising, thisWeekKm, thisWeekStatsBySport, parseStravaLocal, capStreamLapsCaches, evictAllStreamLapsCaches, saveCachedActivitiesExported as saveCachedActivities, getStorageWarning, clearStorageWarning, STORAGE_WARNING_KEY, STREAM_CACHE_MAX, STREAM_CACHE_KEY, LAPS_CACHE_KEY, getCachedActivities, classifyWorkoutStructure, saveTokens, exchangeCode, loadTokens, parseAllActivities, parseRuns, bestVdotFromActivities } from './strava'
import type { RunSummary, StravaActivity, SyncedThreshold } from './strava'
import { effortNormalizationFactor, tempAdjFactor, vdotFromRace } from './vdot'

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

describe('vdotTrendFromActivities — VDOT aggregation = median (T-120, T-194)', () => {
  // Effort runs (avg_hr = 160 for maxHr=190, restHr=50 → ~79% HRR ≥ 65%).
  // T-194: mindestens MIN_TREND_EFFORT_RUNS (3) Läufe JE Hälfte, sonst wird kein
  // Trend gemeldet — deshalb 3 statt der früheren 2 pro Hälfte. Aggregat ist seit
  // T-194 der Median je Hälfte (vorher Mittelwert), formgleich coach.vdot_trend.

  const maxHr = 190
  const restHr = 50
  const currentVdot = 45

  // 10km @ ~4:00/km (240 s/km) → decent effort VDOT
  const earlyRuns = [
    makeRun(7 * 7, 10, 240, 160),
    makeRun(6 * 7, 10, 245, 160),
    makeRun(5 * 7, 10, 243, 160),
  ]
  // Recent runs faster → higher VDOT
  const recentRuns = [
    makeRun(3 * 7, 10, 235, 162),
    makeRun(2 * 7, 10, 232, 162),
    makeRun(1 * 7, 10, 230, 162),
  ]

  const runs = [...earlyRuns, ...recentRuns]

  it('uses median of all effort VDOTs per half (not bestVdot top-3)', () => {
    const result = vdotTrendFromActivities(runs, currentVdot, maxHr, restHr)
    expect(result).not.toBeNull()
    expect(result!.direction).toBe('↑')
    expect(result!.recent).toBeGreaterThan(result!.early)
    expect(result!.delta).toBeGreaterThan(0)
  })

  it('stable trend returns → when early and recent are nearly equal', () => {
    const stableRuns = [
      makeRun(7 * 7, 10, 240, 160),
      makeRun(6 * 7, 10, 240, 160),
      makeRun(5 * 7, 10, 240, 160),
      makeRun(3 * 7, 10, 240, 160),
      makeRun(2 * 7, 10, 240, 160),
      makeRun(1 * 7, 10, 240, 160),
    ]
    const result = vdotTrendFromActivities(stableRuns, currentVdot, maxHr, restHr)
    expect(result).not.toBeNull()
    expect(result!.direction).toBe('→')
    expect(Math.abs(result!.delta)).toBeLessThan(0.3)
  })

  // ── T-194: Paritaet zu tests/test_coach.py::test_t194_* ───────────────────

  it('meldet keinen Trend bei weniger als 3 Effort-Laeufen je Haelfte', () => {
    const tooFew = [
      makeRun(7 * 7, 10, 240, 160),
      makeRun(6 * 7, 10, 245, 160),          // nur 2 frueh
      makeRun(3 * 7, 10, 235, 162),
      makeRun(2 * 7, 10, 232, 162),
      makeRun(1 * 7, 10, 230, 162),
    ]
    const result = vdotTrendFromActivities(tooFew, currentVdot, maxHr, restHr)
    expect(result === null || result.insufficientEffortRuns).toBeTruthy()
  })

  it('ein einzelner Ausreisser kippt das Verdikt nicht (Median)', () => {
    const withOutlier = [
      makeRun(7 * 7, 10, 240, 160),
      makeRun(6 * 7, 10, 240, 160),
      makeRun(5 * 7, 10, 240, 160),
      makeRun(4.5 * 7, 10, 400, 160),        // deutlich langsamer -> Ausreisser
      makeRun(3 * 7, 10, 240, 162),
      makeRun(2 * 7, 10, 240, 162),
      makeRun(1 * 7, 10, 240, 162),
    ]
    const result = vdotTrendFromActivities(withOutlier, currentVdot, maxHr, restHr)
    expect(result).not.toBeNull()
    expect(result!.insufficientEffortRuns).toBe(false)
    expect(Math.abs(result!.delta)).toBeLessThan(0.3)
    expect(result!.direction).toBe('→')
  })

  it('liefert die Stichprobengroessen fuer die UI', () => {
    const result = vdotTrendFromActivities(runs, currentVdot, maxHr, restHr)
    expect(result!.nEarly).toBe(3)
    expect(result!.nRecent).toBe(3)
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
    start_date_local: '2026-06-17T10:00:00Z',  // real Strava format: local wallclock + 'Z'
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

// 8 easy runs spread across 8 weeks (1 per week), HR 140 (64% HRR, within 50–80% qualifying range)
// pace=300s/km → speed=3.33m/s → EF=(3.33*60)/140=1.43 (within 1.1–4.2 m/s range)
function _makeEasyRuns(elevationM: number): RunSummary[] {
  const now = Date.now()
  return Array.from({ length: 8 }, (_, i) => ({
    id: i,
    name: `Easy ${i}`,
    date: new Date(now - (i * 7 + 3) * 24 * 3600 * 1000),  // 3,10,17,...59 days ago = 8 weeks
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
    const flat  = efficiencyFactorTrend(_makeEasyRuns(0),   190, 50)
    const hilly = efficiencyFactorTrend(_makeEasyRuns(500), 190, 50)  // 5% grade → factor 1.08
    expect(flat).not.toBeNull()
    expect(hilly).not.toBeNull()
    expect(flat!.noHrData).toBe(false)
    expect(hilly!.recentEf!).toBeGreaterThan(flat!.recentEf!)
  })
  it('ohne Höhe (elevationM=0) → backward-compat (Faktor 1.0)', () => {
    const a = efficiencyFactorTrend(_makeEasyRuns(0), 190, 50)
    expect(a).not.toBeNull()
    expect(a!.recentEf).toBeTruthy()
  })
})

describe('GAP/Hitze in vdotTrendFromActivities (T-140)', () => {
  function _makeEffortRuns(elevationM: number): RunSummary[] {
    const now = Date.now()
    // T-194: 3 Laeufe je Fensterhaelfte (Grenze bei 28 Tagen) — darunter meldet
    // vdotTrendFromActivities keinen Trend mehr (MIN_TREND_EFFORT_RUNS).
    return Array.from({ length: 6 }, (_, i) => ({
      id: i,
      name: `Effort ${i}`,
      date: new Date(now - (i < 3 ? 4 + i * 5 : 32 + (i - 3) * 5) * 24 * 3600 * 1000),
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

// ── T-186: bestVdotFromActivities — faithful port of coach.py:best_vdot_from_activities.
// Before this fix, StravaSync.tsx computed the displayed VDOT on raw (uncorrected) times,
// diverging from the Desktop by up to 1.6 VDOT points and even picking a different "best" run.

function _bestVdotRun(name: string, distanceKm: number, durationSec: number, elevationM: number, tempC?: number): RunSummary {
  return {
    id: Math.random(),
    name,
    date: new Date(Date.now() - 7 * 24 * 3600 * 1000),  // 1 week ago — well inside the 12-week window
    distanceKm,
    durationSec,
    paceSec: durationSec / distanceKm,
    paceFmt: '',
    elevationM,
    tempC,
  } as RunSummary
}

describe('bestVdotFromActivities — GAP/Hitze-Normalisierung (T-186)', () => {
  it('heißerer Lauf ergibt nach Korrektur den besseren (höheren) VDOT als derselbe rohe Lauf ohne Hitze', () => {
    // Identical raw distance/time/elevation — only tempC differs.
    const cool = _bestVdotRun('Cool Run', 10, 2400, 20, 12)  // 12°C: neutral zone → heat factor 0
    const hot  = _bestVdotRun('Hot Run',  10, 2400, 20, 30)  // 30°C: heat factor > 0 → shorter normalized duration → higher VDOT

    const result = bestVdotFromActivities([cool, hot])
    expect(result).not.toBeNull()

    // Naive (pre-fix) raw VDOT — identical for both runs since raw time/distance match.
    const rawVdot = Math.round(vdotFromRace(10 * 1000, 2400) * 10) / 10

    // The hot run's corrected VDOT is higher → it becomes the displayed (metadata) run.
    expect(result!.name).toBe('Hot Run')
    // Median of {cool's raw VDOT, hot's corrected/higher VDOT} must exceed the raw baseline.
    expect(result!.vdot).toBeGreaterThan(rawVdot)
  })

  it('ohne Temperaturdaten (tempC undefined) + flaches Terrain → Verhalten unverändert (Backward-Compat)', () => {
    // No weather sync yet (tempC undefined) and negligible elevation (<1% grade) → factor stays
    // exactly 1.0, so the result must match the pre-T-186 raw calculation — users without a
    // Strava/weather sync must not see their VDOT break or shift.
    const flat = _bestVdotRun('Flat Run', 10, 2400, 5, undefined)  // 0.05% grade → below GAP floor
    const result = bestVdotFromActivities([flat])
    expect(result).not.toBeNull()

    const rawVdot = Math.round(vdotFromRace(10 * 1000, 2400) * 10) / 10
    expect(result!.vdot).toBe(rawVdot)
    expect(result!.name).toBe('Flat Run')
  })
})

// T-146: ctlRising — 42d-EWMA steigt wenn Last aufgebaut wurde; null bei <29 Tagen Daten.
describe('ctlRising (T-146)', () => {
  // Helper: activity at daysAgo with given moving_time (seconds, maps to suffer_score-free load)
  function _actDaysAgo(daysAgo: number, movingTimeSec: number): StravaActivity {
    const d = new Date(Date.now() - daysAgo * 86400 * 1000)
    const iso = d.toISOString()
    return makeActivity({ start_date: iso, start_date_local: iso, moving_time: movingTimeSec, workout_type: 0 })
  }

  it('returns null when fewer than 29 days of data', () => {
    const short: StravaActivity[] = []
    for (let d = 0; d < 10; d++) short.push(_actDaysAgo(d, 3600))
    expect(ctlRising(short)).toBeNull()
  })

  it('returns true when load builds up over 41 days (heute höher als vor 28)', () => {
    const building: StravaActivity[] = []
    // Older days: light load (1 min), recent days: heavy load (120 min) → CTL rises
    for (let d = 40; d >= 14; d--) building.push(_actDaysAgo(d, 60))   // 1 min = load 1
    for (let d = 13; d >= 0; d--) building.push(_actDaysAgo(d, 7200))  // 120 min = load 120
    expect(ctlRising(building)).toBe(true)
  })

  it('returns false when load declines over 41 days (heute niedriger als vor 28)', () => {
    const declining: StravaActivity[] = []
    // Days 60–30: very heavy load; days 29–0: zero load → CTL definitely falls
    for (let d = 60; d >= 30; d--) declining.push(_actDaysAgo(d, 14400)) // 4h
    // days 29–0: no activities → dailyLoadSeries fills 0
    expect(ctlRising(declining)).toBe(false)
  })
})

// ── T-162: parseStravaLocal + Wochenkilometer-Bug (start_date_local Z-Suffix) ──
//
// Strava liefert start_date_local als LOKALE Uhrzeit mit irreführendem 'Z'-Suffix.
// new Date('…T19:30:00Z') → UTC-Interpretation → Lauf liegt ~2h in der "Zukunft" für GMT+2.
// thisWeekKm und thisWeekStatsBySport filterten mit d <= now → frische Läufe herausgefiltert.

describe('parseStravaLocal (T-162)', () => {
  it('strips Z suffix so local wallclock time is parsed as local (not UTC)', () => {
    // Simulate a run that started at 19:30 local time with Strava's misleading 'Z' suffix.
    // Without the fix: new Date('…T19:30:00Z') = UTC → in GMT+2 = 21:30 local (2h into future).
    // After fix: parsed as local 19:30 → same calendar day, no future shift.
    const nowLocal = new Date()
    const localDateStr = `${nowLocal.getFullYear()}-${String(nowLocal.getMonth() + 1).padStart(2, '0')}-${String(nowLocal.getDate()).padStart(2, '0')}`
    const stravaLocalStr = `${localDateStr}T19:30:00Z`  // real Strava format: local time + Z

    const a: StravaActivity = {
      id: 1, name: 'T-162 test', type: 'Run', sport_type: 'Run',
      start_date: `${localDateStr}T17:30:00Z`,  // actual UTC
      start_date_local: stravaLocalStr,
      distance: 10000, moving_time: 3600, total_elevation_gain: 0, average_speed: 2.78,
    }

    const parsed = parseStravaLocal(a)
    // Must be parsed as LOCAL 19:30 (not UTC 19:30 = 21:30 local in GMT+2)
    expect(parsed.getHours()).toBe(19)
    expect(parsed.getMinutes()).toBe(30)
  })

  it('strips +HH:MM offset variant', () => {
    const a: StravaActivity = {
      id: 2, name: 'T-162 offset', type: 'Run', sport_type: 'Run',
      start_date: '2026-06-17T08:00:00Z',
      start_date_local: '2026-06-17T10:00:00+02:00',
      distance: 5000, moving_time: 1800, total_elevation_gain: 0, average_speed: 2.78,
    }
    const parsed = parseStravaLocal(a)
    expect(parsed.getHours()).toBe(10)
    expect(parsed.getMinutes()).toBe(0)
  })

  it('falls back to start_date when start_date_local is absent', () => {
    const a: StravaActivity = {
      id: 3, name: 'T-162 fallback', type: 'Run', sport_type: 'Run',
      start_date: '2026-06-17T10:00:00Z',
      start_date_local: '',
      distance: 5000, moving_time: 1800, total_elevation_gain: 0, average_speed: 2.78,
    }
    // Empty string fallback → uses start_date
    const parsed = parseStravaLocal(a)
    expect(parsed instanceof Date).toBe(true)
    expect(isNaN(parsed.getTime())).toBe(false)
  })
})

// ── T-163: localStorage-Quota management ─────────────────────────────────────
//
// Root-cause: _strava_stream_* / _strava_laps_* grow unboundedly and fill iOS ~5 MB,
// causing saveCachedActivities to silently fail → activities cache frozen → 0 Wochen-km.
//
// Helpers needed: capStreamLapsCaches (evict old stream/laps), evictAllStreamLapsCaches,
// saveCachedActivities (boolean return, evict-then-retry), getStorageWarning/clearStorageWarning.

describe('capStreamLapsCaches (T-163)', () => {
  beforeEach(() => { localStorage.clear() })
  afterEach(() => { localStorage.clear() })

  function makeActivities(n: number): StravaActivity[] {
    return Array.from({ length: n }, (_, i) => ({
      id: i + 1,
      name: `Run ${i + 1}`,
      type: 'Run', sport_type: 'Run',
      // Newer activities have larger indices: start_date_local descending from today
      start_date: new Date(Date.now() - (n - i) * 86400 * 1000).toISOString(),
      start_date_local: new Date(Date.now() - (n - i) * 86400 * 1000).toISOString(),
      distance: 10000, moving_time: 3600, total_elevation_gain: 0, average_speed: 2.78,
    }))
  }

  it('keeps only the N newest stream/laps caches when over cap', () => {
    const acts = makeActivities(60)
    // Populate activities cache so capStreamLapsCaches can sort by date
    localStorage.setItem('strava_activities', JSON.stringify(acts))
    // Add stream+laps cache for all 60 activities
    for (const a of acts) {
      localStorage.setItem(STREAM_CACHE_KEY(a.id), '{"time":[]}')
      localStorage.setItem(LAPS_CACHE_KEY(a.id), '[]')
    }
    capStreamLapsCaches(40)
    // Count remaining stream keys
    let streamCount = 0, lapsCount = 0
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i) || ''
      if (k.startsWith('_strava_stream_')) streamCount++
      if (k.startsWith('_strava_laps_')) lapsCount++
    }
    expect(streamCount).toBe(40)
    expect(lapsCount).toBe(40)
  })

  it('the 40 newest activities (by start_date) remain, oldest 20 are evicted', () => {
    const acts = makeActivities(60)
    localStorage.setItem('strava_activities', JSON.stringify(acts))
    for (const a of acts) {
      localStorage.setItem(STREAM_CACHE_KEY(a.id), `{"time":[${a.id}]}`)
    }
    capStreamLapsCaches(40)
    // acts[0..19] are oldest (ids 1..20), acts[20..59] are newest (ids 21..60)
    for (let i = 1; i <= 20; i++) {
      expect(localStorage.getItem(STREAM_CACHE_KEY(i))).toBeNull()
    }
    for (let i = 21; i <= 60; i++) {
      expect(localStorage.getItem(STREAM_CACHE_KEY(i))).not.toBeNull()
    }
  })

  it('does nothing when under cap', () => {
    const acts = makeActivities(10)
    localStorage.setItem('strava_activities', JSON.stringify(acts))
    for (const a of acts) {
      localStorage.setItem(STREAM_CACHE_KEY(a.id), '{"time":[]}')
    }
    capStreamLapsCaches(40)
    let streamCount = 0
    for (let i = 0; i < localStorage.length; i++) {
      if ((localStorage.key(i) || '').startsWith('_strava_stream_')) streamCount++
    }
    expect(streamCount).toBe(10)
  })

  it('STREAM_CACHE_MAX constant is defined and positive', () => {
    expect(STREAM_CACHE_MAX).toBeGreaterThan(0)
  })
})

describe('evictAllStreamLapsCaches (T-163)', () => {
  beforeEach(() => { localStorage.clear() })
  afterEach(() => { localStorage.clear() })

  it('removes all _strava_stream_* and _strava_laps_* keys', () => {
    localStorage.setItem(STREAM_CACHE_KEY(1), '{"time":[]}')
    localStorage.setItem(STREAM_CACHE_KEY(2), '{"time":[]}')
    localStorage.setItem(LAPS_CACHE_KEY(1), '[]')
    localStorage.setItem('strava_activities', '[{"id":1}]')  // should NOT be removed
    evictAllStreamLapsCaches()
    expect(localStorage.getItem(STREAM_CACHE_KEY(1))).toBeNull()
    expect(localStorage.getItem(STREAM_CACHE_KEY(2))).toBeNull()
    expect(localStorage.getItem(LAPS_CACHE_KEY(1))).toBeNull()
    expect(localStorage.getItem('strava_activities')).not.toBeNull()
  })
})

describe('saveCachedActivities Quota-Fallback (T-163)', () => {
  // Mock strategy: intercept localStorage.setItem via vi.spyOn.
  // The spy tracks a `failCount` that starts at the number of stream keys present.
  // Each call to setItem for ACTS_KEY decrements failCount before deciding to throw.
  // This simulates: first write fails (storage full), eviction removes stream caches,
  // second write succeeds (freed space).

  beforeEach(() => { localStorage.clear(); clearStorageWarning() })
  afterEach(() => { localStorage.clear(); vi.restoreAllMocks() })

  it('evicts stream caches and writes full list on quota error (no 500-trim)', () => {
    // Seed stream caches
    for (let i = 1; i <= 5; i++) {
      localStorage.setItem(STREAM_CACHE_KEY(i), '{"time":[]}')
    }

    const acts: StravaActivity[] = Array.from({ length: 10 }, (_, i) => ({
      id: i + 100, name: `A${i}`, type: 'Run', sport_type: 'Run',
      start_date: new Date(Date.now() - i * 86400000).toISOString(),
      start_date_local: new Date(Date.now() - i * 86400000).toISOString(),
      distance: 5000, moving_time: 1800, total_elevation_gain: 0, average_speed: 2.78,
    }))

    // The spy throws exactly once for ACTS_KEY (simulating quota full on first try,
    // then succeeds after stream eviction frees space). All other keys pass through.
    let actsWriteAttempt = 0
    const origSetItem = Storage.prototype.setItem.bind(localStorage)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function(this: Storage, key: string, value: string) {
      if (key === 'strava_activities') {
        actsWriteAttempt++
        if (actsWriteAttempt === 1) {
          // First attempt fails — simulates quota full with stream caches present
          const err = new DOMException('QuotaExceededError', 'QuotaExceededError')
          throw err
        }
      }
      // All other writes (and ACTS_KEY on 2nd+ attempt) go through real storage
      origSetItem(key, value)
    })

    const ok = saveCachedActivities(acts)
    expect(ok).toBe(true)

    // Restore before assertions that call getCachedActivities (which uses getItem, unaffected)
    vi.restoreAllMocks()

    // Full list persisted (not trimmed to 500)
    const loaded = getCachedActivities()
    expect(loaded.length).toBe(10)

    // Stream caches were evicted
    let streamCount = 0
    for (let i = 0; i < localStorage.length; i++) {
      if ((localStorage.key(i) || '').startsWith('_strava_stream_')) streamCount++
    }
    expect(streamCount).toBe(0)

    // No storage warning (save succeeded)
    expect(getStorageWarning()).toBeNull()
  })

  it('unhealable quota error → returns false, sets STORAGE_WARNING_KEY, does not throw', () => {
    const acts: StravaActivity[] = [{ id: 1, name: 'A', type: 'Run', sport_type: 'Run',
      start_date: new Date().toISOString(), start_date_local: new Date().toISOString(),
      distance: 5000, moving_time: 1800, total_elevation_gain: 0, average_speed: 2.78 }]

    // Always throw for ACTS_KEY — even after eviction — simulating truly full storage.
    // STORAGE_WARNING_KEY writes are allowed through so the warning is set.
    const origSetItem = Storage.prototype.setItem.bind(localStorage)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function(this: Storage, key: string, value: string) {
      if (key === 'strava_activities') {
        const err = new DOMException('QuotaExceededError', 'QuotaExceededError')
        throw err
      }
      // All other keys (including STORAGE_WARNING_KEY) write through
      origSetItem(key, value)
    })

    let threw = false
    let result: boolean
    try {
      result = saveCachedActivities(acts)
    } catch {
      threw = true
      result = false
    }
    vi.restoreAllMocks()

    expect(threw).toBe(false)
    expect(result!).toBe(false)
    // Warning flag was set
    expect(localStorage.getItem(STORAGE_WARNING_KEY)).not.toBeNull()
  })

  it('successful save clears STORAGE_WARNING_KEY', () => {
    // Pre-set a warning
    localStorage.setItem(STORAGE_WARNING_KEY, '1')

    const acts: StravaActivity[] = [{ id: 2, name: 'B', type: 'Run', sport_type: 'Run',
      start_date: new Date().toISOString(), start_date_local: new Date().toISOString(),
      distance: 5000, moving_time: 1800, total_elevation_gain: 0, average_speed: 2.78 }]

    const ok = saveCachedActivities(acts)
    expect(ok).toBe(true)
    expect(getStorageWarning()).toBeNull()
  })
})

describe('getStorageWarning / clearStorageWarning (T-163)', () => {
  beforeEach(() => { clearStorageWarning() })
  afterEach(() => { clearStorageWarning() })

  it('getStorageWarning returns null when no flag set', () => {
    expect(getStorageWarning()).toBeNull()
  })

  it('clearStorageWarning removes the flag', () => {
    localStorage.setItem(STORAGE_WARNING_KEY, '1')
    clearStorageWarning()
    expect(getStorageWarning()).toBeNull()
  })
})

// ── T-170: saveTokens quota hardening — "schlimmster Fall" (OAuth-Token nicht persistiert) ──

describe('saveTokens quota hardening (T-170)', () => {
  beforeEach(() => { localStorage.clear() })
  afterEach(() => { vi.restoreAllMocks(); localStorage.clear() })

  const tokens = { access_token: 'a', refresh_token: 'r', expires_at: Date.now() / 1000 + 3600 }

  it('successful save → true, tokens persisted', () => {
    expect(saveTokens(tokens)).toBe(true)
    expect(loadTokens()?.access_token).toBe('a')
  })

  it('quota exhausted (unhealable) → false, no throw, STORAGE_WARNING_KEY set, tokens NOT persisted', () => {
    const origSetItem = Storage.prototype.setItem.bind(localStorage)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === 'strava_tokens') throw new DOMException('QuotaExceededError', 'QuotaExceededError')
      origSetItem(key, value)
    })

    let threw = false
    let ok = true
    try { ok = saveTokens(tokens) } catch { threw = true }
    vi.restoreAllMocks()

    expect(threw).toBe(false)
    expect(ok).toBe(false)
    // Worst case from the ticket: silent OAuth-persist-failure would leave the user
    // logged out without any signal. A caller ignoring the return value would never know.
    expect(loadTokens()).toBeNull()
    expect(getStorageWarning()).not.toBeNull()
  })
})

// ── T-170: exchangeCode propagates saveTokens failure instead of pretending success ──

describe('exchangeCode — storage quota propagation (T-170)', () => {
  beforeEach(() => { localStorage.clear() })
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear() })

  it('quota exhausted during token persist → rejects with storage_quota marker, does not silently succeed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ access_token: 'a', refresh_token: 'r', expires_at: Date.now() / 1000 + 3600 }),
    })))
    const origSetItem = Storage.prototype.setItem.bind(localStorage)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === 'strava_tokens') throw new DOMException('QuotaExceededError', 'QuotaExceededError')
      origSetItem(key, value)
    })

    await expect(exchangeCode('some-code')).rejects.toThrow(/storage_quota/)
    expect(loadTokens()).toBeNull()
  })
})

describe('thisWeekKm + thisWeekStatsBySport (T-162 regression — Z-suffix bug)', () => {
  // Run finished 5 minutes ago in Strava's real format: local wallclock time + 'Z' suffix.
  // Before fix: new Date('…T<now+2h>:…Z') > now → filtered OUT of week KPIs.
  // After fix: parsed as local time → d <= now → counted IN.

  function makeRecentRun(distanceM: number): StravaActivity {
    // Build a start_date_local that is 5 minutes ago in LOCAL time with 'Z' suffix
    // (mirroring exactly what Strava sends: local clock + 'Z').
    const fiveMinsAgo = new Date(Date.now() - 5 * 60 * 1000)
    const localStr = fiveMinsAgo.getFullYear()
      + '-' + String(fiveMinsAgo.getMonth() + 1).padStart(2, '0')
      + '-' + String(fiveMinsAgo.getDate()).padStart(2, '0')
      + 'T' + String(fiveMinsAgo.getHours()).padStart(2, '0')
      + ':' + String(fiveMinsAgo.getMinutes()).padStart(2, '0')
      + ':' + String(fiveMinsAgo.getSeconds()).padStart(2, '0')
      + 'Z'  // real Strava 'Z' on local time

    return {
      id: 999, name: 'Fresh run T-162', type: 'Run', sport_type: 'Run',
      start_date: new Date(Date.now() - 5 * 60 * 1000 - 7200 * 1000).toISOString(), // actual UTC
      start_date_local: localStr,
      distance: distanceM,
      moving_time: 1800,
      total_elevation_gain: 0,
      average_speed: 2.78,
      workout_type: 0,
    }
  }

  it('thisWeekKm counts a run finished 5 min ago (real Strava Z-suffix format)', () => {
    const run = makeRecentRun(10000)  // 10 km
    const km = thisWeekKm([run])
    // Expected: 10.0 km. Before fix: 0 (filtered by d > now due to UTC misparse).
    expect(km).toBeCloseTo(10.0, 1)
  })

  it('thisWeekStatsBySport.run.km counts a run finished 5 min ago (real Strava Z-suffix)', () => {
    const run = makeRecentRun(8000)  // 8 km
    const stats = thisWeekStatsBySport([run])
    expect(stats.run.km).toBeCloseTo(8.0, 1)
  })
})

describe('classifyWorkoutStructure — Trabpausen trennen Reps (T-165)', () => {
  function buildStream(segments: [number, number][], dt = 1): { time: number[]; vel: number[] } {
    const time: number[] = []; const vel: number[] = []; let tt = 0
    for (const [speed, dur] of segments) {
      for (let i = 0; i < Math.round(dur / dt); i++) { time.push(tt); vel.push(speed); tt += dt }
    }
    return { time, vel }
  }

  it('5×1000m mit 80s-Trabpause → 5 getrennte Blöcke (nicht gemergt)', () => {
    const rep: [number, number] = [4.0, 250]
    const rec: [number, number] = [2.9, 80]
    const segs: [number, number][] = [[2.9, 60], rep, rec, rep, rec, rep, rec, rep, rec, rep, [2.9, 60]]
    const { time, vel } = buildStream(segs)
    const cls = classifyWorkoutStructure(time, vel, undefined, 45)
    const nBlocks = cls.tempoBlocks.length + cls.intervalBlocks.length
    expect(nBlocks).toBe(5)
  })

  it('durchgehender 20-min-Tempolauf → genau 1 Block (kein Fragmentieren)', () => {
    const segs: [number, number][] = [[2.9, 60], [4.0, 1200], [2.9, 60]]
    const { time, vel } = buildStream(segs)
    const cls = classifyWorkoutStructure(time, vel, undefined, 45)
    const nBlocks = cls.tempoBlocks.length + cls.intervalBlocks.length
    expect(nBlocks).toBe(1)
  })
})

// ── T-184: activityTemps enrichment from sync.json ──────────────────────────
// Desktop (T-183) resolves real weather per-activity and ships it via the
// sync.json top-level key `activityTemps` (id-as-string → °C). The PWA must
// NOT re-implement the weather lookup (D-031 rounding stays in one place) —
// it only enriches its own fetched activities when Strava's own
// `average_temp` field (device-recorded) is absent.
//
// Falle (per Ticket): `average_temp ?? activityTemps[String(id)]` MUST use a
// nullish-check, not truthiness — otherwise a real 0 °C reading is treated as
// "missing" (identical bug class to plannedKm === 0 in T-169).
describe('parseAllActivities / parseRuns — activityTemps enrichment (T-184)', () => {
  it('average_temp present on the activity → used as-is, activityTemps ignored', () => {
    const activityTemps = { '1': 99 }  // deliberately wrong value — must NOT win
    const a = makeActivity({ id: 1, average_temp: 22.4 })
    expect(parseAllActivities([a], activityTemps)[0].tempC).toBe(22.4)
    expect(parseRuns([a], activityTemps)[0].tempC).toBe(22.4)
  })

  it('average_temp absent → falls back to activityTemps[String(id)]', () => {
    const activityTemps = { '1': 31.8 }
    const a = makeActivity({ id: 1, average_temp: undefined })
    expect(parseAllActivities([a], activityTemps)[0].tempC).toBe(31.8)
    expect(parseRuns([a], activityTemps)[0].tempC).toBe(31.8)
  })

  it('0 °C on average_temp survives (falsy-but-defined must not be overridden)', () => {
    const activityTemps = { '1': 99 }  // would win if truthiness (0 is falsy) were used
    const a = makeActivity({ id: 1, average_temp: 0 })
    expect(parseAllActivities([a], activityTemps)[0].tempC).toBe(0)
    expect(parseRuns([a], activityTemps)[0].tempC).toBe(0)
  })

  it('0 °C in activityTemps survives when average_temp is absent (falsy-zero fallback value)', () => {
    const activityTemps = { '1': 0 }
    const a = makeActivity({ id: 1, average_temp: undefined })
    expect(parseAllActivities([a], activityTemps)[0].tempC).toBe(0)
    expect(parseRuns([a], activityTemps)[0].tempC).toBe(0)
  })

  it('missing key for this activity id → tempC stays undefined, no error', () => {
    const activityTemps = { '999': 15 }  // some other activity, not this one
    const a = makeActivity({ id: 1, average_temp: undefined })
    expect(parseAllActivities([a], activityTemps)[0].tempC).toBeUndefined()
    expect(parseRuns([a], activityTemps)[0].tempC).toBeUndefined()
  })

  it('no sync ever happened (activityTemps argument omitted) → tempC stays undefined, no error', () => {
    const a = makeActivity({ id: 1, average_temp: undefined })
    expect(parseAllActivities([a])[0].tempC).toBeUndefined()
    expect(parseRuns([a])[0].tempC).toBeUndefined()
  })

  it('numeric activity id resolves against string-keyed activityTemps map (JSON object keys)', () => {
    const activityTemps = { '15331702246': 22.4 }
    const a = makeActivity({ id: 15331702246, average_temp: undefined })
    expect(parseAllActivities([a], activityTemps)[0].tempC).toBe(22.4)
  })

  // Coordinator review (T-184 fix-loop): components memoize parseRuns/parseAllActivities on
  // `[cached]` only (React useMemo). A hidden module-level store mutated by setActivityTemps()
  // AFTER the first render is invisible to that dependency array — the component never
  // re-parses, so tempC stays missing until `cached` itself changes on the next Strava sync.
  // This test models the real sequence: parse once ("first render", sync not yet resolved),
  // THEN the sync arrives, THEN the value the component actually uses must contain the temp.
  // Because the fix removes the hidden store entirely and makes activityTemps an explicit
  // second argument, `cached` alone can no longer be the correct memoization key — callers must
  // include the temps map itself in their deps. This assertion is the contract that proves it.
  it('activityTemps must be an explicit input the caller (and its useMemo deps) can see — not a hidden global mutated after first parse', () => {
    const a = makeActivity({ id: 1, average_temp: undefined })

    // "First render": sync.json has not resolved yet, so the caller passes an empty map.
    const beforeSync = parseRuns([a], {})[0]?.tempC
    expect(beforeSync).toBeUndefined()

    // "Sync resolves": the caller now has the fetched activityTemps map and re-invokes with
    // the SAME `cached`/`a` but the new map as an explicit argument — exactly what a
    // `useMemo(() => parseRuns(cached, syncedActivityTemps), [cached, syncedActivityTemps])`
    // recomputes to once `syncedActivityTemps` state changes.
    const afterSync = parseRuns([a], { '1': 31.5 })[0]?.tempC
    expect(afterSync).toBe(31.5)
  })
})

// ── T-052 Nachzug (19.08.2026) ────────────────────────────────────────────────
// T-052 hat den Ø-Peak-Pace-Nenner in `streams.detect_strides` gefixt (Nenner =
// Anzahl GUELTIGER peak_pace_sec statt len(strides)). Die PWA wurde damals als
// "strukturell bug-frei" abgehakt — mit zwei Begruendungen, die inzwischen
// erodiert sind: (1) "peakMs = Math.max(...seg), also immer > 0" — genau diese
// Zeile wurde in T-193 auf `smoothed[peakIdx]` geaendert; (2) "detectStrides hat
// keine Call-Site, Parity-Thema inaktiv" — es hat laengst eine (`loadAnalyticsStreams`).
// Die Invariante haelt weiterhin, aber sie lebte nur als Prosa im Review-File.
// Diese Tests nageln sie fest, damit der naechste Eingriff in die Peak-Ermittlung
// sie nicht still bricht.
describe('detectStrides — T-052-Invariante: Nenner == Anzahl gueltiger Peak-Paces', () => {
  // Easy-Basis 3.0 m/s (= 5:33/km) mit zwei klar abgesetzten Stride-Plateaus bei
  // 5.0 m/s. Kein vdot uebergeben -> _vdotAnchor liefert null -> refSpeed = avgSpeed.
  function makeStrideStream() {
    const v: number[] = []
    const push = (val: number, secs: number) => { for (let i = 0; i < secs; i++) v.push(val) }
    push(3.0, 30); push(5.0, 14); push(3.0, 30); push(5.0, 14); push(3.0, 30)
    return {
      time: v.map((_, i) => i),
      velocity_smooth: v,
      heartrate: v.map(() => 150),
      altitude: v.map(() => 100),
    }
  }

  it('erkennt Strides und liefert ausschliesslich positive Peak-Paces', () => {
    const r = detectStrides(makeStrideStream(), 333)
    expect(r.strideCount).toBeGreaterThan(0)
    // Kern der Invariante: der `: 0`-Fallback in `peakPaceSec` ist unerreichbar.
    for (const s of r.strides) expect(s.peakPaceSec).toBeGreaterThan(0)
  })

  it('mittelt ueber genau die erfassten Strides (Nenner == strides.length)', () => {
    const r = detectStrides(makeStrideStream(), 333)
    // Erwartungswert aus der Formel gerechnet, nicht geraten (Projektregel).
    const expected = Math.round(r.strides.reduce((s, st) => s + st.peakPaceSec, 0) / r.strides.length)
    expect(r.avgPeakPaceSec).toBe(expected)
    // Solange kein peakPaceSec 0/None sein kann, ist strides.length identisch zum
    // Python-Nenner len(_valid_paces) — das ist die eigentliche T-052-Aussage.
    const valid = r.strides.filter(s => s.peakPaceSec > 0)
    expect(valid.length).toBe(r.strides.length)
  })

  it('erzeugt auch im entarteten Fall (refSpeed 0) keinen Stride mit Peak-Pace 0', () => {
    // avgPaceSec = 0 und kein vdot -> refSpeed = 0 -> peakThreshold = 0. Die
    // Peak-Bedingung ist `>=`, ein 0-Plateau erfuellt sie also formal. Ein 0-Peak
    // hat aber zwingend 0-Nachbarn -> das Trace-Fenster kollabiert -> Dauer- und
    // Distanzfilter werfen ihn raus, bevor `peakPaceSec` gebildet wird.
    const v = [0, 0, 0, 0, 0, 3.0, 5.0, 5.0, 5.0, 3.0, 0, 0, 0, 0, 0]
    const r = detectStrides({
      time: v.map((_, i) => i), velocity_smooth: v,
      heartrate: v.map(() => 150), altitude: v.map(() => 100),
    }, 0)
    for (const s of r.strides) expect(s.peakPaceSec).toBeGreaterThan(0)
    expect(r.avgPeakPaceSec === null || r.avgPeakPaceSec > 0).toBe(true)
  })
})

// ── T-194 Golden-Parität: Desktop ↔ PWA ──────────────────────────────────────
// Zwilling zu tests/test_coach.py::test_t194_golden_parity_values_desktop_side.
// `vdotTrendFromActivities` passt nicht ins Stream-Fixture-Harness aus T-171
// (gleitendes Zeitfenster statt zeitunabhängiger Streams), deshalb dieses
// hand­gepflegte Wertepaar: DIESELBE Eingabe, DIESELBEN Erwartungswerte.
// Python ist die Referenz (CLAUDE.md). Weicht diese Seite ab, weicht die PWA ab.
// Auslöser: T-139 normalisierte Gelände/Hitze nur im Desktop-`best_vdot`, T-140
// zusätzlich im PWA-Trend — der Desktop-Trend blieb roh. Ergebnis: +1.9 vs +2.8
// für identische Aktivitäten.

describe('vdotTrendFromActivities — T-194 Golden-Parität zu coach.vdot_trend', () => {
  const GOLDEN: [number, number][] = [
    [49, 240], [42, 245], [35, 243],   // frühe Hälfte
    [21, 235], [14, 232], [7, 230],    // aktuelle Hälfte
  ]

  it('liefert dieselben early/recent/delta wie die Python-Referenz', () => {
    const runs = GOLDEN.map(([daysAgo, paceSec]) => ({
      ...makeRun(daysAgo, 10, paceSec, 160),
      elevationM: 0,
      tempC: undefined,
    }))
    const res = vdotTrendFromActivities(runs, 45, 190, 50)
    expect(res).not.toBeNull()
    expect(res!.early).toBeCloseTo(51.2, 1)
    expect(res!.recent).toBeCloseTo(54.0, 1)
    expect(res!.delta).toBeCloseTo(2.8, 1)
    expect(res!.direction).toBe('↑')
    expect([res!.nEarly, res!.nRecent]).toEqual([3, 3])
  })
})
