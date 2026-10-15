// Inhalt: Schreibende sync.json-Aktionen der PWA (T-282) — einzige Stelle für pushSync-Aufrufe.
// Muster je Aktion: fetchSync(force) → buildPayload(fresh) → pushSync mit buildPayload als
//   409-Rebuild (T-151) → Pending-Marker setzen/löschen erst nach Erfolg.
// Einstieg: pushNoteMutations (RunDetail), pushInjuryMutation (Settings), pushWeekOverride
//   (TodayWorkout), pushSettings (Settings), pushPlanRecomputeRequest + buildSettingsPushPayload
//   (TodayWorkout); flushPendingNoteMutations (App-Start + Settings-Sync),
//   flushPendingWeekOverrides (nur App-Start).
// Fehler: push*/pushPlan* reichen jeden Fehler (inkl. SyncAccessError) an den Aufrufer durch —
//   der entscheidet still vs. UI-Meldung. flush* sind best-effort und rejecten nie.
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

// T-156/T-170/T-260 P-04: queue first (synchronous, before any await); a failed queue write must
// not drop the mutation from this push. Marked pushed only when a remote state was fetched.
export async function pushNoteMutations(mutation: NoteMutation): Promise<void> {
  const queued = appendPendingNoteMutation(mutation)
  const fresh = await fetchSync(true)
  const allPending = queued ? loadPendingNoteMutations() : [...loadPendingNoteMutations(), mutation]
  const buildPayload = (base: SyncData): SyncData =>
    ({ ...base, noteMutations: mergeNoteMutationQueue(base.noteMutations, allPending) })
  await pushSync(buildPayload(fresh?.data ?? {}), fresh?.sha, buildPayload)
  if (fresh) markNoteMutationsPushed(allPending.map(m => m.ts))
}

// T-156/T-260 P-04: reconcile against already-fetched data and re-push the rest once (no fetch).
// Everything inside try: callers fire-and-forget (`void`), so corrupt input must not reject.
export async function flushPendingNoteMutations(data: SyncData, sha: string): Promise<void> {
  try {
    const remaining = reconcilePendingNoteMutations({ noteMutations: data.noteMutations, notes: data.plan?.notes })
    if (remaining.length === 0) return
    const buildPayload = (base: SyncData): SyncData =>
      ({ ...base, noteMutations: mergeNoteMutationQueue(base.noteMutations, remaining) })
    await pushSync(buildPayload(data), sha, buildPayload)
    markNoteMutationsPushed(remaining.map(m => m.ts))
  } catch { /* best-effort — stays pending */ }
}

// T-132/T-152: optimistic overlay marker only after a successful push.
export async function pushInjuryMutation(mutation: InjuryBreakMutation): Promise<void> {
  const fresh = await fetchSync(true)
  const buildPayload = (base: SyncData): SyncData => ({
    ...base,
    injuryBreakMutations: [...(base.injuryBreakMutations ?? []), mutation],
  })
  await pushSync(buildPayload(fresh?.data ?? {}), fresh?.sha, buildPayload)
  savePendingMutation(mutation)
}

// T-217/T-260 P-06: marker set by the caller at edit time; cleared here on success via stamp
// (clear-if-equal), so a late push cannot clear the marker of a newer edit.
export async function pushWeekOverride(weekKey: string, map: Record<string, string>, stamp: string): Promise<void> {
  if (!hasToken()) return
  const current = await fetchSync(true)
  const buildPayload = (base: SyncData): SyncData => ({
    ...base,
    weekOverrides: { ...(base.weekOverrides ?? {}), [weekKey]: map },
  })
  await pushSync(buildPayload(current?.data ?? {}), current?.sha, buildPayload)
  clearWeekOverridePending(weekKey, stamp)
}

// T-260 P-06: re-push local swaps whose push never succeeded, against already-fetched data.
// Everything inside try: same never-reject contract as flushPendingNoteMutations.
export async function flushPendingWeekOverrides(data: SyncData, sha: string): Promise<void> {
  try {
    const pending = pendingWeekOverrideMaps()
    const weeks = Object.keys(pending)
    if (weeks.length === 0) return
    const buildPayload = (base: SyncData): SyncData => {
      const wo = { ...(base.weekOverrides ?? {}) }
      for (const w of weeks) wo[w] = pending[w].map
      return { ...base, weekOverrides: wo }
    }
    await pushSync(buildPayload(data), sha, buildPayload)
    for (const w of weeks) clearWeekOverridePending(w, pending[w].stamp)
  } catch { /* best-effort — stays pending */ }
}

// T-182 Phase B: settings are merged (mergeSettingsForPush), never replaced.
export async function pushSettings(local: AppSettings): Promise<void> {
  const current = await fetchSync(true)
  const buildPayload = (base: SyncData): SyncData => ({
    ...base,
    settings: mergeSettingsForPush(local, base.settings),
  })
  await pushSync(buildPayload(current?.data ?? {}), current?.sha, buildPayload)
}

// T-221: only the flag (Desktop reads nothing else here) — settings are pushed by pushSettings.
// Immediate payload builder AND 409-rebuildFn.
export function buildSettingsPushPayload(base: SyncData): SyncData {
  return { ...base, planRecomputeRequested: true }
}

// T-024: unlike the other paths, no push when no remote state exists (fresh === null).
export async function pushPlanRecomputeRequest(): Promise<void> {
  if (!hasToken()) return
  const fresh = await fetchSync(true)
  if (!fresh) return
  await pushSync(buildSettingsPushPayload(fresh.data), fresh.sha, buildSettingsPushPayload)
}
