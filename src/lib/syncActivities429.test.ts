import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { syncActivities, StravaRateLimitError } from './strava'

// T-135: Verify that a 429 response on the activities sync path throws StravaRateLimitError
// (not a generic Error with a raw status string), so StravaSync.tsx can render a friendly message.
//
// Root cause: fetchActivitiesAfter threw `new Error('Strava API error: 429')` for all non-ok
// responses. StravaSync.tsx caught the error via `String(e)` which produced the raw technical
// string. The streams/laps path had the rate_limited sentinel since T-129 — activities was missing.

// Strava token key matches TOKEN_KEY in strava.ts
const TOKEN_KEY = 'strava_tokens'

function setValidToken(): void {
  localStorage.setItem(TOKEN_KEY, JSON.stringify({
    access_token: 'fake-token',
    refresh_token: 'fake-refresh',
    expires_at:   Math.floor(Date.now() / 1000) + 3600,
  }))
}

describe('syncActivities 429 handling (T-135)', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.stubGlobal('fetch', undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('StravaRateLimitError is exported and is a subclass of Error', () => {
    const err = new StravaRateLimitError(120)
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(StravaRateLimitError)
    expect(err.retryAfter).toBe(120)
    expect(err.message).toContain('429')
  })

  it('StravaRateLimitError without retryAfter has retryAfter=undefined', () => {
    const err = new StravaRateLimitError()
    expect(err.retryAfter).toBeUndefined()
  })

  it('syncActivities throws StravaRateLimitError (not generic Error) on 429', async () => {
    setValidToken()

    // Empty cache → syncActivities uses the full-fetch path (no overlap calculation)
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 429,
      headers: { get: (_: string) => null },
    })))

    let thrown: unknown
    try {
      await syncActivities(52)
    } catch (e) {
      thrown = e
    }

    expect(thrown).toBeDefined()
    expect(thrown).toBeInstanceOf(StravaRateLimitError)
    const rl = thrown as StravaRateLimitError
    // Message must not be the raw generic string — StravaRateLimitError has its own message
    expect(rl.message).not.toBe('Strava API error: 429')
  })

  it('syncActivities propagates Retry-After header seconds via retryAfter property', async () => {
    setValidToken()

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 429,
      headers: { get: (h: string) => h.toLowerCase() === 'retry-after' ? '180' : null },
    })))

    let thrown: unknown
    try {
      await syncActivities(52)
    } catch (e) {
      thrown = e
    }

    expect(thrown).toBeInstanceOf(StravaRateLimitError)
    const rl = thrown as StravaRateLimitError
    expect(rl.retryAfter).toBe(180)
  })

  it('syncActivities still throws generic Error for non-429 HTTP errors (regression guard)', async () => {
    setValidToken()

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 500,
      headers: { get: () => null },
    })))

    let thrown: unknown
    try {
      await syncActivities(52)
    } catch (e) {
      thrown = e
    }

    expect(thrown).toBeInstanceOf(Error)
    expect(thrown).not.toBeInstanceOf(StravaRateLimitError)
  })

  it('syncActivities succeeds and returns activities on 200 (regression guard)', async () => {
    setValidToken()

    const fakeActivity = {
      id: 1,
      name: 'Morning Run',
      type: 'Run',
      sport_type: 'Run',
      start_date: new Date(Date.now() - 2 * 86400 * 1000).toISOString(),
      start_date_local: new Date(Date.now() - 2 * 86400 * 1000).toISOString(),
      distance: 10000,
      moving_time: 3600,
      total_elevation_gain: 50,
      average_speed: 2.78,
    }

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => [fakeActivity],
    })))

    const result = await syncActivities(52)
    expect(Array.isArray(result)).toBe(true)
    expect(result.length).toBeGreaterThan(0)
  })
})
