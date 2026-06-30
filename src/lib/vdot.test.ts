import { describe, it, expect } from 'vitest'
import { timeForVdot, racePredictor, vdotFromRace } from './vdot'

const HM = 21097
const M  = 42195

describe('timeForVdot', () => {
  it('roundtrips vdotFromRace for HM', () => {
    const t = timeForVdot(HM, 50)
    expect(Math.abs(vdotFromRace(HM, t) - 50)).toBeLessThan(0.1)
  })

  it('roundtrips vdotFromRace for Marathon', () => {
    const t = timeForVdot(M, 55)
    expect(Math.abs(vdotFromRace(M, t) - 55)).toBeLessThan(0.1)
  })
})

describe('racePredictor', () => {
  it('base without opts ≈ timeForVdot', () => {
    const r = racePredictor(50, HM)
    expect(Math.abs(r.predictedSec! - timeForVdot(HM, 50))).toBeLessThan(2)
    expect(r.durabilityMult).toBe(1)
    expect(r.taperMult).toBe(1)
    expect(r.fitnessGainVdot).toBe(0)
    expect(r.baseSec).not.toBeNull()
    expect(Math.abs(r.baseSec! - timeForVdot(HM, 50))).toBeLessThan(2)
  })

  it('marathon durabilityFactor slower', () => {
    const r = racePredictor(55, M, { durabilityFactor: 0.95 })
    expect(r.durabilityMult).toBe(0.95)
    expect(r.predictedSec!).toBeGreaterThan(r.baseSec!)
  })

  it('HM ignores durability', () => {
    const r = racePredictor(55, HM, { durabilityFactor: 0.95 })
    expect(r.durabilityMult).toBe(1)
    expect(Math.abs(r.predictedSec! - r.baseSec!)).toBeLessThan(2)
  })

  it('marathon fade penalty when no factor (capped)', () => {
    const r = racePredictor(55, M, { paceFadeRecent: 8 })
    expect(r.durabilityMult).toBeLessThan(1)
    expect(r.durabilityMult).toBeGreaterThanOrEqual(0.96)
    expect(r.predictedSec!).toBeGreaterThan(r.baseSec!)
  })

  it('fitness projection faster, capped at 0.4', () => {
    const up   = racePredictor(50, HM, { weeksToRace: 8, ctlRising: true })
    const flat = racePredictor(50, HM, { weeksToRace: 8, ctlRising: false })
    expect(up.fitnessGainVdot).toBeGreaterThan(0)
    expect(up.fitnessGainVdot).toBeLessThanOrEqual(0.4)
    expect(up.predictedSec!).toBeLessThan(up.baseSec!)
    expect(flat.fitnessGainVdot).toBe(0)
  })

  it('taper fresh faster / overreached slower / outside window neutral', () => {
    const fresh = racePredictor(55, M, { weeksToRace: 1, tsb: 20 })
    const tired = racePredictor(55, M, { weeksToRace: 1, tsb: -15 })
    const far   = racePredictor(55, M, { weeksToRace: 10, tsb: 20 })
    expect(fresh.taperMult).toBeLessThan(1)
    expect(tired.taperMult).toBeGreaterThan(1)
    expect(far.taperMult).toBe(1)
  })

  it('band marathon wider than hm; confidence valid', () => {
    const m = racePredictor(55, M)
    const h = racePredictor(55, HM, { durabilityFactor: 0.97, weeksToRace: 1 })
    expect(m.bandPct).toBeGreaterThan(h.bandPct)
    expect(m.rangeHighSec!).toBeGreaterThan(m.predictedSec!)
    expect(m.predictedSec!).toBeGreaterThan(m.rangeLowSec!)
    expect(['hoch', 'mittel', 'niedrig']).toContain(m.confidence)
  })

  it('invalid vdot → neutral (null predicted, confidence niedrig)', () => {
    const r0   = racePredictor(0, M)
    const rNull = racePredictor(null, M)
    expect(r0.predictedSec).toBeNull()
    expect(r0.confidence).toBe('niedrig')
    expect(rNull.predictedSec).toBeNull()
    expect(rNull.confidence).toBe('niedrig')
  })
})
