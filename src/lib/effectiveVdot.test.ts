import { describe, it, expect } from 'vitest'
import { selectEffectiveVdot } from './vdot'

// T-123: effectiveVdot selector — single canonical VDOT source.
// Rule: synced plan vdot (desktop SSoT) wins when a sync is present;
//       settings.vdot is the fallback for offline / no sync.

describe('selectEffectiveVdot (T-123)', () => {
  it('returns syncedVdot when a synced plan vdot is present', () => {
    expect(selectEffectiveVdot(47.9, 44.2)).toBe(47.9)
  })

  it('returns settingsVdot when syncedVdot is null (no sync)', () => {
    expect(selectEffectiveVdot(null, 44.2)).toBe(44.2)
  })

  it('returns settingsVdot when syncedVdot is undefined', () => {
    expect(selectEffectiveVdot(undefined, 44.2)).toBe(44.2)
  })

  it('returns settingsVdot when syncedVdot is 0 (treat as absent)', () => {
    // vdot=0 is not a valid fitness value; treat as "no sync"
    expect(selectEffectiveVdot(0, 44.2)).toBe(44.2)
  })

  it('returns syncedVdot even when it is lower than settingsVdot (desktop is SSoT)', () => {
    // Desktop live-derives from Strava — if form dropped, its value wins
    expect(selectEffectiveVdot(42.0, 47.9)).toBe(42.0)
  })

  it('returns syncedVdot when it equals settingsVdot (trivial, stable)', () => {
    expect(selectEffectiveVdot(44.2, 44.2)).toBe(44.2)
  })
})
