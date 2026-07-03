// T-142: Test-first — tests vor der Implementierung geschrieben.
// Referenzwerte identisch zu tests/test_durability_*.py (Desktop-SSoT).
import { describe, it, expect, beforeEach } from 'vitest'
import {
  durabilitySignals, durabilityTrend,
  upsertDurability, loadAllDurability, DURABILITY_CACHE_KEY,
  type DurabilityRecord,
} from './durability'
import { localISODate } from './strava'

function flatStreams(n = 1300, v = 3.0, hr = 150) {
  const time = Array.from({ length: n }, (_, i) => i)
  const velocity_smooth = Array(n).fill(v)
  const heartrate = Array(n).fill(hr)
  const altitude = Array(n).fill(100)
  const distance = Array.from({ length: n }, (_, i) => i * v)
  return { time, velocity_smooth, heartrate, altitude, distance }
}

describe('durabilitySignals', () => {
  it('flat constant → no fade, no drift', () => {
    const s = flatStreams()
    const r = durabilitySignals(s, s.distance[s.distance.length - 1] / 1000)
    expect(r).not.toBeNull()
    expect(Math.abs(r!.paceFadePct!)).toBeLessThan(0.5)
    expect(Math.abs(r!.driftPct!)).toBeLessThan(0.5)
    expect(r!.gapAdjusted).toBe(true)
  })

  it('flat, 2nd half 5% slower raw pace → fade ≈ +5', () => {
    const n = 1300, half = n / 2
    const time = Array.from({ length: n }, (_, i) => i)
    const velocity_smooth = [...Array(half).fill(3.0), ...Array(n - half).fill(3.0 / 1.05)]
    const heartrate = Array(n).fill(150)
    const altitude = Array(n).fill(100)
    const distance: number[] = [0]
    for (let i = 1; i < n; i++) distance.push(distance[i - 1] + velocity_smooth[i])
    const r = durabilitySignals({ time, velocity_smooth, heartrate, altitude, distance },
      distance[n - 1] / 1000)
    expect(r!.paceFadePct!).toBeGreaterThan(4.0)
    expect(r!.paceFadePct!).toBeLessThan(6.0)
  })

  it('2nd half uphill, raw pace slower exactly by GAP factor → fade ≈ 0', () => {
    const n = 1300, half = n / 2
    const factor2 = 1 + 0.02 * (3.0 - 1.0) // grade 3% → 1.04
    const v1 = 3.0, v2 = 3.0 / factor2
    const time = Array.from({ length: n }, (_, i) => i)
    const velocity_smooth = [...Array(half).fill(v1), ...Array(n - half).fill(v2)]
    const heartrate = Array(n).fill(150)
    const altitude: number[] = []
    const distance: number[] = []
    for (let i = 0; i < half; i++) { altitude.push(100); distance.push(v1 * i) }
    for (let i = half; i < n; i++) {
      distance.push((distance[distance.length - 1] ?? 0) + v2)
      altitude.push((altitude[altitude.length - 1] ?? 100) + 0.03 * v2) // 3% grade
    }
    const r = durabilitySignals({ time, velocity_smooth, heartrate, altitude, distance },
      distance[n - 1] / 1000)
    expect(Math.abs(r!.paceFadePct!)).toBeLessThan(1.0)
  })

  it('no HR stream → drift null, fade present', () => {
    const s = flatStreams()
    const r = durabilitySignals({ ...s, heartrate: undefined }, s.distance[s.distance.length - 1] / 1000)
    expect(r!.driftPct).toBeNull()
    expect(r!.paceFadePct).not.toBeNull()
  })

  it('too short → null', () => {
    expect(durabilitySignals(flatStreams(100))).toBeNull()
  })

  // T-153 (a): empty arrays are truthy in JS — gapAdjusted must check .length
  it('empty altitude array → gapAdjusted false', () => {
    const s = flatStreams()
    const r = durabilitySignals({ ...s, altitude: [] }, s.distance[s.distance.length - 1] / 1000)
    expect(r).not.toBeNull()
    expect(r!.gapAdjusted).toBe(false)
  })
  it('empty distance array → gapAdjusted false', () => {
    const s = flatStreams()
    const r = durabilitySignals({ ...s, distance: [] }, s.distance[s.distance.length - 1] / 1000)
    expect(r).not.toBeNull()
    expect(r!.gapAdjusted).toBe(false)
  })
  it('both altitude and distance filled → gapAdjusted true', () => {
    const r = durabilitySignals(flatStreams(), 3.9)
    expect(r!.gapAdjusted).toBe(true)
  })
})

describe('durabilityTrend', () => {
  const rec = (daysAgo: number, fade: number, drift: number,
               dur = 5400, dist = 22): DurabilityRecord => {
    const d = new Date(); d.setDate(d.getDate() - daysAgo)
    return { date: localISODate(d), durationS: dur, distanceKm: dist,
             paceFadePct: fade, driftPct: drift, gapAdjusted: true }
  }

  it('worsening fade → ↑ red', () => {
    const t = durabilityTrend([rec(60, 1, 2), rec(45, 2.5, 2.2), rec(30, 4, 2.4), rec(10, 6, 2.6)])
    expect(t!.fade!.direction).toBe('↑')
    expect(t!.fade!.slopePerWeek).toBeGreaterThan(0)
  })
  it('improving fade → ↓', () => {
    const t = durabilityTrend([rec(60, 6, 3), rec(45, 4, 2.5), rec(30, 2.5, 2.2), rec(10, 1, 2)])
    expect(t!.fade!.direction).toBe('↓')
  })
  it('stable within totband → →', () => {
    const t = durabilityTrend([rec(60, 3, 2), rec(45, 3.05, 2), rec(30, 2.95, 2), rec(10, 3, 2)])
    expect(t!.fade!.direction).toBe('→')
  })
  it('< 3 longruns → signal null', () => {
    const t = durabilityTrend([rec(30, 3, 2), rec(10, 4, 2)])
    expect(t!.fade).toBeNull()
    expect(t!.nLongruns).toBe(2)
  })
  it('gate excludes short runs', () => {
    const t = durabilityTrend([rec(40, 1, 2, 3000, 10), rec(30, 5, 2, 3000, 10), rec(20, 9, 2, 3000, 10)])
    expect(t!.nLongruns).toBe(0)
    expect(t!.fade).toBeNull()
  })
})

describe('durability store', () => {
  beforeEach(() => localStorage.clear())
  it('upsert → loadAll roundtrip', () => {
    const r: DurabilityRecord = { driftPct: 2.5, paceFadePct: 1.2, gapAdjusted: true,
      durationS: 5400, distanceKm: 22, date: '2026-06-01' }
    upsertDurability(123, r)
    expect(localStorage.getItem(DURABILITY_CACHE_KEY(123))).not.toBeNull()
    const all = loadAllDurability()
    expect(all).toHaveLength(1)
    expect(all[0].driftPct).toBe(2.5)
  })
  it('corrupt value is skipped', () => {
    localStorage.setItem(DURABILITY_CACHE_KEY(9), '{not json')
    expect(loadAllDurability()).toEqual([])
  })
})
