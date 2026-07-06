// T-157: Week error field — Regressionsschutz für session-build-error Hinweis
// Test-first: rot vor Impl (weekHasSessionError), grün danach.

import { describe, it, expect } from 'vitest'
import { weekHasSessionError, assessDeviationForRestDay } from './plan'
import type { SyncedPlanWeek } from './githubSync'
import type { ActivitySummary } from './strava'

function makeWeek(overrides: Partial<SyncedPlanWeek> = {}): SyncedPlanWeek {
  return {
    week_nr:    1,
    week_start: '2026-07-06',
    phase:      'Basis',
    planned_km: 50,
    is_current: true,
    sessions:   [],
    ...overrides,
  }
}

function makeActivity(overrides: Partial<ActivitySummary> = {}): ActivitySummary {
  return {
    id:         1,
    name:       'Easy Run',
    date:       new Date('2026-07-07T07:00:00'),
    distanceKm: 10,
    paceSec:    360,
    actType:    'run',
    durationSec: 3600,
    avgHr:      140,
    maxHr:      165,
    suffer:     50,
    isTrail:    false,
    workoutType: 1,
    ...overrides,
  } as ActivitySummary
}

describe('weekHasSessionError — T-157', () => {
  it('returns true when error is "sessions_failed" (canonical Desktop value)', () => {
    const week = makeWeek({ error: 'sessions_failed' })
    expect(weekHasSessionError(week)).toBe(true)
  })

  it('returns true for any truthy error string (defensive)', () => {
    const week = makeWeek({ error: 'unknown_error' })
    expect(weekHasSessionError(week)).toBe(true)
  })

  it('returns false when error field is absent (normal week — no hint shown)', () => {
    const week = makeWeek()
    expect(weekHasSessionError(week)).toBe(false)
  })

  it('returns false when error is an empty string', () => {
    const week = makeWeek({ error: '' })
    expect(weekHasSessionError(week)).toBe(false)
  })

  it('returns false when error is undefined explicitly', () => {
    const week = makeWeek({ error: undefined })
    expect(weekHasSessionError(week)).toBe(false)
  })
})

describe('deviation suppression for error weeks — T-157 cross-review fix', () => {
  // These tests verify the guard predicate: !weekHasSessionError(week) gates the deviation call.
  // The component logic is: if (syncedWeek && !weekHasSessionError(syncedWeek)) { assessDeviation... }
  // We test that the gate correctly prevents/allows the call in each case.

  it('error week → guard blocks deviation (no "Ruhetag trainiert" contradiction)', () => {
    const errorWeek = makeWeek({ error: 'sessions_failed', sessions: [] })
    // Simulates component guard: only call assessDeviationForRestDay when NOT an error week
    const act = makeActivity()
    const tsb = 5
    let deviation = null
    if (!weekHasSessionError(errorWeek)) {
      deviation = assessDeviationForRestDay(act, tsb)
    }
    expect(deviation).toBeNull()
  })

  it('normal week with no matching session → deviation is produced (rest-day regression guard)', () => {
    const normalWeek = makeWeek({ sessions: [] })  // no error, but no sessions either
    const act = makeActivity()
    const tsb = 5
    let deviation = null
    if (!weekHasSessionError(normalWeek)) {
      deviation = assessDeviationForRestDay(act, tsb)
    }
    // assessDeviationForRestDay returns a non-null deviation for any activity on a rest day
    expect(deviation).not.toBeNull()
    expect(deviation!.badge).toBe('ruhetag')
  })
})
