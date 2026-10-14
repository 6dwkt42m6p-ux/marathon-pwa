// T-292: Zwilling von coach_load.classify_hike + Spaziergang-Filter in _daily_load (T-134).
import { describe, it, expect } from 'vitest'
import { classifyHike, dailyLoadSeries, localISODate } from './strava'
import type { StravaActivity } from './strava'

const act = (o: Partial<StravaActivity>, daysAgo = 0): StravaActivity => {
  const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - daysAgo)
  const s = `${localISODate(d)}T12:00:00Z`
  return { id: 1, name: 'x', type: 'Walk', sport_type: 'Walk', distance: 3000, moving_time: 1800,
    total_elevation_gain: 0, start_date: s, start_date_local: s, ...o } as StravaActivity
}

describe('T-292 classifyHike (Zwilling coach_load.classify_hike)', () => {
  it('Schwellen inklusiv: 400 Hm bzw. 150 min -> bergtour', () => {
    expect(classifyHike(act({ total_elevation_gain: 400 }))).toBe('bergtour')
    expect(classifyHike(act({ moving_time: 150 * 60 }))).toBe('bergtour')
    expect(classifyHike(act({ total_elevation_gain: 399, moving_time: 150 * 60 - 1 }))).toBe('spaziergang')
  })
  it('Hoehenmeter Python-gerundet (399.5 -> 400, 398.5 -> 398)', () => {
    expect(classifyHike(act({ total_elevation_gain: 399.5 }))).toBe('bergtour')
    expect(classifyHike(act({ total_elevation_gain: 398.5 }))).toBe('spaziergang')
  })
})

describe('T-292 dailyLoadSeries ueberspringt Recovery-Spaziergaenge', () => {
  it('Spaziergang zaehlt nicht, Bergtour schon', () => {
    expect(dailyLoadSeries([act({})])).toEqual([])
    expect(dailyLoadSeries([act({ type: 'Hike', sport_type: 'Hike', total_elevation_gain: 800, suffer_score: 90 })])).toEqual([90])
  })
  it('Spaziergang verschiebt den Serienstart nicht', () => {
    const run = act({ type: 'Run', sport_type: 'Run', suffer_score: 50 }, 1)
    expect(dailyLoadSeries([act({}, 3), run])).toEqual([50, 0])
  })
  it('nur Walk/Hike werden gefiltert, kurzer Run nicht', () => {
    expect(dailyLoadSeries([act({ type: 'Run', sport_type: 'Run', suffer_score: 20 })])).toEqual([20])
  })
})
