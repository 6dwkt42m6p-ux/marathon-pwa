// Inhalt: Schreibende sync.json-Aktionen der PWA (T-282) — einzige Stelle für pushSync-Aufrufe.
// Muster (T-297): jede Aktion ist nur ihr Builder; fetchAndPush übernimmt Token-Policy,
//   fetchSync(force) bzw. übergebene data/sha, pushSync mit Builder als 409-Rebuild (T-151).
//   Pending-Marker setzen/löschen erst nach Erfolg (Rückgabe true).
// Einstieg: pushNoteMutations (RunDetail), pushInjuryMutation (Settings), pushWeekOverride
//   (TodayWorkout), pushSettings (Settings), pushPlanRecomputeRequest + buildSettingsPushPayload
//   (TodayWorkout); flushPendingSync (App-Start + Settings-Sync, Notizen + Wochen-Tausche in EINEM
//   Push, D-070).
// Token-Policy (T-297): ohne Token kein Netz, kein Marker/Overlay; push* liefern dann false.
// Fehler: push*/pushPlan* reichen jeden Fehler (inkl. SyncAccessError) an den Aufrufer durch —
//   der entscheidet still vs. UI-Meldung. flushPendingSync ist best-effort und rejectet nie.
// Regeln: lib-only (keine Komponenten); Desktop bleibt SSoT, Queues sind PWA→Desktop.

import { fetchSync, pushSync, hasToken, type SyncData } from './githubSync'
import {
  appendPendingNoteMutation, loadPendingNoteMutations, mergeNoteMutationQueue,
  markNoteMutationsPushed, reconcilePendingNoteMutations, type NoteMutation,
} from './notesSync'
import { savePendingMutation, type InjuryBreakMutation } from './injury'
import {
  mergeSettingsForPush, pendingWeekOverrideMaps, clearWeekOverridePending, type AppSettings,
} from './storage'

type Builder = (base: SyncData) => SyncData

interface PushOpts {
  /** Bereits geladener Remote-Stand → kein eigener Fetch (App-Start/Settings-Sync). */
  base?: { data: SyncData; sha: string }
  /** true: ohne Remote-Datei (fresh === null) nicht pushen (T-024 Recompute-Flag). */
  requireRemote?: boolean
}

interface PushOutcome { sent: boolean; hadRemote: boolean }

// T-297: the single fetch → build → push path. Token checked once here (pushSync's own check
// stays as githubSync-internal safety net, D-070 non-goal). `hadRemote` = pushed onto a fetched file.
async function fetchAndPush(build: Builder, opts: PushOpts = {}): Promise<PushOutcome> {
  if (!hasToken()) return { sent: false, hadRemote: false }
  const remote = opts.base ?? await fetchSync(true)
  if (!remote && opts.requireRemote) return { sent: false, hadRemote: false }
  await pushSync(build(remote?.data ?? {}), remote?.sha, build)
  return { sent: true, hadRemote: !!remote }
}

// T-156/T-170/T-260 P-04: queue first (synchronous, before any await) — also without token, so the
// next flush carries it; a failed queue write must not drop the mutation from this push.
// Marked pushed only when a remote state was fetched.
export async function pushNoteMutations(mutation: NoteMutation): Promise<boolean> {
  const queued = appendPendingNoteMutation(mutation)
  // Read once after the fetch (first build) and reused by the 409 rebuild — as before T-297.
  const sent: { list?: NoteMutation[] } = {}
  const r = await fetchAndPush(base => {
    sent.list ??= queued ? loadPendingNoteMutations() : [...loadPendingNoteMutations(), mutation]
    return { ...base, noteMutations: mergeNoteMutationQueue(base.noteMutations, sent.list) }
  })
  if (r.hadRemote && sent.list) markNoteMutationsPushed(sent.list.map(m => m.ts))
  return r.sent
}

// T-132/T-152: optimistic overlay marker only after a successful push.
export async function pushInjuryMutation(mutation: InjuryBreakMutation): Promise<boolean> {
  const r = await fetchAndPush(base => ({
    ...base,
    injuryBreakMutations: [...(base.injuryBreakMutations ?? []), mutation],
  }))
  if (r.sent) savePendingMutation(mutation)
  return r.sent
}

// T-217/T-260 P-06: marker set by the caller at edit time; cleared here on success via stamp
// (clear-if-equal), so a late push cannot clear the marker of a newer edit.
export async function pushWeekOverride(weekKey: string, map: Record<string, string>, stamp: string): Promise<boolean> {
  const r = await fetchAndPush(base => ({
    ...base,
    weekOverrides: { ...(base.weekOverrides ?? {}), [weekKey]: map },
  }))
  if (r.sent) clearWeekOverridePending(weekKey, stamp)
  return r.sent
}

// T-182 Phase B: settings are merged (mergeSettingsForPush), never replaced.
export async function pushSettings(local: AppSettings): Promise<boolean> {
  const r = await fetchAndPush(base => ({ ...base, settings: mergeSettingsForPush(local, base.settings) }))
  return r.sent
}

// T-221: only the flag (Desktop reads nothing else here) — settings are pushed by pushSettings.
// Immediate payload builder AND 409-rebuildFn.
export function buildSettingsPushPayload(base: SyncData): SyncData {
  return { ...base, planRecomputeRequested: true }
}

// T-024: unlike the other paths, no push when no remote state exists (fresh === null).
export async function pushPlanRecomputeRequest(): Promise<boolean> {
  const r = await fetchAndPush(buildSettingsPushPayload, { requireRemote: true })
  return r.sent
}

// T-156/T-260 P-04/P-06, T-297/D-070: re-push pending note mutations AND pending week swaps against
// already-fetched data in ONE push (two parallel PUTs on the same sha → guaranteed 409).
// Each part is read in its own try so corrupt input of one does not block the other; the whole
// body is inside try because callers fire-and-forget (`void`) — never rejects.
export async function flushPendingSync(data: SyncData, sha: string): Promise<void> {
  try {
    let notes: NoteMutation[] = []
    try {
      notes = reconcilePendingNoteMutations({ noteMutations: data.noteMutations, notes: data.plan?.notes })
    } catch { /* corrupt queue/remote — notes stay pending */ }
    let weeks: ReturnType<typeof pendingWeekOverrideMaps> = {}
    try { weeks = pendingWeekOverrideMaps() } catch { /* storage unreadable */ }
    const weekKeys = Object.keys(weeks)
    if (notes.length === 0 && weekKeys.length === 0) return
    const build: Builder = base => {
      const out: SyncData = { ...base }
      if (notes.length) out.noteMutations = mergeNoteMutationQueue(base.noteMutations, notes)
      if (weekKeys.length) {
        const wo = { ...(base.weekOverrides ?? {}) }
        for (const w of weekKeys) wo[w] = weeks[w].map
        out.weekOverrides = wo
      }
      return out
    }
    const r = await fetchAndPush(build, { base: { data, sha } })
    if (!r.sent) return
    if (notes.length) markNoteMutationsPushed(notes.map(m => m.ts))
    for (const w of weekKeys) clearWeekOverridePending(w, weeks[w].stamp)
  } catch { /* best-effort — stays pending */ }
}
