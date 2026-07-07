// T-158(a): assessDeviation — plannedKm=0 neutral path + regression guards
// Test-first: rot zuerst (plannedKm<=0 guard), dann grün nach Impl.

import { describe, it, expect } from 'vitest'
import { assessDeviation } from './plan'
import type { WorkoutSession } from './plan'
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
