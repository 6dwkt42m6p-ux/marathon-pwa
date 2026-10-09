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
  // T-260: lokal-only — true sobald die Mutation nachweislich in der Remote-Queue lag (Push ok
  // oder im Fetch gesehen). Nur dann darf "nicht mehr in der Queue" als "Desktop hat sie
  // konsumiert" gelten. Wird vor jedem Push entfernt (mergeNoteMutationQueue).
  pushed?: boolean
}

// Synced note shape from Desktop plan.notes (exported by export_notes_for_sync, snake_case).
export interface SyncedNote {
  text: string
  rating: number
  saved_at: string  // ISO timestamp (snake_case from Desktop)
}

// Minimal sync-state surface for the resolver — avoids circular import with githubSync.ts.
export interface NotesSyncInfo {
  noteMutations?: NoteMutation[] | null
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
// T-260 P-04: a newer mutation for the same activity supersedes all older ones — an older one
// left in the queue would be re-pushed after the newer one was applied and restore the old note.
export function appendPendingNoteMutation(m: NoteMutation): boolean {
  const existing = loadPendingNoteMutations()
  // ts is the dedupe key — never add the same mutation twice
  if (existing.some(e => e.ts === m.ts)) return true
  return safeSetItem(PENDING_KEY, JSON.stringify(compactNoteMutations([...existing, m])))
}

const tsMs = (ts: string): number => {
  const t = new Date(ts).getTime()
  return Number.isNaN(t) ? 0 : t
}

// T-260 P-04: keep only the newest mutation (by ts) per activity_id, sorted by ts. Desktop applies
// the queue in list order as overwrite — with at most one entry per id, order cannot matter.
export function compactNoteMutations(list: NoteMutation[]): NoteMutation[] {
  const latest = new Map<string, NoteMutation>()
  for (const m of list) {
    const k = String(m.activity_id)
    const cur = latest.get(k)
    if (!cur || tsMs(m.ts) >= tsMs(cur.ts)) latest.set(k, m)
  }
  return [...latest.values()].sort((a, b) => tsMs(a.ts) - tsMs(b.ts))
}

// T-260 P-04: remote queue + local pending → payload queue (deduped by ts, compacted per id,
// local-only `pushed` stripped). Used by every push path (RunDetail, App start, Settings sync).
export function mergeNoteMutationQueue(
  remote: NoteMutation[] | null | undefined,
  local: NoteMutation[],
): NoteMutation[] {
  const seen = new Set<string>()
  const all: NoteMutation[] = []
  for (const m of [...(remote ?? []), ...local]) {
    if (seen.has(m.ts)) continue
    seen.add(m.ts)
    const out: NoteMutation = { ...m }
    delete out.pushed
    all.push(out)
  }
  return compactNoteMutations(all)
}

export function markNoteMutationsPushed(tsList: string[]): boolean {
  if (tsList.length === 0) return true
  const tsSet = new Set(tsList)
  const list = loadPendingNoteMutations()
  if (!list.some(m => tsSet.has(m.ts) && !m.pushed)) return true
  return safeSetItem(PENDING_KEY, JSON.stringify(list.map(m => (tsSet.has(m.ts) ? { ...m, pushed: true } : m))))
}

// T-260 P-04: reconcile the local queue against a freshly fetched sync state:
// compact (legacy lists may still hold superseded entries), mark entries seen in the remote queue
// as pushed, drop applied ones. Returns what still has to be (re-)pushed.
export function reconcilePendingNoteMutations(sync: NotesSyncInfo): NoteMutation[] {
  const remoteTs = new Set((sync.noteMutations ?? []).map(m => m.ts))
  const remaining = compactNoteMutations(loadPendingNoteMutations())
    .map(m => (remoteTs.has(m.ts) && !m.pushed ? { ...m, pushed: true } : m))
    .filter(m => resolvePendingNoteMutation(m, sync) !== 'applied')
  if (remaining.length === 0) {
    try { localStorage.removeItem(PENDING_KEY) } catch { /* iOS private mode */ }
  } else {
    safeSetItem(PENDING_KEY, JSON.stringify(remaining))
  }
  return remaining
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

// Desktop normalisation: notes.save_note stores text.strip(), export_notes_for_sync cuts [:500]
// (Python counts code points → Array.from, not UTF-16 slice), rating int() + clamp [1,5].
// The synced text IS already Desktop-normalised — compared raw (re-trimming it would break a
// space at position 500, Review S3).
const DESKTOP_NOTE_TEXT_MAX = 500
const desktopText = (t: string | undefined): string =>
  Array.from((t ?? '').trim()).slice(0, DESKTOP_NOTE_TEXT_MAX).join('')
const normRating = (r: number | undefined | null): number => {
  const n = Math.trunc(Number(r ?? 0))
  return Number.isFinite(n) ? Math.max(1, Math.min(5, n)) : 1
}

// Determine whether a pending mutation has been applied by Desktop.
// 'pending'  — in the remote queue, OR an OLDER mutation for the same activity is still queued
//              (Desktop will apply it later, so the current note state says nothing about ours —
//              Fix-Loop 1 Bug 1: offline delete behind a queued save).
// 'applied'  — a NEWER mutation for the same activity is queued (ours is superseded), or not
//              queued AND either
//              (1) plan.notes[id] reflects it after Desktop normalisation (save: text+rating,
//                  delete: key absent), or
//              (2) T-260: it was demonstrably pushed (m.pushed), left the queue, and Desktop's
//                  state moved on since: note written at/after m.ts (later Desktop edit) or note
//                  gone (later Desktop delete, Fix-Loop 1 Bug 2). Desktop pops only processed ts
//                  (T-149) and the PWA always merges the remote queue, so "pushed ∧ gone from
//                  queue" means consumed.
//              No 'discarded' path: Desktop never refuses note-saves (unlike injury starts).
// An UNPUSHED mutation is never inferred as applied from saved_at/absence — Desktop's saved_at is
// its APPLY time and may stem from an older, superseded mutation (offline scenario c).
export function resolvePendingNoteMutation(
  pending: NoteMutation,
  sync: NotesSyncInfo,
): 'applied' | 'pending' {
  const queue = sync.noteMutations ?? []
  if (queue.some(m => m.ts === pending.ts)) return 'pending'

  const key = String(pending.activity_id)
  const sameActivity = queue.filter(m => String(m.activity_id) === key)
  // Known, accepted limit: ts comes from each device's clock — with clock skew between two devices
  // a really-later but unpushed local edit can count as superseded. Same ts-based last-write-wins
  // as compactNoteMutations; window = skew (NTP: seconds), needs two devices editing the same note.
  if (sameActivity.some(m => tsMs(m.ts) > tsMs(pending.ts))) return 'applied'
  if (sameActivity.length > 0) return 'pending'

  const notes = sync.notes ?? {}
  const synced = key in notes ? notes[key] : undefined

  if (pending.type === 'save') {
    if (!synced) return pending.pushed ? 'applied' : 'pending'
    if (synced.text === desktopText(pending.text) &&
        normRating(synced.rating) === normRating(pending.rating)) {
      return 'applied'
    }
  } else if (!synced) {
    return 'applied'  // delete: key absent
  }

  if (pending.pushed && tsMs(synced.saved_at) >= tsMs(pending.ts)) return 'applied'
  return 'pending'
}
