// P-10: Strava liefert HTML (5xx/Wartung) -> Worker muss 502 + CORS liefern statt zu werfen.
import { describe, it, expect, afterEach, vi } from 'vitest'
import worker from './index'

const ORIGIN = 'https://app.example'
const env = { STRAVA_CLIENT_SECRET: 's', STRAVA_CLIENT_ID: '1', ALLOWED_ORIGIN: ORIGIN } as never

afterEach(() => vi.unstubAllGlobals())

describe('Strava-Proxy: Upstream ohne JSON (P-10)', () => {
  for (const [path, body] of [
    ['/strava/token', { code: 'c', redirect_uri: 'https://app.example/cb' }],
    ['/strava/refresh', { refresh_token: 'r' }],
  ] as const) {
    it(`${path} -> 502 upstream_non_json mit CORS`, async () => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>Bad Gateway</html>', { status: 503 })))
      const res = await worker.fetch(new Request('https://w.example' + path, {
        method: 'POST', headers: { Origin: ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      }), env)
      expect(res.status).toBe(502)
      expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN)
      expect(await res.json()).toEqual({ error: 'upstream_non_json', status: 503 })
    })
  }
})
