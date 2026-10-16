// T-282: Sync-Schreibpfade gebündelt in lib/syncActions.ts — test-first (rot vor Impl).
// Echte githubSync-Implementierung gegen eine Fake-GitHub-fetch: so sind 409-Rebuild,
// SyncAccessError (403/404) und der Pending-Marker-Zeitpunkt je Funktion end-to-end belegt.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  pushNoteMutations, flushPendingSync,
  pushInjuryMutation,
  pushWeekOverride,
  pushSettings, pushPlanRecomputeRequest, buildSettingsPushPayload,
} from './syncActions'
import { SyncAccessError, type SyncData } from './githubSync'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadPendingNoteMutations, appendPendingNoteMutation, type NoteMutation } from './notesSync'
import { loadPendingMutation, type InjuryBreakMutation } from './injury'
import { markWeekOverridePending, isWeekOverridePending, swapsToMap, type AppSettings } from './storage'
import * as storage from './storage'

// Fix-Loop 1: pendingWeekOverrideMaps fängt intern alles ab — um „wirft vor dem try" zu belegen,
// wird es per Mock werfbar gemacht (Default = echte Implementierung).
vi.mock('./storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./storage')>()
  return { ...actual, pendingWeekOverrideMaps: vi.fn(actual.pendingWeekOverrideMaps) }
})

const REPO_URL = 'https://api.github.com/repos/6dwkt42m6p-ux/marathon-data'

const enc = (d: SyncData) => btoa(unescape(encodeURIComponent(JSON.stringify(d))))
const dec = (b64: string) => JSON.parse(decodeURIComponent(escape(atob(b64)))) as SyncData

interface FakeOpts {
  remote: SyncData | null          // null = Datei fehlt (Repo erreichbar → fetchSync liefert null)
  getStatus?: number               // != 200 → GET der Datei antwortet mit diesem Status
  putStatuses?: number[]           // je PUT ein Status, danach 200
  concurrent?: SyncData            // Remote-Stand, der beim 409 „zwischenzeitlich" geschrieben wurde
}

function fakeGitHub(o: FakeOpts) {
  let remote = o.remote
  let sha = 'sha-0'
  const putStatuses = [...(o.putStatuses ?? [])]
  const gets: string[] = []
  const puts: Array<{ data: SyncData; sha?: string; status: number }> = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, opts?: RequestInit) => {
    if (opts?.method === 'PUT') {
      const body = JSON.parse(String(opts.body))
      const status = putStatuses.shift() ?? 200
      puts.push({ data: dec(body.content), sha: body.sha, status })
      if (status === 409) {
        if (o.concurrent) remote = o.concurrent
        sha = `${sha}-c`
        return { ok: false, status }
      }
      if (status !== 200) return { ok: false, status }
      remote = dec(body.content)
      sha = `sha-${puts.length}`
      return { ok: true, status: 200, json: async () => ({ content: { sha } }) }
    }
    gets.push(url)
    if (url === REPO_URL) return { ok: true, status: 200, json: async () => ({}) }
    if (o.getStatus && o.getStatus !== 200) return { ok: false, status: o.getStatus }
    if (remote === null) return { ok: false, status: 404 }
    return { ok: true, status: 200, json: async () => ({ sha, content: enc(remote!) }) }
  }))
  return { gets, puts }
}

const noteM = (id: number, ts: string, text = 'x'): NoteMutation =>
  ({ type: 'save', activity_id: id, text, rating: 3, ts })

const injM: InjuryBreakMutation = {
  type: 'start', ts: '2026-10-15T08:00:00.000Z', start: '2026-10-15', est_days: 7, severity: 'minor', note: '',
}

const SETTINGS: AppSettings = {
  vdot: 50, maxHr: 190, restHr: 45, currentWeeklyKm: 60, runsPerWeek: 5,
  raceType1: 'marathon', raceDate1: '2027-04-18', raceType2: 'hm', raceDate2: '2026-11-01',
  preRaceEnabled: true, experience: 'fortgeschritten', name: 'P',
}

beforeEach(() => {
  localStorage.clear()
  localStorage.setItem('github_sync_token', 'test-token')
})
afterEach(() => {
  localStorage.clear()
  vi.unstubAllGlobals()
})

// ─── pushNoteMutations (RunDetail) ───────────────────────────────────────────

describe('pushNoteMutations', () => {
  it('Erfolg: Mutation wird VOR dem Fetch eingereiht, gepusht und als pushed markiert', async () => {
    const gh = fakeGitHub({ remote: { settings: { a: 1 } } })
    const m = noteM(7, '2026-10-15T10:00:00.000Z')
    const p = pushNoteMutations(m)
    expect(loadPendingNoteMutations().map(x => x.ts)).toEqual([m.ts])  // synchron vor await
    await p
    expect(gh.puts).toHaveLength(1)
    expect(gh.puts[0].data.noteMutations?.map(x => x.ts)).toEqual([m.ts])
    expect(gh.puts[0].data.settings).toEqual({ a: 1 })
    expect(loadPendingNoteMutations()[0].pushed).toBe(true)
  })

  it('409: Rebuild gegen frischen Stand — fremde Änderung bleibt, eigene Mutation erneut angefügt', async () => {
    const gh = fakeGitHub({
      remote: {}, putStatuses: [409],
      concurrent: { plan: { generatedAt: 'neu' } as unknown as SyncData['plan'], noteMutations: [noteM(1, '2026-10-15T09:00:00.000Z')] },
    })
    const m = noteM(7, '2026-10-15T10:00:00.000Z')
    await pushNoteMutations(m)
    expect(gh.puts).toHaveLength(2)
    const retry = gh.puts[1].data
    expect(retry.plan).toEqual({ generatedAt: 'neu' })
    expect(retry.noteMutations?.map(x => x.ts)).toEqual(['2026-10-15T09:00:00.000Z', m.ts])
  })

  it('SyncAccessError (PUT 403) wird durchgereicht, Mutation bleibt pending (nicht pushed)', async () => {
    fakeGitHub({ remote: {}, putStatuses: [403] })
    const m = noteM(7, '2026-10-15T10:00:00.000Z')
    await expect(pushNoteMutations(m)).rejects.toBeInstanceOf(SyncAccessError)
    expect(loadPendingNoteMutations()).toHaveLength(1)
    expect(loadPendingNoteMutations()[0].pushed).toBeFalsy()
  })

  it('Datei fehlt (fresh=null): Push mit {} ohne sha, aber KEIN pushed-Marker', async () => {
    const gh = fakeGitHub({ remote: null })
    const m = noteM(7, '2026-10-15T10:00:00.000Z')
    await pushNoteMutations(m)
    expect(gh.puts).toHaveLength(1)
    expect(gh.puts[0].sha).toBeUndefined()
    expect(loadPendingNoteMutations()[0].pushed).toBeFalsy()
  })
})

// ─── flushPendingSync, Notiz-Anteil (App-Start, Settings-Sync) ─────────────

describe('flushPendingSync — Notiz-Anteil (T-297, vormals flushPendingNoteMutations)', () => {
  it('Fix-Loop 1: rejectet nicht bei korruptem Remote (noteMutations als Objekt)', async () => {
    const gh = fakeGitHub({ remote: {} })
    appendPendingNoteMutation(noteM(7, '2026-10-15T10:00:00.000Z'))
    const corrupt = { noteMutations: {} } as unknown as SyncData
    await expect(flushPendingSync(corrupt, 'sha-0')).resolves.toBeUndefined()
    expect(gh.puts).toHaveLength(0)
  })

  it('Fix-Loop 1: rejectet nicht bei korrupter lokaler Queue (Objekt statt Liste)', async () => {
    fakeGitHub({ remote: {} })
    localStorage.setItem('pending_note_mutations', JSON.stringify({ kaputt: true }))
    await expect(flushPendingSync({}, 'sha-0')).resolves.toBeUndefined()
  })

  it('Erfolg: nutzt übergebene data/sha (kein GET), pusht Rest-Queue, markiert pushed', async () => {
    const gh = fakeGitHub({ remote: {} })
    const m = noteM(7, '2026-10-15T10:00:00.000Z')
    appendPendingNoteMutation(m)
    await flushPendingSync({ settings: { a: 1 } }, 'sha-0')
    expect(gh.gets).toHaveLength(0)
    expect(gh.puts).toHaveLength(1)
    expect(gh.puts[0].sha).toBe('sha-0')
    expect(gh.puts[0].data.settings).toEqual({ a: 1 })
    expect(gh.puts[0].data.noteMutations?.map(x => x.ts)).toEqual([m.ts])
    expect(loadPendingNoteMutations()[0].pushed).toBe(true)
  })

  it('nichts pending → kein Push', async () => {
    const gh = fakeGitHub({ remote: {} })
    await flushPendingSync({}, 'sha-0')
    expect(gh.puts).toHaveLength(0)
  })

  it('409: Rebuild gegen frischen Stand erhält fremde Felder', async () => {
    const gh = fakeGitHub({ remote: {}, putStatuses: [409], concurrent: { settings: { neu: true } } })
    appendPendingNoteMutation(noteM(7, '2026-10-15T10:00:00.000Z'))
    await flushPendingSync({}, 'sha-0')
    expect(gh.puts).toHaveLength(2)
    expect(gh.puts[1].data.settings).toEqual({ neu: true })
    expect(gh.puts[1].data.noteMutations).toHaveLength(1)
  })

  it('best-effort: SyncAccessError wird geschluckt (resolved), Mutation bleibt unmarkiert', async () => {
    fakeGitHub({ remote: {}, putStatuses: [403] })
    appendPendingNoteMutation(noteM(7, '2026-10-15T10:00:00.000Z'))
    await expect(flushPendingSync({}, 'sha-0')).resolves.toBeUndefined()
    expect(loadPendingNoteMutations()[0].pushed).toBeFalsy()
  })
})

// ─── pushInjuryMutation (Settings Start/Ende) ───────────────────────────────

describe('pushInjuryMutation', () => {
  it('Erfolg: fetch(force) → Push mit angehängter Mutation → Pending-Marker NACH Erfolg', async () => {
    const gh = fakeGitHub({ remote: { injuryBreakMutations: [], settings: { a: 1 } } })
    await pushInjuryMutation(injM)
    expect(gh.gets).toHaveLength(1)
    expect(gh.puts[0].sha).toBe('sha-0')
    expect(gh.puts[0].data.injuryBreakMutations).toEqual([injM])
    expect(gh.puts[0].data.settings).toEqual({ a: 1 })
    expect(loadPendingMutation()).toEqual(injM)
  })

  it('409: Rebuild hängt eigene Mutation an die frische Queue', async () => {
    const other = { ...injM, ts: '2026-10-14T08:00:00.000Z' } as InjuryBreakMutation
    const gh = fakeGitHub({ remote: {}, putStatuses: [409], concurrent: { injuryBreakMutations: [other] } })
    await pushInjuryMutation(injM)
    expect(gh.puts[1].data.injuryBreakMutations).toEqual([other, injM])
  })

  it('SyncAccessError (PUT 403) wird durchgereicht, kein Pending-Marker', async () => {
    fakeGitHub({ remote: {}, putStatuses: [403] })
    await expect(pushInjuryMutation(injM)).rejects.toBeInstanceOf(SyncAccessError)
    expect(loadPendingMutation()).toBeNull()
  })

  it('SyncAccessError beim Lesen (GET 403) wird durchgereicht, kein Push', async () => {
    const gh = fakeGitHub({ remote: {}, getStatus: 403 })
    await expect(pushInjuryMutation(injM)).rejects.toBeInstanceOf(SyncAccessError)
    expect(gh.puts).toHaveLength(0)
    expect(loadPendingMutation()).toBeNull()
  })
})

// ─── pushWeekOverride (TodayWorkout Tausch/Reset) ───────────────────────────

describe('pushWeekOverride', () => {
  const W = '2026-10-12'

  it('Erfolg: setzt nur diese Woche, erhält andere Wochen, löscht Marker mit Stamp', async () => {
    const gh = fakeGitHub({ remote: { weekOverrides: { '2026-10-05': { Mo: 'Di' } } } })
    const stamp = markWeekOverridePending(W)
    await pushWeekOverride(W, { Di: 'Mi' }, stamp)
    expect(gh.puts[0].data.weekOverrides).toEqual({ '2026-10-05': { Mo: 'Di' }, [W]: { Di: 'Mi' } })
    expect(isWeekOverridePending(W)).toBe(false)
  })

  it('Marker eines neueren Edits (anderer Stamp) bleibt stehen', async () => {
    fakeGitHub({ remote: {} })
    markWeekOverridePending(W, 'alt')
    markWeekOverridePending(W, 'neu')
    await pushWeekOverride(W, { Di: 'Mi' }, 'alt')
    expect(isWeekOverridePending(W)).toBe(true)
  })

  it('409: Rebuild gegen frischen Stand erhält zwischenzeitliche Desktop-Wochen', async () => {
    const gh = fakeGitHub({ remote: {}, putStatuses: [409], concurrent: { weekOverrides: { '2026-10-05': { Fr: 'Sa' } } } })
    const stamp = markWeekOverridePending(W)
    await pushWeekOverride(W, { Di: 'Mi' }, stamp)
    expect(gh.puts[1].data.weekOverrides).toEqual({ '2026-10-05': { Fr: 'Sa' }, [W]: { Di: 'Mi' } })
    expect(isWeekOverridePending(W)).toBe(false)
  })

  it('SyncAccessError wird durchgereicht, Woche bleibt pending', async () => {
    fakeGitHub({ remote: {}, putStatuses: [403] })
    const stamp = markWeekOverridePending(W)
    await expect(pushWeekOverride(W, { Di: 'Mi' }, stamp)).rejects.toBeInstanceOf(SyncAccessError)
    expect(isWeekOverridePending(W)).toBe(true)
  })

  it('ohne Token: kein Netz, Woche bleibt pending', async () => {
    localStorage.removeItem('github_sync_token')
    const gh = fakeGitHub({ remote: {} })
    const stamp = markWeekOverridePending(W)
    await pushWeekOverride(W, { Di: 'Mi' }, stamp)
    expect(gh.gets).toHaveLength(0)
    expect(gh.puts).toHaveLength(0)
    expect(isWeekOverridePending(W)).toBe(true)
  })
})

// ─── flushPendingSync, Wochen-Anteil (App-Start, Settings-Sync) ────────────

describe('flushPendingSync — Wochen-Anteil (T-297, vormals flushPendingWeekOverrides)', () => {
  const W = '2026-10-12'

  it('Fix-Loop 1: rejectet nicht, wenn das Lesen der Pending-Wochen wirft', async () => {
    const gh = fakeGitHub({ remote: {} })
    vi.mocked(storage.pendingWeekOverrideMaps).mockImplementationOnce(() => { throw new Error('storage kaputt') })
    await expect(flushPendingSync({}, 'sha-0')).resolves.toBeUndefined()
    expect(gh.puts).toHaveLength(0)
  })
  const swaps = () => localStorage.setItem('week_override_' + W, JSON.stringify([
    { originalDay: 'Di', currentDay: 'Mi' }, { originalDay: 'Mi', currentDay: 'Di' },
  ]))

  it('Erfolg: übergebene data/sha, pending Wochen gepusht, Marker gelöscht', async () => {
    const gh = fakeGitHub({ remote: {} })
    swaps(); markWeekOverridePending(W)
    await flushPendingSync({ settings: { a: 1 } }, 'sha-0')
    expect(gh.gets).toHaveLength(0)
    expect(gh.puts[0].sha).toBe('sha-0')
    expect(gh.puts[0].data.weekOverrides).toEqual({ [W]: { Di: 'Mi', Mi: 'Di' } })
    expect(gh.puts[0].data.settings).toEqual({ a: 1 })
    expect(isWeekOverridePending(W)).toBe(false)
  })

  it('nichts pending → kein Push', async () => {
    const gh = fakeGitHub({ remote: {} })
    await flushPendingSync({}, 'sha-0')
    expect(gh.puts).toHaveLength(0)
  })

  it('409: Rebuild erhält frische fremde Wochen', async () => {
    const gh = fakeGitHub({ remote: {}, putStatuses: [409], concurrent: { weekOverrides: { '2026-10-05': { Fr: 'Sa' } } } })
    swaps(); markWeekOverridePending(W)
    await flushPendingSync({}, 'sha-0')
    expect(gh.puts[1].data.weekOverrides).toEqual({ '2026-10-05': { Fr: 'Sa' }, [W]: { Di: 'Mi', Mi: 'Di' } })
  })

  it('best-effort: SyncAccessError geschluckt, Woche bleibt pending', async () => {
    fakeGitHub({ remote: {}, putStatuses: [403] })
    swaps(); markWeekOverridePending(W)
    await expect(flushPendingSync({}, 'sha-0')).resolves.toBeUndefined()
    expect(isWeekOverridePending(W)).toBe(true)
  })
})

// ─── pushSettings (Settings.handleSave) ─────────────────────────────────────

describe('pushSettings', () => {
  it('Erfolg: fetch(force) → settings gemergt (Desktop-preRaceEnabled gewinnt), fremde Felder bleiben', async () => {
    const gh = fakeGitHub({ remote: { settings: { preRaceEnabled: false, desktopOnly: 1 }, weekOverrides: { x: {} } } })
    await pushSettings(SETTINGS)
    expect(gh.gets).toHaveLength(1)
    const s = gh.puts[0].data.settings as Record<string, unknown>
    expect(s.vdot).toBe(50)
    expect(s.desktopOnly).toBe(1)
    expect(s.preRaceEnabled).toBe(false)
    expect(gh.puts[0].data.weekOverrides).toEqual({ x: {} })
  })

  it('409: Rebuild merged gegen frische settings', async () => {
    const gh = fakeGitHub({ remote: { settings: {} }, putStatuses: [409], concurrent: { settings: { neu: 2 }, plan: { generatedAt: 'g' } as unknown as SyncData['plan'] } })
    await pushSettings(SETTINGS)
    expect((gh.puts[1].data.settings as Record<string, unknown>).neu).toBe(2)
    expect(gh.puts[1].data.plan).toEqual({ generatedAt: 'g' })
  })

  it('SyncAccessError wird durchgereicht', async () => {
    fakeGitHub({ remote: {}, putStatuses: [403] })
    await expect(pushSettings(SETTINGS)).rejects.toBeInstanceOf(SyncAccessError)
  })
})

// ─── pushPlanRecomputeRequest (TodayWorkout Settings-Fingerprint) ───────────

describe('pushPlanRecomputeRequest', () => {
  it('buildSettingsPushPayload setzt nur planRecomputeRequested', () => {
    expect(buildSettingsPushPayload({ settings: { a: 1 } })).toEqual({ settings: { a: 1 }, planRecomputeRequested: true })
  })

  it('Erfolg: fetch(force) → Flag gesetzt, fremde Felder bleiben', async () => {
    const gh = fakeGitHub({ remote: { settings: { a: 1 } } })
    await pushPlanRecomputeRequest()
    expect(gh.puts[0].data).toMatchObject({ settings: { a: 1 }, planRecomputeRequested: true })
  })

  it('Datei fehlt (fresh=null) → KEIN Push (anders als die übrigen Pfade)', async () => {
    const gh = fakeGitHub({ remote: null })
    await pushPlanRecomputeRequest()
    expect(gh.puts).toHaveLength(0)
  })

  it('409: Rebuild gegen frischen Stand', async () => {
    const gh = fakeGitHub({ remote: {}, putStatuses: [409], concurrent: { settings: { neu: 1 } } })
    await pushPlanRecomputeRequest()
    expect(gh.puts[1].data).toMatchObject({ settings: { neu: 1 }, planRecomputeRequested: true })
  })

  it('SyncAccessError wird durchgereicht', async () => {
    fakeGitHub({ remote: {}, putStatuses: [403] })
    await expect(pushPlanRecomputeRequest()).rejects.toBeInstanceOf(SyncAccessError)
  })

  it('ohne Token: kein Netz', async () => {
    localStorage.removeItem('github_sync_token')
    const gh = fakeGitHub({ remote: {} })
    await pushPlanRecomputeRequest()
    expect(gh.gets).toHaveLength(0)
    expect(gh.puts).toHaveLength(0)
  })
})

// ─── T-297: ein Helper, eine Token-Policy, ein kombinierter Flush ───────────

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')
const src = (rel: string) => readFileSync(join(SRC, rel), 'utf8')
const count = (s: string, re: RegExp) => (s.match(re) ?? []).length

describe('T-297 AC1: ein Abruf-/Schreib-Helper', () => {
  it('syncActions.ts enthält genau einen pushSync- und einen fetchSync-Aufruf (im Helper)', () => {
    const code = src('lib/syncActions.ts').replace(/^\s*\/\/.*$/gm, '')
    expect(count(code, /\bpushSync\(/g)).toBe(1)
    expect(count(code, /\bfetchSync\(/g)).toBe(1)
    expect(count(code, /\bhasToken\(\)/g)).toBe(1)
  })
})

describe('T-297 AC2: eine Token-Policy — ohne Token kein Netz, kein Marker/Overlay', () => {
  beforeEach(() => { localStorage.removeItem('github_sync_token') })

  it('pushInjuryMutation: kein Netz, KEIN Pending-Overlay, liefert false', async () => {
    const gh = fakeGitHub({ remote: {} })
    await expect(pushInjuryMutation(injM)).resolves.toBe(false)
    expect(gh.gets).toHaveLength(0)
    expect(gh.puts).toHaveLength(0)
    expect(loadPendingMutation()).toBeNull()
  })

  it('pushNoteMutations: Mutation bleibt eingereiht, aber nicht pushed, liefert false', async () => {
    const gh = fakeGitHub({ remote: {} })
    await expect(pushNoteMutations(noteM(7, '2026-10-15T10:00:00.000Z'))).resolves.toBe(false)
    expect(gh.gets.length + gh.puts.length).toBe(0)
    expect(loadPendingNoteMutations()).toHaveLength(1)
    expect(loadPendingNoteMutations()[0].pushed).toBeFalsy()
  })

  it('pushSettings / pushWeekOverride / pushPlanRecomputeRequest: false, kein Netz', async () => {
    const gh = fakeGitHub({ remote: {} })
    const stamp = markWeekOverridePending('2026-10-12')
    await expect(pushSettings(SETTINGS)).resolves.toBe(false)
    await expect(pushWeekOverride('2026-10-12', { Di: 'Mi' }, stamp)).resolves.toBe(false)
    await expect(pushPlanRecomputeRequest()).resolves.toBe(false)
    expect(gh.gets.length + gh.puts.length).toBe(0)
    expect(isWeekOverridePending('2026-10-12')).toBe(true)
  })

  it('flushPendingSync: kein PUT, Notiz unmarkiert, Woche bleibt pending', async () => {
    const gh = fakeGitHub({ remote: {} })
    appendPendingNoteMutation(noteM(7, '2026-10-15T10:00:00.000Z'))
    localStorage.setItem('week_override_2026-10-12', JSON.stringify([{ originalDay: 'Di', currentDay: 'Mi' }]))
    markWeekOverridePending('2026-10-12')
    await expect(flushPendingSync({}, 'sha-0')).resolves.toBeUndefined()
    expect(gh.puts).toHaveLength(0)
    expect(loadPendingNoteMutations()[0].pushed).toBeFalsy()
    expect(isWeekOverridePending('2026-10-12')).toBe(true)
  })

  it('mit Token: push* liefern true', async () => {
    localStorage.setItem('github_sync_token', 'test-token')
    fakeGitHub({ remote: {} })
    await expect(pushInjuryMutation(injM)).resolves.toBe(true)
    await expect(pushSettings(SETTINGS)).resolves.toBe(true)
  })

  it('Komponenten prüfen den Token nicht mehr selbst vor Push-Aktionen', () => {
    expect(src('components/TodayWorkout.tsx')).not.toMatch(/\bhasToken\b/)
    const settings = src('components/Settings.tsx')
    const save = settings.slice(settings.indexOf('async function handleSave'))
    expect(save.slice(0, save.indexOf('\n  }\n'))).not.toMatch(/hasToken\(\)/)
    // Overlay nur bei tatsächlich gesendeter Mutation
    expect(count(settings, /if \(await pushInjuryMutation\(mutation\)\)/g)).toBe(2)
  })
})

describe('T-297 AC3/AC5 (D-070): kombinierter Flush Notizen + Wochen-Tausche', () => {
  const W = '2026-10-12'
  const pendingBoth = () => {
    appendPendingNoteMutation(noteM(7, '2026-10-15T10:00:00.000Z'))
    localStorage.setItem('week_override_' + W, JSON.stringify([{ originalDay: 'Di', currentDay: 'Mi' }]))
    markWeekOverridePending(W)
  }

  it('beidseitig pending → genau 1 PUT mit beiden Anteilen, Marker beider Arten danach gelöscht', async () => {
    const gh = fakeGitHub({ remote: {} })
    pendingBoth()
    await flushPendingSync({ settings: { a: 1 }, weekOverrides: { '2026-10-05': { Mo: 'Di' } } }, 'sha-0')
    expect(gh.gets).toHaveLength(0)
    expect(gh.puts).toHaveLength(1)
    expect(gh.puts[0].sha).toBe('sha-0')
    expect(gh.puts[0].data.settings).toEqual({ a: 1 })
    expect(gh.puts[0].data.noteMutations?.map(x => x.ts)).toEqual(['2026-10-15T10:00:00.000Z'])
    expect(gh.puts[0].data.weekOverrides).toEqual({ '2026-10-05': { Mo: 'Di' }, [W]: { Di: 'Mi' } })
    expect(loadPendingNoteMutations()[0].pushed).toBe(true)
    expect(isWeekOverridePending(W)).toBe(false)
  })

  it('Fehlschlag (403) → resolved, Marker beider Arten bleiben', async () => {
    const gh = fakeGitHub({ remote: {}, putStatuses: [403] })
    pendingBoth()
    await expect(flushPendingSync({}, 'sha-0')).resolves.toBeUndefined()
    expect(gh.puts).toHaveLength(1)
    expect(loadPendingNoteMutations()[0].pushed).toBeFalsy()
    expect(isWeekOverridePending(W)).toBe(true)
  })

  it('409 → Rebuild komponiert beide Anteile gegen den frischen Stand', async () => {
    const gh = fakeGitHub({
      remote: {}, putStatuses: [409],
      concurrent: { settings: { neu: 1 }, weekOverrides: { '2026-10-05': { Fr: 'Sa' } } },
    })
    pendingBoth()
    await flushPendingSync({}, 'sha-0')
    expect(gh.puts).toHaveLength(2)
    const retry = gh.puts[1].data
    expect(retry.settings).toEqual({ neu: 1 })
    expect(retry.noteMutations).toHaveLength(1)
    expect(retry.weekOverrides).toEqual({ '2026-10-05': { Fr: 'Sa' }, [W]: { Di: 'Mi' } })
    expect(isWeekOverridePending(W)).toBe(false)
  })

  it('korrupte Notiz-Queue blockiert die Wochen-Tausche nicht', async () => {
    const gh = fakeGitHub({ remote: {} })
    localStorage.setItem('pending_note_mutations', JSON.stringify({ kaputt: true }))
    localStorage.setItem('week_override_' + W, JSON.stringify([{ originalDay: 'Di', currentDay: 'Mi' }]))
    markWeekOverridePending(W)
    await expect(flushPendingSync({}, 'sha-0')).resolves.toBeUndefined()
    expect(gh.puts).toHaveLength(1)
    expect(gh.puts[0].data.weekOverrides).toEqual({ [W]: { Di: 'Mi' } })
    expect(isWeekOverridePending(W)).toBe(false)
  })

  it('werfende Pending-Wochen blockieren die Notizen nicht', async () => {
    const gh = fakeGitHub({ remote: {} })
    appendPendingNoteMutation(noteM(7, '2026-10-15T10:00:00.000Z'))
    vi.mocked(storage.pendingWeekOverrideMaps).mockImplementationOnce(() => { throw new Error('kaputt') })
    await flushPendingSync({}, 'sha-0')
    expect(gh.puts).toHaveLength(1)
    expect(gh.puts[0].data.weekOverrides).toBeUndefined()
    expect(loadPendingNoteMutations()[0].pushed).toBe(true)
  })

  it('App-Start UND Settings-Sync nutzen flushPendingSync (je genau ein Aufruf, keine Einzel-Flushes)', () => {
    for (const f of ['App.tsx', 'components/Settings.tsx']) {
      const code = src(f)
      expect(count(code, /\bflushPendingSync\(/g)).toBe(1)
      expect(code).not.toMatch(/flushPendingNoteMutations|flushPendingWeekOverrides/)
    }
  })
})

describe('T-297 AC4: swapsToMap exportiert und von TodayWorkout genutzt', () => {
  it('nur getauschte Tage, Remote-Shape originalDay → currentDay', () => {
    expect(swapsToMap([
      { originalDay: 'Di', currentDay: 'Mi' }, { originalDay: 'Mi', currentDay: 'Di' }, { originalDay: 'Fr', currentDay: 'Fr' },
    ])).toEqual({ Di: 'Mi', Mi: 'Di' })
  })

  it('TodayWorkout baut die Map nicht mehr inline', () => {
    const tw = src('components/TodayWorkout.tsx')
    expect(tw).toMatch(/swapsToMap\(/)
    expect(tw).not.toMatch(/originalDay !== a\.currentDay\) map\[/)
  })
})
