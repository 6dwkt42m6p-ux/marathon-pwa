// T-156: PWA-Notizen-Sync — test-first (rot vor Impl, grün danach)
// Tests: Mutation-Builder, Pending-Liste, resolveNote, resolvePendingNoteMutation, rebuildFn
// T-170: appendPendingNoteMutation Rückgabewert bei Quota-Fehler — "Queue darf nicht als
// geschrieben gelten" (Aufrufer in RunDetail.tsx muss false erkennen).

import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  buildSaveNoteMutation,
  buildDeleteNoteMutation,
  loadPendingNoteMutations,
  appendPendingNoteMutation,
  removePendingNoteMutations,
  resolveNote,
  resolvePendingNoteMutation,
  type NoteMutation,
  type SyncedNote,
  type NotesSyncInfo,
} from './notesSync'
import type { ActivityNote } from './storage'
import { registerEvictCallback, STORAGE_WARNING_KEY } from './storage'

// ─────────────────────────────────────────────────────────────────────────────
// Mutation-Builder
// ─────────────────────────────────────────────────────────────────────────────

describe('buildSaveNoteMutation', () => {
  it('carries all form fields and a valid ISO ts', () => {
    const m = buildSaveNoteMutation(12345, 'Toller Lauf', 4)
    expect(m.type).toBe('save')
    expect(m.activity_id).toBe(12345)
    expect(m.text).toBe('Toller Lauf')
    expect(m.rating).toBe(4)
    expect(typeof m.ts).toBe('string')
    expect(new Date(m.ts).getTime()).toBeGreaterThan(0)
  })

  it('ts is a recent ISO timestamp (within last 5s)', () => {
    const before = Date.now()
    const m = buildSaveNoteMutation(1, 'x', 3)
    const after = Date.now()
    const ts = new Date(m.ts).getTime()
    expect(ts).toBeGreaterThanOrEqual(before)
    expect(ts).toBeLessThanOrEqual(after + 100)
  })
})

describe('buildDeleteNoteMutation', () => {
  it('sets type=delete and activity_id, omits text/rating', () => {
    const m = buildDeleteNoteMutation(99)
    expect(m.type).toBe('delete')
    expect(m.activity_id).toBe(99)
    expect(m.text).toBeUndefined()
    expect(m.rating).toBeUndefined()
    expect(typeof m.ts).toBe('string')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Pending-Liste (localStorage, key pending_note_mutations)
// ─────────────────────────────────────────────────────────────────────────────

describe('pending-note-list', () => {
  beforeEach(() => { localStorage.clear() })

  it('loadPendingNoteMutations returns empty array when nothing stored', () => {
    expect(loadPendingNoteMutations()).toEqual([])
  })

  it('appendPendingNoteMutation adds mutation to empty list', () => {
    const m = buildSaveNoteMutation(1, 'abc', 3)
    appendPendingNoteMutation(m)
    const result = loadPendingNoteMutations()
    expect(result).toHaveLength(1)
    expect(result[0]).toEqual(m)
  })

  it('appendPendingNoteMutation returns true on success', () => {
    expect(appendPendingNoteMutation(buildSaveNoteMutation(1, 'abc', 3))).toBe(true)
  })

  // T-170: quota exhausted → queue write must NOT silently pretend success.
  it('appendPendingNoteMutation returns false when quota exhausted, queue stays unwritten, never throws', () => {
    registerEvictCallback(() => { /* nothing to evict — storage genuinely full */ })
    const origSetItem = Storage.prototype.setItem.bind(localStorage)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === 'pending_note_mutations') throw new DOMException('QuotaExceededError', 'QuotaExceededError')
      origSetItem(key, value)
    })

    let threw = false
    let ok = true
    const m = buildSaveNoteMutation(1, 'verloren', 5)
    try { ok = appendPendingNoteMutation(m) } catch { threw = true }
    vi.restoreAllMocks()

    expect(threw).toBe(false)
    expect(ok).toBe(false)
    // The mutation did NOT make it into the persisted queue — a caller (RunDetail.tsx)
    // that ignores the return value would believe the sync-mutation was queued.
    expect(loadPendingNoteMutations()).toHaveLength(0)
    expect(localStorage.getItem(STORAGE_WARNING_KEY)).not.toBeNull()
  })

  it('appendPendingNoteMutation appends to existing list', () => {
    // Hardcoded distinct ts to avoid same-millisecond collision in test runner
    const m1: NoteMutation = { type: 'save', activity_id: 1, text: 'abc', rating: 3, ts: '2026-07-04T10:00:00.001Z' }
    const m2: NoteMutation = { type: 'delete', activity_id: 2, ts: '2026-07-04T10:00:00.002Z' }
    appendPendingNoteMutation(m1)
    appendPendingNoteMutation(m2)
    const result = loadPendingNoteMutations()
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual(m1)
    expect(result[1]).toEqual(m2)
  })

  it('appendPendingNoteMutation dedupes by ts (same ts not added twice)', () => {
    const m = buildSaveNoteMutation(1, 'abc', 3)
    appendPendingNoteMutation(m)
    appendPendingNoteMutation(m)  // same ts
    expect(loadPendingNoteMutations()).toHaveLength(1)
  })

  it('removePendingNoteMutations removes all matching ts entries', () => {
    const m1 = buildSaveNoteMutation(1, 'a', 3)
    const m2 = buildDeleteNoteMutation(2)
    appendPendingNoteMutation(m1)
    appendPendingNoteMutation(m2)
    removePendingNoteMutations([m1.ts, m2.ts])
    expect(loadPendingNoteMutations()).toHaveLength(0)
  })

  it('removePendingNoteMutations removes only matching entries (partial)', () => {
    const m1: NoteMutation = { type: 'save', activity_id: 1, text: 'a', rating: 3, ts: '2026-07-04T10:00:00.003Z' }
    const m2: NoteMutation = { type: 'delete', activity_id: 2, ts: '2026-07-04T10:00:00.004Z' }
    appendPendingNoteMutation(m1)
    appendPendingNoteMutation(m2)
    removePendingNoteMutations([m1.ts])
    const remaining = loadPendingNoteMutations()
    expect(remaining).toHaveLength(1)
    expect(remaining[0]).toEqual(m2)
  })

  it('removePendingNoteMutations returns true on success', () => {
    const m = buildSaveNoteMutation(1, 'abc', 3)
    appendPendingNoteMutation(m)
    expect(removePendingNoteMutations([m.ts])).toBe(true)
  })

  // T-170: quota exhausted mid-write must not throw and must not silently pretend the
  // already-applied mutations were popped (they would otherwise re-trigger indefinitely).
  it('removePendingNoteMutations: quota exhausted on partial-remaining write → false, never throws, list unchanged', () => {
    const m1: NoteMutation = { type: 'save', activity_id: 1, text: 'a', rating: 3, ts: '2026-07-04T10:00:00.005Z' }
    const m2: NoteMutation = { type: 'delete', activity_id: 2, ts: '2026-07-04T10:00:00.006Z' }
    appendPendingNoteMutation(m1)
    appendPendingNoteMutation(m2)

    registerEvictCallback(() => { /* nothing to evict — storage genuinely full */ })
    const origSetItem = Storage.prototype.setItem.bind(localStorage)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === 'pending_note_mutations') throw new DOMException('QuotaExceededError', 'QuotaExceededError')
      origSetItem(key, value)
    })

    let threw = false
    let ok = true
    try { ok = removePendingNoteMutations([m1.ts]) } catch { threw = true }
    vi.restoreAllMocks()

    expect(threw).toBe(false)
    expect(ok).toBe(false)
    expect(localStorage.getItem(STORAGE_WARNING_KEY)).not.toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// resolveNote — lokale Pending-Note vs. synced Desktop-Note
// ─────────────────────────────────────────────────────────────────────────────

function mkLocal(overrides: Partial<ActivityNote> = {}): ActivityNote {
  return { text: 'lokal', rating: 3, savedAt: '2026-07-01T10:00:00.000Z', ...overrides }
}

function mkSynced(overrides: Partial<SyncedNote> = {}): SyncedNote {
  return { text: 'desktop', rating: 4, saved_at: '2026-07-01T08:00:00.000Z', ...overrides }
}

describe('resolveNote', () => {
  it('returns null when both are null', () => {
    expect(resolveNote(null, null)).toBeNull()
  })

  it('returns local when synced is null', () => {
    const local = mkLocal()
    expect(resolveNote(local, null)).toEqual(local)
  })

  it('returns synced (as ActivityNote shape) when local is null', () => {
    const synced = mkSynced()
    const result = resolveNote(null, synced)
    expect(result).not.toBeNull()
    expect(result!.text).toBe('desktop')
    expect(result!.rating).toBe(4)
    expect(result!.savedAt).toBe(synced.saved_at)
  })

  it('local wins when its savedAt is newer than synced.saved_at', () => {
    const local = mkLocal({ savedAt: '2026-07-02T12:00:00.000Z' })
    const synced = mkSynced({ saved_at: '2026-07-01T08:00:00.000Z' })
    expect(resolveNote(local, synced)).toEqual(local)
  })

  it('synced wins when its saved_at is newer than local savedAt', () => {
    const local = mkLocal({ savedAt: '2026-07-01T08:00:00.000Z' })
    const synced = mkSynced({ saved_at: '2026-07-02T12:00:00.000Z' })
    const result = resolveNote(local, synced)
    expect(result!.text).toBe('desktop')
    expect(result!.rating).toBe(4)
  })

  it('local wins on tie (same timestamp)', () => {
    const ts = '2026-07-01T10:00:00.000Z'
    const local = mkLocal({ savedAt: ts })
    const synced = mkSynced({ saved_at: ts })
    expect(resolveNote(local, synced)).toEqual(local)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// resolvePendingNoteMutation — 'applied' | 'pending'
// Contract: applied iff NOT in queue AND plan.notes[id] reflects the state.
// Save: same text+rating. Delete: key absent. Safe-default = 'pending'.
// ─────────────────────────────────────────────────────────────────────────────

function mkSyncInfo(overrides: Partial<NotesSyncInfo> = {}): NotesSyncInfo {
  return { noteMutations: [], notes: {}, ...overrides }
}

describe('resolvePendingNoteMutation', () => {
  it('returns pending when mutation is still in queue (save)', () => {
    const m = buildSaveNoteMutation(1, 'x', 3)
    const sync = mkSyncInfo({ noteMutations: [m] })
    expect(resolvePendingNoteMutation(m, sync)).toBe('pending')
  })

  it('returns pending when mutation is still in queue (delete)', () => {
    const m = buildDeleteNoteMutation(1)
    const sync = mkSyncInfo({ noteMutations: [m] })
    expect(resolvePendingNoteMutation(m, sync)).toBe('pending')
  })

  it('returns pending when queue empty but save not yet in plan.notes', () => {
    const m = buildSaveNoteMutation(1, 'x', 3)
    const sync = mkSyncInfo({ noteMutations: [], notes: {} })
    expect(resolvePendingNoteMutation(m, sync)).toBe('pending')
  })

  it('returns applied when queue empty and save text+rating matches plan.notes', () => {
    const m = buildSaveNoteMutation(42, 'Guter Lauf', 4)
    const sync = mkSyncInfo({
      noteMutations: [],
      notes: { '42': { text: 'Guter Lauf', rating: 4, saved_at: '2026-07-04T10:00:00Z' } },
    })
    expect(resolvePendingNoteMutation(m, sync)).toBe('applied')
  })

  it('returns pending when queue empty but text mismatch in plan.notes', () => {
    const m = buildSaveNoteMutation(42, 'Guter Lauf', 4)
    const sync = mkSyncInfo({
      noteMutations: [],
      notes: { '42': { text: 'Anderer Text', rating: 4, saved_at: '2026-07-04T10:00:00Z' } },
    })
    expect(resolvePendingNoteMutation(m, sync)).toBe('pending')
  })

  it('delete: returns applied when queue empty and key absent from plan.notes', () => {
    const m = buildDeleteNoteMutation(7)
    const sync = mkSyncInfo({ noteMutations: [], notes: {} })
    expect(resolvePendingNoteMutation(m, sync)).toBe('applied')
  })

  it('delete: returns pending when key still present in plan.notes', () => {
    const m = buildDeleteNoteMutation(7)
    const sync = mkSyncInfo({
      noteMutations: [],
      notes: { '7': { text: 'noch da', rating: 2, saved_at: '2026-07-01T00:00:00Z' } },
    })
    expect(resolvePendingNoteMutation(m, sync)).toBe('pending')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Enqueue rebuildFn — 409-Szenario (pure function, no network)
// Verifies that the buildPayload closure used in RunDetail correctly dedupes.
// ─────────────────────────────────────────────────────────────────────────────

describe('enqueue rebuildFn — 409-scenario', () => {
  beforeEach(() => { localStorage.clear() })

  it('appends only new pending mutations to fresh queue (dedupe by ts)', () => {
    const mOld: NoteMutation = { type: 'save', activity_id: 1, text: 'old', rating: 3, ts: '2026-07-04T10:00:00.010Z' }
    const mNew: NoteMutation = { type: 'save', activity_id: 2, text: 'new', rating: 4, ts: '2026-07-04T10:00:00.011Z' }
    appendPendingNoteMutation(mOld)
    appendPendingNoteMutation(mNew)
    const allPending = loadPendingNoteMutations()

    // fresh queue already has mOld (e.g. pushed before conflict)
    const freshNoteMutations: NoteMutation[] = [mOld]

    const buildPayload = (base: { noteMutations?: NoteMutation[] }) => {
      const existingTs = new Set((base.noteMutations ?? []).map((m: NoteMutation) => m.ts))
      const toAdd = allPending.filter((m: NoteMutation) => !existingTs.has(m.ts))
      return { ...base, noteMutations: [...(base.noteMutations ?? []), ...toAdd] }
    }

    const result = buildPayload({ noteMutations: freshNoteMutations })
    // mOld was already in fresh queue, mNew is new → total 2, no duplicate
    expect(result.noteMutations).toHaveLength(2)
    expect(result.noteMutations!.filter((m: NoteMutation) => m.ts === mOld.ts)).toHaveLength(1)
    expect(result.noteMutations!.filter((m: NoteMutation) => m.ts === mNew.ts)).toHaveLength(1)
  })

  it('preserves foreign fields in base when applying buildPayload', () => {
    const m = buildSaveNoteMutation(5, 'test', 2)
    appendPendingNoteMutation(m)
    const allPending = loadPendingNoteMutations()

    const buildPayload = (base: { noteMutations?: NoteMutation[]; settings?: { vdot: number } }) => {
      const existingTs = new Set((base.noteMutations ?? []).map((m: NoteMutation) => m.ts))
      const toAdd = allPending.filter((m: NoteMutation) => !existingTs.has(m.ts))
      return { ...base, noteMutations: [...(base.noteMutations ?? []), ...toAdd] }
    }

    const result = buildPayload({ settings: { vdot: 48 }, noteMutations: [] })
    expect(result.settings).toEqual({ vdot: 48 })
    expect(result.noteMutations).toHaveLength(1)
  })
})
