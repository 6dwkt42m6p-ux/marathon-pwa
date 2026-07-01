import { describe, it, expect, beforeEach } from 'vitest'
import {
  effectiveWindow, activeInjuryBreak, buildStartMutation, buildEndMutation,
  loadPendingMutation, savePendingMutation, clearPendingMutation,
  isPendingMutationApplied,
  type RawInjuryBreak,
} from './injury'
// T-079-Gotcha: effectiveWindow() gibt lokale Mitternachts-Dates zurück (new Date(str+'T00:00:00')).
// toISOString().slice(0,10) shiftet nach UTC und liefert in TZ östlich von UTC den Vortag —
// localISODate() (TZ-frei) ist die korrekte Assertion-Methode, nicht die Implementierung.
import { localISODate } from './strava'

function mkBreak(overrides: Partial<RawInjuryBreak> = {}): RawInjuryBreak {
  return {
    id: 'b1', start: '2026-06-21', est_days: 9, severity: 'minor',
    end: null, note: '', created_at: '2026-06-21T10:00:00',
    ...overrides,
  }
}

describe('effectiveWindow', () => {
  it('uses start + est_days when open (no end)', () => {
    const { start, end } = effectiveWindow(mkBreak({ start: '2026-06-21', est_days: 9, end: null }))
    expect(localISODate(start)).toBe('2026-06-21')
    expect(localISODate(end)).toBe('2026-06-30')
  })

  it('uses explicit end when set, ignoring est_days', () => {
    const { end } = effectiveWindow(mkBreak({ start: '2026-06-21', est_days: 30, end: '2026-06-25' }))
    expect(localISODate(end)).toBe('2026-06-25')
  })
})

describe('activeInjuryBreak', () => {
  it('returns the break covering today', () => {
    const b = mkBreak({ start: '2026-06-21', est_days: 9, end: null })
    const today = new Date('2026-06-25T00:00:00')
    expect(activeInjuryBreak([b], today)).toEqual(b)
  })

  it('returns null when today is before the break start', () => {
    const b = mkBreak({ start: '2026-06-21', est_days: 9, end: null })
    const today = new Date('2026-06-01T00:00:00')
    expect(activeInjuryBreak([b], today)).toBeNull()
  })

  it('returns null for a break that already has an end set', () => {
    const b = mkBreak({ start: '2026-06-21', est_days: 9, end: '2026-06-23' })
    const today = new Date('2026-06-25T00:00:00')
    expect(activeInjuryBreak([b], today)).toBeNull()
  })

  it('skips an ended break even if today falls within its original est_days window', () => {
    const b = mkBreak({ start: '2026-06-21', est_days: 30, end: '2026-06-23' })
    const today = new Date('2026-06-28T00:00:00')
    expect(activeInjuryBreak([b], today)).toBeNull()
  })
})

describe('mutation builders', () => {
  it('buildStartMutation carries all form fields', () => {
    const m = buildStartMutation('2026-07-01', 7, 'moderate', 'Knie')
    expect(m.type).toBe('start')
    expect(m.start).toBe('2026-07-01')
    expect(m.est_days).toBe(7)
    expect(m.severity).toBe('moderate')
    expect(m.note).toBe('Knie')
    expect(typeof m.ts).toBe('string')
  })

  it('buildEndMutation carries break_id and end date', () => {
    const m = buildEndMutation('b1', '2026-07-03')
    expect(m.type).toBe('end')
    expect(m.break_id).toBe('b1')
    expect(m.end).toBe('2026-07-03')
  })
})

describe('pending-mutation overlay', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('returns null when nothing is pending', () => {
    expect(loadPendingMutation()).toBeNull()
  })

  it('save then load roundtrips the mutation', () => {
    const m = buildStartMutation('2026-07-01', 5, 'minor', '')
    savePendingMutation(m)
    expect(loadPendingMutation()).toEqual(m)
  })

  it('clear removes the pending mutation', () => {
    savePendingMutation(buildEndMutation('b1', '2026-07-03'))
    clearPendingMutation()
    expect(loadPendingMutation()).toBeNull()
  })
})

describe('isPendingMutationApplied', () => {
  it('detects an applied start mutation', () => {
    const m = buildStartMutation('2026-07-01', 5, 'minor', '')
    const breaks = [mkBreak({ start: '2026-07-01', end: null })]
    expect(isPendingMutationApplied(m, breaks)).toBe(true)
  })

  it('does not detect an unapplied start mutation', () => {
    const m = buildStartMutation('2026-07-01', 5, 'minor', '')
    expect(isPendingMutationApplied(m, [])).toBe(false)
  })

  it('detects an applied end mutation', () => {
    const m = buildEndMutation('b1', '2026-07-03')
    const breaks = [mkBreak({ id: 'b1', end: '2026-07-03' })]
    expect(isPendingMutationApplied(m, breaks)).toBe(true)
  })

  it('does not detect an unapplied end mutation', () => {
    const m = buildEndMutation('b1', '2026-07-03')
    const breaks = [mkBreak({ id: 'b1', end: null })]
    expect(isPendingMutationApplied(m, breaks)).toBe(false)
  })
})
