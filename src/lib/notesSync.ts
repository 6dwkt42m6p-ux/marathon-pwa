// T-156: PWA note-sync helpers — pure functions (no network), testable in Vitest.
// Notes flow: PWA enqueues noteMutations in sync.json → Desktop SSoT applies to notes.json
// + exports plan.notes back → PWA resolves display via resolveNote.

import type { ActivityNote } from './storage'
import { safeSetItem } from './storage'

// Note mutation payload sent to Desktop via sync.json top-level noteMutations queue.
// activity_id is number in PWA — Desktop normalises to str(activity_id) for notes.json keys.
// ts is the unique Mutation-ID used for dedupe and selective queue-pop.
export interface NoteMutation {
  type: 'save' | 'delete'
  activity_id: number
  text?: string    // only for save
  rating?: number  // only for save
  ts: string       // ISO timestamp — dedupe key
}

// Synced note shape from Desktop plan.notes (exported by export_notes_for_sync, snake_case).
export interface SyncedNote {
  text: string
  rating: number
  saved_at: string  // ISO timestamp (snake_case from Desktop)
}

// Minimal sync-state surface for the resolver — avoids circular import with githubSync.ts.
export interface NotesSyncInfo {
  noteMutations?: NoteMutation[]
  notes?: Record<string, SyncedNote>  // plan.notes[id] keyed by string activity id
}

// ─── Mutation builders ───────────────────────────────────────────────────────

export function buildSaveNoteMutation(
  activityId: number,
  text: string,
  rating: number,
): NoteMutation {
  return { type: 'save', activity_id: activityId, text, rating, ts: new Date().toISOString() }
}

export function buildDeleteNoteMutation(activityId: number): NoteMutation {
  return { type: 'delete', activity_id: activityId, ts: new Date().toISOString() }
}

// ─── Pending-list (localStorage, key pending_note_mutations — LIST not single slot) ───

const PENDING_KEY = 'pending_note_mutations'

export function loadPendingNoteMutations(): NoteMutation[] {
  try {
    const raw = localStorage.getItem(PENDING_KEY)
    return raw ? (JSON.parse(raw) as NoteMutation[]) : []
  } catch {
    return []
  }
}

// T-170: return value MUST be consumed by the caller (RunDetail.tsx enqueueMutationAndPush) —
// a `false` means the mutation did NOT make it into the persisted queue. The caller must not
// treat it as queued (it would silently vanish if the immediate best-effort push also fails).
export function appendPendingNoteMutation(m: NoteMutation): boolean {
  const existing = loadPendingNoteMutations()
  // ts is the dedupe key — never add the same mutation twice
  if (existing.some(e => e.ts === m.ts)) return true
  return safeSetItem(PENDING_KEY, JSON.stringify([...existing, m]))
}

// T-170: `false` means the (now-shorter) queue could not be persisted — the applied mutations
// stay in the list and will be considered again on the next flush. Not a data-loss path (unlike
// append), but still must not throw or silently claim success.
export function removePendingNoteMutations(tsList: string[]): boolean {
  const tsSet = new Set(tsList)
  const remaining = loadPendingNoteMutations().filter(m => !tsSet.has(m.ts))
  if (remaining.length === 0) {
    try { localStorage.removeItem(PENDING_KEY); return true }
    catch { return false /* iOS private mode */ }
  }
  return safeSetItem(PENDING_KEY, JSON.stringify(remaining))
}

// ─── resolveNote ─────────────────────────────────────────────────────────────

// Merge local pending note (localStorage note_{id}) with synced Desktop note (plan.notes[id]).
// Contract: local wins if its savedAt is newer than or equal to synced.saved_at; otherwise synced.
// Returns null only when both inputs are null (no note anywhere).
export function resolveNote(
  local: ActivityNote | null,
  synced: SyncedNote | null,
): ActivityNote | null {
  if (!local && !synced) return null
  if (!synced) return local
  if (!local) return { text: synced.text, rating: synced.rating, savedAt: synced.saved_at }
  // local wins when its savedAt >= synced.saved_at
  if (new Date(local.savedAt).getTime() >= new Date(synced.saved_at).getTime()) {
    return local
  }
  return { text: synced.text, rating: synced.rating, savedAt: synced.saved_at }
}

// ─── resolvePendingNoteMutation ───────────────────────────────────────────────

// Determine whether a pending mutation has been applied by Desktop.
// 'applied'  — mutation not in noteMutations queue AND plan.notes[id] reflects the state
//              (save: same text+rating present; delete: key absent).
//              No 'discarded' path: Desktop never refuses note-saves (unlike injury starts).
// 'pending'  — still waiting (safe default when evidence is incomplete).
export function resolvePendingNoteMutation(
  pending: NoteMutation,
  sync: NotesSyncInfo,
): 'applied' | 'pending' {
  // Still in queue → definitely not processed yet
  if ((sync.noteMutations ?? []).some(m => m.ts === pending.ts)) return 'pending'

  const notes = sync.notes ?? {}
  const key = String(pending.activity_id)

  if (pending.type === 'save') {
    const synced = notes[key]
    if (!synced) return 'pending'
    // text and rating must match what we sent
    if (synced.text === (pending.text ?? '') && synced.rating === (pending.rating ?? 0)) {
      return 'applied'
    }
    return 'pending'
  }

  // delete: applied iff key is absent from plan.notes
  return key in notes ? 'pending' : 'applied'
}
