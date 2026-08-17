// T-158(a): assessDeviation — plannedKm=0 neutral path + regression guards
// Test-first: rot zuerst (plannedKm<=0 guard), dann grün nach Impl.

import { describe, it, expect } from 'vitest'
import { assessDeviation, weeklyPlanStatus, isPlanStale } from './plan'
import type { WorkoutSession, SyncedPlan } from './plan'
import type { ActivitySummary } from './strava'

function makeSession(overrides: Partial<WorkoutSession> = {}): WorkoutSession {
  return {
    session:   'Easy Run',
    typ:       'Easy',
    distanzKm: 10,
    vorgabe:   '5:30/km',
    struktur:  '60 min Easy',
    dauerMin:  '60',
    hinweis:   '',
    wochentag: 'Mo',
    ...overrides,
  }
}

function makeActivity(overrides: Partial<ActivitySummary> = {}): ActivitySummary {
  return {
    id:          1,
    name:        'Test Run',
    date:        new Date('2026-07-07T08:00:00'),
    distanceKm:  10,
    paceSec:     330,
    actType:     'run',
    durationSec: 3300,
    avgHr:       140,
    maxHr:       165,
    suffer:      40,
    isTrail:     false,
    workoutType: 1,
    ...overrides,
  } as ActivitySummary
}

describe('assessDeviation — T-158(a): plannedKm <= 0 neutral path', () => {
  it('returns neutral badge when distanzKm is "Renndistanz" (non-numeric string)', () => {
    const session = makeSession({ distanzKm: 'Renndistanz' })
    const act = makeActivity({ distanceKm: 42 })
    const result = assessDeviation(session, act, null, 5)
    // Must NOT produce badge 'mehr' or 'weniger' — race day is special
    expect(result.badge).not.toBe('mehr')
    expect(result.badge).not.toBe('weniger')
    // Must NOT claim Infinity (deutlich mehr Volumen)
    expect(result.coachComment).not.toContain('Deutlich mehr Volumen')
  })

  it('returns neutral badge when distanzKm is "—" (dash placeholder)', () => {
    const session = makeSession({ distanzKm: '—' })
    const act = makeActivity({ distanceKm: 5 })
    const result = assessDeviation(session, act, null, 5)
    expect(result.badge).not.toBe('mehr')
    expect(result.badge).not.toBe('weniger')
    expect(result.coachComment).not.toContain('Deutlich mehr Volumen')
  })

  it('returns badge "plangemäß" or "frei" when distanzKm is 0', () => {
    const session = makeSession({ distanzKm: 0 })
    const act = makeActivity({ distanceKm: 5 })
    const result = assessDeviation(session, act, null, 5)
    expect(['plangemäß', 'frei']).toContain(result.badge)
    // T-158(a): kmDelta must be 0 (not actualKm) to avoid spurious "+X km" pill on race/special days
    expect(result.kmDelta).toBe(0)
  })

  it('comment mentions Sondereinheit or similar — no km-Soll language', () => {
    const session = makeSession({ distanzKm: 'Renndistanz' })
    const act = makeActivity({ distanceKm: 42 })
    const result = assessDeviation(session, act, null, 5)
    // Should explain this is a special session with no km target
    expect(result.coachComment.length).toBeGreaterThan(5)
    expect(result.coachComment).not.toContain('Volumen als geplant')
  })
})

describe('assessDeviation — regression: plannedKm > 0 unchanged', () => {
  it('badge "mehr" when actual is 25% above planned (>20% threshold)', () => {
    const session = makeSession({ distanzKm: 10 })
    const act = makeActivity({ distanceKm: 12.5 }) // 25% more
    const result = assessDeviation(session, act, null, 5)
    expect(result.badge).toBe('mehr')
    expect(result.coachComment).toContain('Deutlich mehr Volumen')
  })

  it('badge "weniger" when actual is 60% of planned (<70% threshold)', () => {
    const session = makeSession({ distanzKm: 10 })
    const act = makeActivity({ distanceKm: 6 }) // 60%
    const result = assessDeviation(session, act, null, 5)
    expect(result.badge).toBe('weniger')
  })

  it('badge "plangemäß" when actual is within ±20% of planned', () => {
    const session = makeSession({ distanzKm: 10 })
    const act = makeActivity({ distanceKm: 10.5 }) // 5% more → within range
    const result = assessDeviation(session, act, null, 5)
    expect(result.badge).toBe('plangemäß')
  })

  it('badge "mehr" for intensity mismatch (easy planned, quality done)', () => {
    const session = makeSession({ distanzKm: 10, typ: 'Easy' })
    const act = makeActivity({ distanceKm: 10 })
    const qualityClassification = { workoutType: 'intervals' as const, strides: [], intervalBlocks: [], tempoBlocks: [] }
    const result = assessDeviation(session, act, qualityClassification, 5)
    expect(result.badge).toBe('mehr')
    expect(result.coachComment).toContain('Intensiver als geplant')
  })

  it('null plannedSession → badge "frei" (rest day path, not neutral path)', () => {
    const act = makeActivity({ distanceKm: 8 })
    const result = assessDeviation(null, act, null, 5)
    expect(result.badge).toBe('frei')
    expect(result.coachComment).toContain('Kein Plantag')
  })
})

describe('weeklyPlanStatus — T-169 follow-up: no-plan vs. plan-says-0-km', () => {
  // Regression guard for real sync.json data: coach.py T-131 writes planned_km = 0.0
  // for full injury-break/vacation weeks. That must render differently from "not synced".
  it('returns "no-plan" when plannedKm is null (no synced week for this date)', () => {
    expect(weeklyPlanStatus(null)).toBe('no-plan')
  })

  it('returns "zero-planned" when plannedKm is 0 (injury-break/vacation week, T-131)', () => {
    expect(weeklyPlanStatus(0)).toBe('zero-planned')
  })

  it('returns "planned" when plannedKm is a positive number', () => {
    expect(weeklyPlanStatus(45.2)).toBe('planned')
  })

  it('never treats 0 and null the same (regression: naive `plannedKm > 0` truthiness check)', () => {
    expect(weeklyPlanStatus(0)).not.toBe(weeklyPlanStatus(null))
  })
})

// ── isPlanStale — T-182 Phase B: the sync `settings` block is now actually written by the
// Desktop (T-182 Phase A). Before that, this raceDate1/raceDate2 branch was structurally dead
// (B3 in T-182) — no test ever exercised it. These tests pin the now-real behaviour, in
// particular that a disabled Event 1 (raceDate1: null) must NOT be misread as a mismatch.
describe('isPlanStale — race-date branch via sync settings block (T-182)', () => {
  function makePlan(overrides: Partial<SyncedPlan> = {}): SyncedPlan {
    return {
      schemaVersion: 1,
      generatedAt:   new Date().toISOString(),  // fresh — avoid the age-based staleness branch
      generatedBy:   'streamlit',
      vdot:          50,
      paces:         { E_high: '5:00', E_low: '5:30', M: '4:30', T: '4:00', I: '3:40', R: '1:30' },
      inputHash:     'abc',
      weeks:         [],
      ...overrides,
    }
  }

  const LOCAL_D1 = '2026-10-11'
  const LOCAL_D2 = '2027-04-25'

  it('no settings block at all (older sync.json, pre T-182) → not stale (regression guard)', () => {
    const plan = makePlan()
    expect(isPlanStale(plan, 50, LOCAL_D1, LOCAL_D2, null)).toBe(false)
  })

  it('settings block present but raceDate1/raceDate2 keys absent → not stale', () => {
    const plan = makePlan()
    expect(isPlanStale(plan, 50, LOCAL_D1, LOCAL_D2, {})).toBe(false)
  })

  it('raceDate1 matches local → not stale', () => {
    const plan = makePlan()
    expect(isPlanStale(plan, 50, LOCAL_D1, LOCAL_D2, { raceDate1: LOCAL_D1, raceDate2: LOCAL_D2 })).toBe(false)
  })

  it('raceDate1 diverges from local → stale', () => {
    const plan = makePlan()
    expect(isPlanStale(plan, 50, LOCAL_D1, LOCAL_D2, { raceDate1: '2026-11-01', raceDate2: LOCAL_D2 })).toBe(true)
  })

  it('raceDate2 diverges from local → stale', () => {
    const plan = makePlan()
    expect(isPlanStale(plan, 50, LOCAL_D1, LOCAL_D2, { raceDate1: LOCAL_D1, raceDate2: '2027-05-01' })).toBe(true)
  })

  it('raceDate1: null (Event 1 / prep race disabled on Desktop) → NOT stale, not a mismatch', () => {
    // Guards against a future "cleanup" turning `d1 &&` into a strict `d1 !== undefined` check,
    // which would misread "disabled" as "diverges from local" and show a false staleness banner.
    const plan = makePlan()
    expect(isPlanStale(plan, 50, LOCAL_D1, LOCAL_D2, { raceDate1: null, raceDate2: LOCAL_D2 })).toBe(false)
  })

  it('raceDate1: null with raceDate2 still diverging → stale (raceDate2 branch independent)', () => {
    const plan = makePlan()
    expect(isPlanStale(plan, 50, LOCAL_D1, LOCAL_D2, { raceDate1: null, raceDate2: '2027-06-01' })).toBe(true)
  })
})
