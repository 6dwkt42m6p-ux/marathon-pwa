import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  getValidToken, clearTokens, loadTokens, getAuthUrl, parseOAuthCallback,
  fetchActivityStreams, fetchActivityLaps, loadAnalyticsStreams,
  STREAM_CACHE_KEY, LAPS_CACHE_KEY, STRAVA_REAUTH_KEY, getCachedActivities,
} from './strava'

const expired = () => ({ access_token: 'old', refresh_token: 'r', expires_at: Math.floor(Date.now() / 1000) - 100 })
function setExpiredTokens() { localStorage.setItem('strava_tokens', JSON.stringify(expired())) }
const offline = () => vi.fn(async () => { throw new TypeError('Failed to fetch') })

beforeEach(() => { localStorage.clear(); sessionStorage.clear() })
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); localStorage.clear(); sessionStorage.clear() })

describe('T-259 P-07: Cache vor Token', () => {
  const streams = { time: [0, 1], velocity_smooth: [3, 3] }
  it('Streams: Cache-Treffer trotz abgelaufenem Token + Offline', async () => {
    setExpiredTokens()
    vi.stubGlobal('fetch', offline())
    localStorage.setItem(STREAM_CACHE_KEY(1), JSON.stringify(streams))
    const r = await fetchActivityStreams(1)
    expect(r).not.toBeNull()
    expect(r).not.toBe('rate_limited')
  })
  it('Laps: Cache-Treffer trotz abgelaufenem Token + Offline', async () => {
    setExpiredTokens()
    vi.stubGlobal('fetch', offline())
    localStorage.setItem(LAPS_CACHE_KEY(2), JSON.stringify([{ a: 1 }]))
    expect(await fetchActivityLaps(2)).toEqual([{ a: 1 }])
  })
  it('Laps: 429 -> rate_limited statt null', async () => {
    localStorage.setItem('strava_tokens', JSON.stringify({ ...expired(), expires_at: Math.floor(Date.now() / 1000) + 3600 }))
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 429 })))
    expect(await fetchActivityLaps(3)).toBe('rate_limited')
  })
  it('Bulk: Cache-Treffer ohne gueltigen Token werden ausgewertet', async () => {
    setExpiredTokens()
    vi.stubGlobal('fetch', offline())
    const n = 30
    localStorage.setItem(STREAM_CACHE_KEY(5), JSON.stringify({
      time: Array.from({ length: n }, (_, i) => i), velocity_smooth: Array.from({ length: n }, () => 3),
    }))
    const run = { id: 5, paceSec: 330, durationSec: 100, distanceKm: 1 } as never
    const res = await loadAnalyticsStreams([run], [], 50)
    expect(res.fetched).toBe(1)
  })
})

describe('T-259 P-08: Refresh-Fehler', () => {
  beforeEach(() => { vi.stubGlobal('window', globalThis) })
  it('Refresh 400 -> Tokens geloescht + Reauth-Flag', async () => {
    setExpiredTokens()
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 400, text: async () => '' })))
    expect(await getValidToken()).toBeNull()
    expect(loadTokens()).toBeNull()
    expect(localStorage.getItem(STRAVA_REAUTH_KEY)).toBe('1')
  })
  it('Refresh 401 -> Tokens geloescht', async () => {
    setExpiredTokens()
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401 })))
    expect(await getValidToken()).toBeNull()
    expect(loadTokens()).toBeNull()
  })
  it('Race: paralleler Refresh hat schon neue Tokens gespeichert -> spaeterer 400 loescht nicht', async () => {
    setExpiredTokens()
    const fresh = { access_token: 'new', refresh_token: 'r2', expires_at: Math.floor(Date.now() / 1000) + 3600 }
    let call = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      call++
      if (call === 1) return { ok: true, status: 200, json: async () => fresh }
      return { ok: false, status: 400 }
    }))
    // Beide Refreshes starten mit dem alten Token; der erste speichert, der zweite scheitert mit 400
    const [a, b] = await Promise.all([getValidToken(), getValidToken()])
    expect(a).toBe('new')
    expect(b).toBeNull()
    expect(loadTokens()?.refresh_token).toBe('r2')
    expect(localStorage.getItem(STRAVA_REAUTH_KEY)).toBeNull()
  })
  it('Netzfehler -> Tokens bleiben', async () => {
    setExpiredTokens()
    vi.stubGlobal('fetch', offline())
    expect(await getValidToken()).toBeNull()
    expect(loadTokens()?.refresh_token).toBe('r')
    expect(localStorage.getItem(STRAVA_REAUTH_KEY)).toBeNull()
  })
  it('Refresh 500 -> Tokens bleiben', async () => {
    setExpiredTokens()
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500 })))
    expect(await getValidToken()).toBeNull()
    expect(loadTokens()).not.toBeNull()
  })
})

describe('T-259 P-09: OAuth state', () => {
  it('getAuthUrl enthaelt state und speichert ihn', () => {
    const state = new URL(getAuthUrl()).searchParams.get('state')
    expect(state).toBeTruthy()
    expect(sessionStorage.getItem('strava_oauth_state')).toBe(state)
  })
  it('iOS-Pfad: sessionStorage leer, localStorage hat state -> code, beide Speicher danach leer', () => {
    const state = new URL(getAuthUrl()).searchParams.get('state')!
    sessionStorage.clear()
    expect(localStorage.getItem('strava_oauth_state')).toBe(state)
    expect(parseOAuthCallback(`?code=abc&state=${state}`)).toEqual({ code: 'abc' })
    expect(sessionStorage.getItem('strava_oauth_state')).toBeNull()
    expect(localStorage.getItem('strava_oauth_state')).toBeNull()
  })
  it('passender state -> code; state wird verbraucht', () => {
    const state = new URL(getAuthUrl()).searchParams.get('state')!
    expect(parseOAuthCallback(`?code=abc&state=${state}`)).toEqual({ code: 'abc' })
    expect(parseOAuthCallback(`?code=abc&state=${state}`)).toHaveProperty('error')
  })
  it('falscher state -> Fehler, kein code', () => {
    getAuthUrl()
    const r = parseOAuthCallback('?code=abc&state=evil')
    expect(r).toHaveProperty('error')
    expect(r).not.toHaveProperty('code')
  })
  it('kein gespeicherter state (alter Tab) -> klare Fehlermeldung statt Crash', () => {
    const r = parseOAuthCallback('?code=abc&state=x')
    expect(r).toHaveProperty('error')
  })
  it('kein code -> null', () => {
    expect(parseOAuthCallback('?foo=1')).toBeNull()
  })
  it('error=access_denied -> Fehler', () => {
    expect(parseOAuthCallback('?error=access_denied')).toHaveProperty('error')
  })
})

describe('T-259 P-12: Disconnect loescht Strava-Daten', () => {
  it('clearTokens entfernt Token, Aktivitaeten, Stream/Laps-Caches und Workbox-Cache', () => {
    localStorage.setItem('strava_tokens', '{}')
    localStorage.setItem(STREAM_CACHE_KEY(1), '{}')
    localStorage.setItem(LAPS_CACHE_KEY(1), '[]')
    localStorage.setItem('other', 'keep')
    const del = vi.fn(async () => true)
    vi.stubGlobal('caches', { delete: del })
    clearTokens()
    expect(localStorage.getItem(STREAM_CACHE_KEY(1))).toBeNull()
    expect(localStorage.getItem(LAPS_CACHE_KEY(1))).toBeNull()
    expect(localStorage.getItem('other')).toBe('keep')
    expect(getCachedActivities()).toEqual([])
    expect(del).toHaveBeenCalledWith('strava-api')
  })
  it('clearTokens ohne caches-API wirft nicht', () => {
    vi.stubGlobal('caches', undefined)
    expect(() => clearTokens()).not.toThrow()
  })
})
