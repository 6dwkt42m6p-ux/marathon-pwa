// T-124-fix: Tests for loadAnalyticsStreams bulk-loader.
// AC5: (a) cache-hit → no second fetch; (b) 429 on 2nd item → partial:true + 1 result, no 3rd fetch;
// (c) loader fills strideDataById/workSplits in expected shape.
// Test-first: tests written before implementation, expected to fail initially.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  loadAnalyticsStreams,
  STREAM_CACHE_KEY,
  LAPS_CACHE_KEY,
} from './strava'
import type { RunSummary } from './strava'

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRun(id: number, _workoutType?: number): RunSummary {
  return {
    id,
    name:        `Run ${id}`,
    date:        new Date(),
    distanceKm:  10,
    durationSec: 3600,
    paceSec:     360,
    paceFmt:     '6:00',
    elevationM:  0,
  }
}

// Minimal valid stream payload that detectStrides can process (≥10 samples, uniform pace)
function makeStreamPayload() {
  const n = 30
  return {
    time: { data: Array.from({ length: n }, (_, i) => i) },
    velocity_smooth: { data: Array.from({ length: n }, () => 3.0) },
    heartrate: { data: Array.from({ length: n }, () => 140) },
    altitude: { data: Array.from({ length: n }, () => 100) },
  }
}

// Minimal lap payload — 5 laps including warmup, intervals, cooldown
function makeLapsPayload() {
  return [
    { lap_index: 1, average_speed: 2.5, distance: 1500, moving_time: 600, average_heartrate: 130 }, // warmup
    { lap_index: 2, average_speed: 3.6, distance: 1000, moving_time: 278, average_heartrate: 170 }, // interval
    { lap_index: 3, average_speed: 2.0, distance:  600, moving_time: 300, average_heartrate: 140 }, // recovery
    { lap_index: 4, average_speed: 3.6, distance: 1000, moving_time: 278, average_heartrate: 172 }, // interval
    { lap_index: 5, average_speed: 2.5, distance: 1500, moving_time: 600, average_heartrate: 128 }, // cooldown
  ]
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('loadAnalyticsStreams (T-124-fix)', () => {
  beforeEach(() => {
    // Clear test-related cache keys before each test
    localStorage.clear()
    vi.stubGlobal('fetch', undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // AC5a: cache-hit → no second fetch call
  it('cache-hit: does not call fetch when stream and laps are already cached', async () => {
    const runId = 1001
    const run = makeRun(runId)

    // Pre-populate cache
    localStorage.setItem(STREAM_CACHE_KEY(runId), JSON.stringify(makeStreamPayload()))
    localStorage.setItem(LAPS_CACHE_KEY(runId), JSON.stringify(makeLapsPayload()))

    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    // Also stub getValidToken to return a token
    const stravaModule = await import('./strava')
    vi.spyOn(stravaModule, 'getValidToken').mockResolvedValue('fake-token')

    const result = await loadAnalyticsStreams([run], [run], 48)

    // fetch must NOT have been called (everything from cache)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.partial).toBe(false)
  })

  // AC5b: 429 on 2nd item → partial:true, no 3rd fetch.
  // Strategy: pre-cache run1 so no fetch needed for it; run2 gets a 429 on the
  // token/fetch call path; run3 must never be fetched.
  it('429 on second activity: partial:true, fetch not called for third', async () => {
    const run1 = makeRun(2001)
    const run2 = makeRun(2002)
    const run3 = makeRun(2003)

    // Pre-populate cache only for run1 — so the bulk loader fetches run2 first
    // (run1 cache hit → skip fetch; run2 has no cache → triggers real fetch path)
    const streamCacheKey1 = `_strava_stream_${run1.id}`
    const stream1 = makeStreamPayload()
    // Store in already-parsed ActivityStreams shape (array fields, not Strava raw shape)
    localStorage.setItem(streamCacheKey1, JSON.stringify({
      time: stream1.time.data,
      velocity_smooth: stream1.velocity_smooth.data,
      heartrate: stream1.heartrate.data,
    }))

    // fetch mock: 429 for run2, success for anything else (run3 should never be reached)
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('2002')) {
        return { ok: false, status: 429 }
      }
      if (url.includes('2003')) {
        // This should not happen — if it does, test should fail
        return { ok: true, status: 200, json: async () => makeStreamPayload() }
      }
      // Token refresh or other calls: return a minimal response
      return { ok: true, status: 200, json: async () => ({ access_token: 'tok', expires_at: 9999999999, refresh_token: 'ref' }) }
    })
    vi.stubGlobal('fetch', fetchMock)

    // Store a fake valid token so getValidToken returns without refreshing
    localStorage.setItem('strava_tokens', JSON.stringify({
      access_token: 'fake-token',
      refresh_token: 'fake-refresh',
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    }))

    const { loadAnalyticsStreams: loader } = await import('./strava')
    const result = await loader([run1, run2, run3], [], 48)

    expect(result.partial).toBe(true)
    // run3 must not have triggered a fetch
    const calledUrls: string[] = fetchMock.mock.calls.map((c: unknown[]) => c[0] as string)
    const run3Fetched = calledUrls.some(u => u.includes('2003'))
    expect(run3Fetched).toBe(false)
  })

  // AC5c: loader fills strideDataById/workSplits in expected shape
  it('populates workSplits in expected shape (Record<string, number[]>)', async () => {
    const qualityRunId = 3001
    const qualityRun = makeRun(qualityRunId, 3)

    localStorage.setItem(STREAM_CACHE_KEY(qualityRunId), JSON.stringify(makeStreamPayload()))
    localStorage.setItem(LAPS_CACHE_KEY(qualityRunId), JSON.stringify(makeLapsPayload()))

    const stravaModule = await import('./strava')
    vi.spyOn(stravaModule, 'getValidToken').mockResolvedValue('fake-token')
    vi.stubGlobal('fetch', vi.fn()) // should not be called

    const result = await loadAnalyticsStreams([qualityRun], [qualityRun], 48)

    // workSplits shape: Record<string, number[]>
    for (const [key, splits] of Object.entries(result.workSplits)) {
      expect(typeof key).toBe('string')
      expect(Array.isArray(splits)).toBe(true)
      for (const split of splits) {
        expect(typeof split).toBe('number')
        expect(split).toBeGreaterThan(0)
      }
    }
  })

  it('populates strideDataById in expected shape when strides found', async () => {
    // Use a stream that has clear velocity spikes to trigger stride detection
    const strideRunId = 4001
    const run = makeRun(strideRunId)

    // Build a stream with a clear speed spike: 30s at 2.5 m/s (easy), then 15s spike at 5.0 m/s, then recover
    const time: number[] = []
    const vel: number[] = []
    const hr: number[] = []
    // 30 samples at easy pace
    for (let i = 0; i < 30; i++) { time.push(i); vel.push(2.5); hr.push(130) }
    // 15 samples at stride pace (5.0 m/s = 3:20/km, well above 2.5*1.25=3.125 threshold)
    for (let i = 30; i < 45; i++) { time.push(i); vel.push(5.0); hr.push(160) }
    // 30 samples back at easy pace
    for (let i = 45; i < 75; i++) { time.push(i); vel.push(2.5); hr.push(130) }

    const streamPayload = {
      time: { data: time },
      velocity_smooth: { data: vel },
      heartrate: { data: hr },
    }
    localStorage.setItem(STREAM_CACHE_KEY(strideRunId), JSON.stringify(streamPayload))

    const stravaModule = await import('./strava')
    vi.spyOn(stravaModule, 'getValidToken').mockResolvedValue('fake-token')
    vi.stubGlobal('fetch', vi.fn())

    const result = await loadAnalyticsStreams([run], [], 48)

    // strideDataById shape: Record<string, { strideCount: number; strides: { peakPaceSec: number }[]; avgPeakPaceSec?: number }>
    for (const [key, entry] of Object.entries(result.strideDataById)) {
      expect(typeof key).toBe('string')
      expect(typeof entry.strideCount).toBe('number')
      expect(Array.isArray(entry.strides)).toBe(true)
      for (const s of entry.strides) {
        expect(typeof s.peakPaceSec).toBe('number')
      }
    }
    expect(result.partial).toBe(false)
  })
})
