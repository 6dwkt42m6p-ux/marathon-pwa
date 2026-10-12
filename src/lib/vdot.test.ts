import { describe, it, expect } from 'vitest'
import {
  timeForVdot, racePredictor, vdotFromRace, isWorkoutActivity,
  analyzeRun, hrZoneCodeLthr, lthrZones, trainingPaces,
} from './vdot'
import { LTHR_EASY_FRAC, LTHR_QUALITY_FRAC } from './analytics'

// T-271: Friel-Zonen (LTHR 170: Grenzen 144.5 | 153 | 161.5 | 170)
describe('hrZoneCodeLthr (T-271)', () => {
  const cases: Array<[number, string]> = [
    [143.5, 'Z1'], [144.5, 'Z2'], [152, 'Z2'], [153, 'Z3'], [161, 'Z3'],
    [161.5, 'Z4'], [169, 'Z4'], [170, 'Z5'], [171, 'Z5'],
  ]
  for (const [bpm, z] of cases) {
    it(`${bpm} bpm bei LTHR 170 → ${z}`, () => expect(hrZoneCodeLthr(bpm, 170)).toBe(z))
  }
  it('ungültige Werte → null', () => {
    expect(hrZoneCodeLthr(0, 170)).toBeNull()
    expect(hrZoneCodeLthr(NaN, 170)).toBeNull()
    expect(hrZoneCodeLthr(150, 0)).toBeNull()
    expect(hrZoneCodeLthr(150, NaN)).toBeNull()
  })
  it('Z1–Z2 = easy, Z3 = grau, Z4–Z5 = Qualität (T-269-Grenzen)', () => {
    for (const lthr of [158, 171, 173.8]) {
      for (let i = 1000; i < 2100; i++) {
        const bpm = i / 10
        const z = hrZoneCodeLthr(bpm, lthr)!
        const bucket = bpm < LTHR_EASY_FRAC * lthr ? 'easy' : bpm < LTHR_QUALITY_FRAC * lthr ? 'grey' : 'quality'
        const expected = z === 'Z1' || z === 'Z2' ? 'easy' : z === 'Z3' ? 'grey' : 'quality'
        expect(bucket, `${bpm}@${lthr}`).toBe(expected)
      }
    }
  })
})

describe('analyzeRun mit LTHR (T-271)', () => {
  const p = trainingPaces(49)
  const eMid = (p.E_high + p.E_low) / 2

  it('Trail: Zone nach Friel statt Karvonen', () => {
    // 150 bpm: Karvonen (150-50)/140 = 71 % → M/Z3; Friel 150/170 = 88 % → E/Z2
    const k = analyzeRun(eMid, 12, 150, 155, 49, 190, 50, 'Aufbau', false, true)
    const f = analyzeRun(eMid, 12, 150, 155, 49, 190, 50, 'Aufbau', false, true, undefined, 170)
    expect(k.hrZone).toBe('Z3')
    expect(f.hrZone).toBe('Z2')
    expect(f.zoneCode).toBe('E')
    expect(f.hrBasis).toBe('LTHR')
    expect(k.hrBasis).toBe('HFR')
  })

  it('Hinweistext zeigt % LTHR statt % HFR', () => {
    // T-Pace mit Ø 140 bpm: Friel 82 % → Z1 → "niedriger als Pace andeutet"
    const r = analyzeRun(p.T, 8, 140, 148, 49, 190, 50, 'Aufbau', false, false, undefined, 170)
    expect(r.hrZone).toBe('Z1')
    expect(r.hrNote).toContain(`HF ${Math.round(140 / 170 * 100)}% LTHR`)
    expect(r.hrNote).not.toContain('HFR')
  })

  it('ohne LTHR unverändert Karvonen (HFR)', () => {
    const r = analyzeRun(p.T, 8, 110, 118, 49, 190, 50, 'Aufbau')
    expect(r.hrZone).toBe('Z1')
    expect(r.hrNote).toContain('% HFR')
    expect(r.hrBasis).toBe('HFR')
  })
})

describe('lthrZones (T-271)', () => {
  it('Untergrenzen = kleinste ganze bpm der Zone (ceil, wie hrZoneCodeLthr)', () => {
    const z = lthrZones(170)
    expect(z.map(r => r.bpmLo)).toEqual([0, 145, 153, 162, 170])
    expect(z.map(r => r.bpmHi)).toEqual([144, 152, 161, 169, null])
    for (const r of z.slice(1)) expect(hrZoneCodeLthr(r.bpmLo, 170)).toBe(r.code)
    for (const r of z.slice(0, 4)) expect(hrZoneCodeLthr(r.bpmHi!, 170)).toBe(r.code)
  })
  it('lthr <= 0 → leer', () => expect(lthrZones(0)).toEqual([]))
})

const HM = 21097
const M  = 42195

describe('isWorkoutActivity', () => {
  it('nur workoutType 3 (Strava "Workout") gilt als Workout — Long Run (2) nicht', () => {
    expect(isWorkoutActivity(undefined)).toBe(false)
    expect(isWorkoutActivity(0)).toBe(false)
    expect(isWorkoutActivity(1)).toBe(false)  // Race
    expect(isWorkoutActivity(2)).toBe(false)  // Long Run — KEIN Workout (T-218 Fix-Loop 1)
    expect(isWorkoutActivity(3)).toBe(true)   // Workout
  })
})

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

  // T-153 (c): negative weeksToRace (race already passed) must not shrink band below distance floor
  it('weeksToRace=-2 gives same bandPct as weeksToRace=0', () => {
    const rNeg  = racePredictor(50, HM, { weeksToRace: -2 })
    const rZero = racePredictor(50, HM, { weeksToRace: 0 })
    expect(rNeg.bandPct).toBe(rZero.bandPct)
  })
})
