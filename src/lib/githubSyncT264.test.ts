// T-264 / D-061: sync.json liegt im PRIVATEN Repo `marathon-data`. Lesen nur mit Token über die
// Contents-API; fehlender Token-Zugriff (privat → 404/403) muss als SyncAccessError mit Klartext
// auftauchen statt still als „noch keine Sync-Daten" (null).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { fetchSync, pushSync, SyncAccessError, SYNC_CONTENTS_URL, SYNC_REPO } from './githubSync'

const CONTENTS = 'https://api.github.com/repos/6dwkt42m6p-ux/marathon-data/contents/data/sync.json'
const REPO_URL = 'https://api.github.com/repos/6dwkt42m6p-ux/marathon-data'

function okContents(data: object, sha = 's1') {
  return { ok: true, status: 200, json: async () => ({ sha, content: btoa(JSON.stringify(data)) }) }
}

describe('githubSync — privates Daten-Repo (T-264)', () => {
  beforeEach(() => {
    localStorage.setItem('github_sync_token', 'test-token-xyz')
    vi.resetAllMocks()
  })
  afterEach(() => {
    localStorage.clear()
    vi.unstubAllGlobals()
  })

  it('Ziel ist 6dwkt42m6p-ux/marathon-data/data/sync.json', () => {
    expect(SYNC_REPO).toBe('6dwkt42m6p-ux/marathon-data')
    expect(SYNC_CONTENTS_URL).toBe(CONTENTS)
  })

  it('fetchSync + pushSync gehen an marathon-data (Contents-API, mit Bearer-Token), nie an marathon-pwa', async () => {
    const calls: Array<{ url: string; auth?: string }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, opts?: RequestInit) => {
      calls.push({ url, auth: (opts?.headers as Record<string, string>)?.Authorization })
      if (opts?.method === 'PUT') return { ok: true, status: 200, json: async () => ({ content: { sha: 's2' } }) }
      return okContents({ settings: {} })
    }))
    await fetchSync(true)
    await pushSync({ settings: {} }, 's1')
    expect(calls).toHaveLength(2)
    for (const c of calls) {
      expect(c.url).toBe(CONTENTS)
      expect(c.url).not.toContain('marathon-pwa')
      expect(c.url).not.toContain('raw.githubusercontent')
      expect(c.auth).toBe('Bearer test-token-xyz')
    }
  })

  it('404 auf Datei UND Repo (kein Zugriff aufs private Repo) → SyncAccessError mit Klartext', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 })))
    const p = fetchSync(true)
    await expect(p).rejects.toBeInstanceOf(SyncAccessError)
    await expect(fetchSync(true)).rejects.toThrow(/Token hat keinen Zugriff auf 6dwkt42m6p-ux\/marathon-data/)
  })

  it('404 auf Datei, Repo erreichbar → null (Datei noch nicht angelegt)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      url === REPO_URL ? { ok: true, status: 200, json: async () => ({}) } : { ok: false, status: 404 }))
    await expect(fetchSync(true)).resolves.toBeNull()
  })

  it('403 beim Lesen → SyncAccessError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 403 })))
    await expect(fetchSync(true)).rejects.toBeInstanceOf(SyncAccessError)
  })

  it.each([403, 404])('PUT %i → SyncAccessError', async (status) => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status })))
    await expect(pushSync({ settings: {} }, 's1')).rejects.toBeInstanceOf(SyncAccessError)
  })
})
