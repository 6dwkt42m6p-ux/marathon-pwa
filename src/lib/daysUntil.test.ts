// P-13: Tage-bis-Rennen ueber den DST-Wechsel (Europe/Vienna, 25.10.2026) darf nicht um 1 abweichen.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { daysUntil } from './plan'

const ORIG_TZ = process.env.TZ

describe('daysUntil — DST (P-13)', () => {
  beforeAll(() => { process.env.TZ = 'Europe/Vienna' })
  afterAll(() => { vi.useRealTimers(); if (ORIG_TZ === undefined) delete process.env.TZ; else process.env.TZ = ORIG_TZ })

  it('CEST heute, Rennen in CET: exakt 10 Tage', () => {
    const now = new Date(2026, 9, 20, 15, 0, 0)
    expect(daysUntil(new Date(2026, 9, 30), now)).toBe(10)
  })
  it('heute = 0, gestern = -1', () => {
    const now = new Date(2026, 9, 20, 23, 30, 0)
    expect(daysUntil(new Date(2026, 9, 20, 6), now)).toBe(0)
    expect(daysUntil(new Date(2026, 9, 19), now)).toBe(-1)
  })
})
