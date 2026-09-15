// T-151: pushSync 409-Retry ohne Rebuild = RMW-Race
// Tests MÜSSEN rot sein vor der Impl (test-first), dann grün nach Impl.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { pushSync, setToken, getToken, fetchSync } from './githubSync'
import type { SyncData } from './githubSync'
import { registerEvictCallback, STORAGE_WARNING_KEY } from './storage'

// Decode the base64-encoded content from a PUT body.
// pushSync encodes UTF-8 → base64, so the inverse must decode UTF-8 as well.
// (Der frühere ASCII-only-Helfer hat genau die Asymmetrie verdeckt, die T-208 behebt.)
function decodePutContent(content: string): SyncData {
  const bin = atob(content.replace(/\n/g, ''))
  const bytes = Uint8Array.from(bin, c => c.charCodeAt(0))
  return JSON.parse(new TextDecoder().decode(bytes))
}

// Helper to build a mock Response-like object for fetch
function putResponse(status: number) {
  return { ok: status >= 200 && status < 300, status }
}

function getResponse(data: SyncData, sha: string) {
  const content = btoa(JSON.stringify(data))
  return {
    ok: true,
    status: 200,
    json: async () => ({ sha, content }),
  }
}

describe('pushSync — T-151 409-rebuild', () => {
  beforeEach(() => {
    localStorage.setItem('github_sync_token', 'test-token-xyz')
    vi.resetAllMocks()
  })

  afterEach(() => {
    localStorage.clear()
    vi.unstubAllGlobals()
  })

  // ─────────────────────────────────────────────────────────────────────────
  // AC-3a: WITH rebuildFn — fremde Änderung erhalten + eigene Mutation anfügen
  // ─────────────────────────────────────────────────────────────────────────
  it('WITH rebuildFn: retry PUT carries foreign change preserved + own mutation appended', async () => {
    const mutation = { id: 'm1', type: 'start', start: '2026-07-01', est_days: 9 }

    // stale = was the local view before first fetch; empty mutation queue
    const staleData: SyncData = {
      settings: { vdot: 45 },
      injuryBreakMutations: [],
    }

    // fresh = concurrent Streamlit write cleared the mutation queue AND added a plan
    const freshRemoteData: SyncData = {
      settings: { vdot: 45 },
      injuryBreakMutations: [],          // cleared by Desktop processing
      plan: {
        schemaVersion: 1,
        generatedAt: '2026-07-02T10:00:00Z',
        generatedBy: 'streamlit',
        vdot: 47,
        paces: { E_low: '6:30', E_high: '6:00', M: '5:10', T: '4:45', I: '4:20', R: '4:00' },
        inputHash: 'abc123',
        weeks: [],
      },
    }

    const capturedPuts: Array<Record<string, unknown>> = []

    vi.stubGlobal('fetch', vi.fn(async (_url: string, opts: RequestInit) => {
      const method = (opts?.method ?? 'GET').toUpperCase()
      if (method === 'PUT') {
        capturedPuts.push(JSON.parse(opts.body as string))
        return putResponse(capturedPuts.length === 1 ? 409 : 200)
      }
      // GET — return the fresh remote stand with foreign change
      return getResponse(freshRemoteData, 'fresh-sha-456')
    }))

    // rebuildFn: append own mutation to whatever the fresh queue contains
    const rebuildFn = (base: SyncData): SyncData => ({
      ...base,
      injuryBreakMutations: [...(base.injuryBreakMutations ?? []), mutation as never],
    })

    await pushSync(staleData, 'stale-sha-123', rebuildFn)

    // Exactly 2 PUTs (initial 409 + one retry)
    expect(capturedPuts).toHaveLength(2)

    // Retry PUT must use the fresh sha, not the stale one
    expect(capturedPuts[1].sha).toBe('fresh-sha-456')

    // Decode the retry PUT body content
    const retryPayload = decodePutContent(capturedPuts[1].content as string)

    // Foreign change (plan added by Streamlit) must be preserved
    expect(retryPayload.plan).toBeDefined()
    expect(retryPayload.plan?.vdot).toBe(47)

    // Own mutation must be appended (not lost, not duplicated)
    expect(retryPayload.injuryBreakMutations).toHaveLength(1)
    expect(retryPayload.injuryBreakMutations?.[0]).toMatchObject(mutation)
  })

  // ─────────────────────────────────────────────────────────────────────────
  // AC-3b: WITHOUT rebuildFn — bisheriges Verhalten (Regressionsschutz)
  // ─────────────────────────────────────────────────────────────────────────
  it('WITHOUT rebuildFn: retry PUT carries original data (backward-compat)', async () => {
    const staleData: SyncData = {
      settings: { vdot: 45 },
      planRecomputeRequested: true,
    }

    const freshRemoteData: SyncData = {
      settings: { vdot: 47 },           // concurrent Desktop change
      planRecomputeRequested: false,
    }

    const capturedPuts: Array<Record<string, unknown>> = []

    vi.stubGlobal('fetch', vi.fn(async (_url: string, opts: RequestInit) => {
      const method = (opts?.method ?? 'GET').toUpperCase()
      if (method === 'PUT') {
        capturedPuts.push(JSON.parse(opts.body as string))
        return putResponse(capturedPuts.length === 1 ? 409 : 200)
      }
      return getResponse(freshRemoteData, 'fresh-sha-789')
    }))

    // No rebuildFn → original staleData should be used in retry
    await pushSync(staleData, 'stale-sha-old')

    expect(capturedPuts).toHaveLength(2)

    // sha must be updated to fresh
    expect(capturedPuts[1].sha).toBe('fresh-sha-789')

    // Payload content: original staleData used (no foreign merge)
    const retryPayload = decodePutContent(capturedPuts[1].content as string)
    // settings from staleData (not overwritten by fresh)
    expect((retryPayload.settings as Record<string, unknown>)?.vdot).toBe(45)
    expect(retryPayload.planRecomputeRequested).toBe(true)
  })

  // ─────────────────────────────────────────────────────────────────────────
  // AC-3c: Zweiter 409 → Error wirft (bestehende Semantik)
  // ─────────────────────────────────────────────────────────────────────────
  it('second 409 throws an error (no infinite retry)', async () => {
    const data: SyncData = { settings: { vdot: 45 } }
    const freshRemote: SyncData = { settings: { vdot: 45 } }

    vi.stubGlobal('fetch', vi.fn(async (_url: string, opts: RequestInit) => {
      const method = (opts?.method ?? 'GET').toUpperCase()
      if (method === 'PUT') return putResponse(409)        // always 409
      return getResponse(freshRemote, 'fresh-sha-abc')
    }))

    await expect(pushSync(data, 'any-sha')).rejects.toThrow()
  })

  // ─────────────────────────────────────────────────────────────────────────
  // AC-3d: fetchSync(true) is used in retry — not the cached stale sha
  // Verify by checking that the GET call happens despite a primed cache.
  // (force=true bypasses the 60s TTL — the ticket explicitly requires this.)
  // ─────────────────────────────────────────────────────────────────────────
  it('force-fetches fresh sha in retry (does not use TTL-cached stale sha)', async () => {
    const data: SyncData = { settings: { vdot: 45 } }
    const freshData: SyncData = { settings: { vdot: 50 } }

    let getCalls = 0
    vi.stubGlobal('fetch', vi.fn(async (_url: string, opts: RequestInit) => {
      const method = (opts?.method ?? 'GET').toUpperCase()
      if (method === 'GET') {
        getCalls++
        return getResponse(freshData, `fresh-sha-${getCalls}`)
      }
      // PUT: first 409, second 200
      return putResponse(getCalls === 0 ? 409 : 200)
    }))

    await pushSync(data, 'stale-sha')

    // At least one GET must have happened during the retry
    expect(getCalls).toBeGreaterThanOrEqual(1)
  })
})

// ── T-170: setToken quota hardening ──────────────────────────────────────────

describe('setToken quota hardening (T-170)', () => {
  beforeEach(() => { localStorage.clear(); registerEvictCallback(() => {}) })
  afterEach(() => { vi.restoreAllMocks(); localStorage.clear() })

  it('successful save → true, token persisted', () => {
    expect(setToken('ghp_test123')).toBe(true)
    expect(getToken()).toBe('ghp_test123')
  })

  it('quota exhausted → false, no throw, STORAGE_WARNING_KEY set', () => {
    const origSetItem = Storage.prototype.setItem.bind(localStorage)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === 'github_sync_token') throw new DOMException('QuotaExceededError', 'QuotaExceededError')
      origSetItem(key, value)
    })

    let threw = false
    let ok = true
    try { ok = setToken('ghp_lost') } catch { threw = true }
    vi.restoreAllMocks()

    expect(threw).toBe(false)
    expect(ok).toBe(false)
    expect(localStorage.getItem(STORAGE_WARNING_KEY)).not.toBeNull()
  })
})

// ── T-184: fetchSync roundtrips the activityTemps field ──────────────────────────────────
// Fix-loop (coordinator review): the earlier version had _doFetchSync forward this map into a
// hidden strava.ts module store — invisible to React's useMemo([cached]) dependency arrays,
// so the UI never re-parsed after an async sync resolved. Fixed by removing the store entirely:
// callers now read `result.data.activityTemps` directly off the fetchSync() result (same pattern
// already used for `result.data.plan`/`result.data.settings` elsewhere in this file) and hold it
// in their own component state, explicit in their useMemo deps. Nothing left to test at the
// githubSync.ts boundary except that the base64/JSON roundtrip preserves the field faithfully.
describe('fetchSync — activityTemps field roundtrip (T-184)', () => {
  beforeEach(() => {
    localStorage.setItem('github_sync_token', 'test-token-xyz')
    vi.resetAllMocks()
  })

  afterEach(() => {
    localStorage.clear()
    vi.unstubAllGlobals()
  })

  it('activityTemps present in sync.json → present on fetchSync() result.data', async () => {
    const data: SyncData = { settings: {}, activityTemps: { '123': 22.4 } }
    vi.stubGlobal('fetch', vi.fn(async () => getResponse(data, 'sha-1')))

    const result = await fetchSync(true)

    expect(result?.data.activityTemps).toEqual({ '123': 22.4 })
  })

  it('activityTemps absent from sync.json → result.data.activityTemps is undefined, no throw', async () => {
    const data: SyncData = { settings: {} }
    vi.stubGlobal('fetch', vi.fn(async () => getResponse(data, 'sha-2')))

    const result = await fetchSync(true)

    expect(result?.data.activityTemps).toBeUndefined()
  })

  it('no sync.json at all (404) → fetchSync resolves null, no throw', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 })))

    const result = await fetchSync(true)

    expect(result).toBeNull()
  })
})

// ── T-208: base64-Roundtrip muss UTF-8-fest sein ─────────────────────────────
// Gefundener Realfall: pushSync schreibt UTF-8 (btoa(unescape(encodeURIComponent(…)))),
// _doFetchSync las aber mit blossem atob() — das liefert eine Latin-1-Bytefolge, aus
// "Qualität ⭐" wurde "QualitÃ¤t â­". Sichtbar wurde das erst, wenn die letzte
// Schreibung von der PWA kam: Streamlit schreibt json.dumps(ensure_ascii=True), also
// reines ASCII (ä-Escapes), das atob() unbeschadet passiert. Nach jedem PWA-Push
// (Tagestausch, Settings-Änderung) war der Wochenplan am iPhone zerschossen.
//
// getResponse() oben kann diesen Fall nicht abbilden — btoa() wirft bei non-ASCII.
// Deshalb ein eigener Builder, der exakt das liefert, was die GitHub-API für eine
// von pushSync geschriebene Datei zurückgibt.
function getResponseUtf8(data: SyncData, sha: string) {
  const json = JSON.stringify(data)
  const content = btoa(String.fromCharCode(...new TextEncoder().encode(json)))
  return { ok: true, status: 200, json: async () => ({ sha, content }) }
}

describe('fetchSync — UTF-8-Roundtrip (T-208)', () => {
  // Umlaute, Emoji, En-Dash, Pfeil, Multiplikationszeichen, tiefgestellte 2 —
  // alles Zeichen, die real in den Plan-Sessions stehen.
  const SESSION = {
    tag: 'Di',
    typ: 'Qualität ⭐',
    km: 8.6,
    vorgabe: '1×20 min @ 4:19 /km (T-Pace, Z4)',
    struktur: '2 km einlaufen → 4×1000m (VO₂max) → 2 km auslaufen',
    dauer: '41–47 min',
    hinweis: 'Längere T-Blöcke stärken die Laktattoleranz — gleichmäßig laufen.',
  }

  beforeEach(() => {
    localStorage.setItem('github_sync_token', 'test-token-xyz')
    vi.resetAllMocks()
  })

  afterEach(() => {
    localStorage.clear()
    vi.unstubAllGlobals()
  })

  it('UTF-8-kodierte sync.json → Umlaute/Emoji kommen unverfälscht an', async () => {
    const data = { settings: { note: 'Fußgängerübergang' }, plan: { weeks: [{ sessions: [SESSION] }] } } as unknown as SyncData
    vi.stubGlobal('fetch', vi.fn(async () => getResponseUtf8(data, 'sha-utf8')))

    const result = await fetchSync(true)
    const session = (result?.data.plan as unknown as { weeks: Array<{ sessions: typeof SESSION[] }> }).weeks[0].sessions[0]

    expect(session.typ).toBe('Qualität ⭐')
    expect(session.struktur).toBe('2 km einlaufen → 4×1000m (VO₂max) → 2 km auslaufen')
    expect(session.dauer).toBe('41–47 min')
    expect(session.hinweis).toBe('Längere T-Blöcke stärken die Laktattoleranz — gleichmäßig laufen.')
    expect(result?.data.settings?.note).toBe('Fußgängerübergang')
  })

  it('pushSync → fetchSync ist verlustfrei (genau der Pfad, der am iPhone brach)', async () => {
    const data = { settings: { note: 'Läufe über 30 km' }, plan: { weeks: [{ sessions: [SESSION] }] } } as unknown as SyncData

    // 1. Push: PUT-Body einsammeln
    let pushedContent = ''
    vi.stubGlobal('fetch', vi.fn(async (_url: string, opts: RequestInit) => {
      pushedContent = JSON.parse(opts.body as string).content
      return putResponse(200)
    }))
    await pushSync(data, 'sha-old')

    // 2. Genau dieses content-Feld serviert GitHub beim nächsten GET zurück
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200, json: async () => ({ sha: 'sha-new', content: pushedContent }),
    })))

    const result = await fetchSync(true)
    const session = (result?.data.plan as unknown as { weeks: Array<{ sessions: typeof SESSION[] }> }).weeks[0].sessions[0]

    expect(session).toEqual(SESSION)
    expect(result?.data.settings?.note).toBe('Läufe über 30 km')
  })
})
