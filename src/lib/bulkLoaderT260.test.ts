// T-260 P-03: Analyse-Bulk-Loader darf beim zweiten Besuch nur fehlende Runs nachladen.
// Vorher: Streams für alle Läufe (52 Wo.) geholt, capStreamLapsCaches behielt nur 40 Aktivitäten
// → jeder Besuch lud die älteren erneut (~130 Requests → Strava-Limit 100/15 min).
// Zusätzlich: Effekt-Rerun startete eine zweite Schleife, die erste lief weiter (kein Abort).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { loadAnalyticsStreams, STREAM_CACHE_MAX, ANALYTICS_RESULT_KEY, ANALYTICS_ALGO_VERSION } from './strava'
import type { RunSummary } from './strava'

const N_RUNS = STREAM_CACHE_MAX + 20

function makeRun(id: number): RunSummary {
  return {
    id, name: `Run ${id}`, date: new Date(), distanceKm: 10, durationSec: 3600,
    paceSec: 360, paceFmt: '6:00', elevationM: 0,
  }
}

// Stream mit klarem Stride (Spike) → strideDataById bekommt einen Eintrag
function strideStream() {
  const time: number[] = [], vel: number[] = [], hr: number[] = []
  for (let i = 0; i < 30; i++) { time.push(i); vel.push(2.5); hr.push(130) }
  for (let i = 30; i < 45; i++) { time.push(i); vel.push(5.0); hr.push(160) }
  for (let i = 45; i < 75; i++) { time.push(i); vel.push(2.5); hr.push(130) }
  return { time: { data: time }, velocity_smooth: { data: vel }, heartrate: { data: hr } }
}

function lapsPayload() {
  return [
    { lap_index: 1, average_speed: 2.5, distance: 1500, moving_time: 600, average_heartrate: 130 },
    { lap_index: 2, average_speed: 3.6, distance: 1000, moving_time: 278, average_heartrate: 170 },
    { lap_index: 3, average_speed: 2.0, distance:  600, moving_time: 300, average_heartrate: 140 },
    { lap_index: 4, average_speed: 3.6, distance: 1000, moving_time: 278, average_heartrate: 172 },
    { lap_index: 5, average_speed: 2.5, distance: 1500, moving_time: 600, average_heartrate: 128 },
  ]
}

function seedActivities(ids: number[]) {
  // Aktivitätsliste bestimmt die Recency-Reihenfolge für capStreamLapsCaches (höhere id = jünger)
  const acts = ids.map(id => ({
    id, name: `Run ${id}`, type: 'Run', sport_type: 'Run',
    start_date: new Date(Date.UTC(2026, 0, 1) + id * 86_400_000).toISOString(),
  }))
  localStorage.setItem('strava_activities', JSON.stringify(acts))
}

let streamCalls = 0
let lapCalls = 0

beforeEach(() => {
  localStorage.clear()
  streamCalls = 0
  lapCalls = 0
  localStorage.setItem('strava_tokens', JSON.stringify({
    access_token: 'tok', refresh_token: 'ref', expires_at: Math.floor(Date.now() / 1000) + 3600,
  }))
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.includes('/streams')) { streamCalls++; return { ok: true, status: 200, json: async () => strideStream() } }
    if (url.includes('/laps'))    { lapCalls++;    return { ok: true, status: 200, json: async () => lapsPayload() } }
    return { ok: false, status: 404, json: async () => ({}) }
  }))
})

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('loadAnalyticsStreams (T-260 P-03)', () => {
  it('zweiter Besuch: 0 neue Requests, obwohl der Stream-Cache auf STREAM_CACHE_MAX gedeckelt wurde', async () => {
    const ids = Array.from({ length: N_RUNS }, (_, i) => 1000 + i)
    seedActivities(ids)
    const runs = ids.map(makeRun)
    const quality = runs.slice(0, 5)  // älteste → deren Laps fallen aus dem Cache-Cap

    const first = await loadAnalyticsStreams(runs, quality, 48)
    expect(streamCalls).toBe(N_RUNS)
    expect(lapCalls).toBe(5)
    expect(first.partial).toBe(false)

    streamCalls = 0; lapCalls = 0
    const second = await loadAnalyticsStreams(runs, quality, 48)
    expect(streamCalls).toBe(0)
    expect(lapCalls).toBe(0)
    // Ergebnis aus persistierten Per-Run-Resultaten identisch
    expect(Object.keys(second.strideDataById).sort()).toEqual(Object.keys(first.strideDataById).sort())
    expect(second.workSplits).toEqual(first.workSplits)
    expect(second.fetched).toBe(first.fetched)
  })

  it('zweiter Besuch mit neuem Lauf: genau so viele Stream-Requests wie fehlende Runs (N=1)', async () => {
    const ids = Array.from({ length: N_RUNS }, (_, i) => 1000 + i)
    seedActivities(ids)
    await loadAnalyticsStreams(ids.map(makeRun), [], 48)

    const ids2 = [...ids, 5000]
    seedActivities(ids2)
    streamCalls = 0
    await loadAnalyticsStreams(ids2.map(makeRun), [], 48)
    expect(streamCalls).toBe(1)
  })

  it('Abort-Signal stoppt die Schleife — kein Weiterladen nach Effekt-Cleanup', async () => {
    const ids = Array.from({ length: 10 }, (_, i) => 1000 + i)
    seedActivities(ids)
    const ctrl = new AbortController()
    ;(globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(async (url: string) => {
      if (url.includes('/streams')) {
        streamCalls++
        if (streamCalls === 2) ctrl.abort()  // Cleanup während laufender Schleife
        return { ok: true, status: 200, json: async () => strideStream() }
      }
      return { ok: false, status: 404, json: async () => ({}) }
    })
    const res = await loadAnalyticsStreams(ids.map(makeRun), [], 48, ctrl.signal)
    expect(streamCalls).toBe(2)
    expect(res.partial).toBe(true)
  })

  it('persistierte Per-Run-Ergebnisse bleiben klein und werden für verschwundene Aktivitäten geräumt', async () => {
    seedActivities([1000, 1001])
    localStorage.setItem(ANALYTICS_RESULT_KEY(999), JSON.stringify({ v: 48, strides: null }))
    await loadAnalyticsStreams([makeRun(1000), makeRun(1001)], [], 48)
    const raw = localStorage.getItem(ANALYTICS_RESULT_KEY(1000))
    expect(raw).not.toBeNull()
    expect(raw!.length).toBeLessThan(500)
    expect(localStorage.getItem(ANALYTICS_RESULT_KEY(999))).toBeNull()
  })
})

describe('loadAnalyticsStreams (T-260 Fix-Loop 1 — Algorithmus-Version)', () => {
  it('persistiertes Ergebnis mit abweichender Algorithmus-Version gilt als nicht berechnet → Neuladen', async () => {
    seedActivities([1000])
    localStorage.setItem(ANALYTICS_RESULT_KEY(1000), JSON.stringify({ a: ANALYTICS_ALGO_VERSION - 1, v: 48, strides: null }))
    await loadAnalyticsStreams([makeRun(1000)], [], 48)
    expect(streamCalls).toBe(1)
    expect(JSON.parse(localStorage.getItem(ANALYTICS_RESULT_KEY(1000))!).a).toBe(ANALYTICS_ALGO_VERSION)
  })

  it('Altbestand ohne Versionsfeld → Neuladen', async () => {
    seedActivities([1000])
    localStorage.setItem(ANALYTICS_RESULT_KEY(1000), JSON.stringify({ v: 48, strides: null }))
    await loadAnalyticsStreams([makeRun(1000)], [], 48)
    expect(streamCalls).toBe(1)
  })
})
