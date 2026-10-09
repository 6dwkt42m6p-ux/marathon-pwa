// P-02: dailyLoadSeries muss den heutigen Tag in Zeitzonen oestlich von UTC mitzaehlen
// (Paritaet zu coach._daily_load). TZ wird hier hart gesetzt, damit der Test auch in der
// CI (UTC) die Luecke faengt.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { dailyLoadSeries, localISODate, type StravaActivity } from './strava'

const ORIG_TZ = process.env.TZ

function run(day: string): StravaActivity {
  return {
    id: 1, name: 'r', type: 'Run', sport_type: 'Run', distance: 10000, moving_time: 3000, elapsed_time: 3000,
    start_date: day + 'T08:00:00Z', start_date_local: day + 'T08:00:00Z',
    suffer_score: 100,
  } as unknown as StravaActivity
}

describe('dailyLoadSeries — Zeitzone (P-02)', () => {
  beforeAll(() => { process.env.TZ = 'Europe/Vienna' })
  afterAll(() => { vi.useRealTimers(); if (ORIG_TZ === undefined) delete process.env.TZ; else process.env.TZ = ORIG_TZ })

  it('Aktivitaet heute zaehlt in Europe/Vienna (Serie endet mit heutigem Tag)', () => {
    expect(new Date(2026, 5, 15, 12).getTimezoneOffset()).toBe(-120) // TZ wirklich aktiv
    vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 5, 15, 12, 0, 0))
    const today = localISODate(new Date())
    const d = (n: number) => { const x = new Date(); x.setDate(x.getDate() - n); return localISODate(x) }
    const series = dailyLoadSeries([run(d(3)), run(today)])
    expect(series.length).toBe(4)
    expect(series[0]).toBeGreaterThan(0)
    expect(series[1]).toBe(0)
    expect(series[2]).toBe(0)
    expect(series[3]).toBeGreaterThan(0)
  })
})
