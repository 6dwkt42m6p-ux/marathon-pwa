// T-132: PWA-Eingabe + Write-back für Verletzungspausen (Desktop-SSoT injury.py, T-131).
// Reine Funktionen (Datum-Logik + Mutation-Builder + Optimistic-Overlay), keine Netzwerk-Calls.

export type InjurySeverity = 'minor' | 'moderate' | 'major'

export interface RawInjuryBreak {
  id: string
  start: string
  est_days: number
  severity: InjurySeverity
  end: string | null
  note: string
  created_at: string
}

export interface StartMutation {
  type: 'start'
  ts: string
  start: string
  est_days: number
  severity: InjurySeverity
  note: string
}

export interface EndMutation {
  type: 'end'
  ts: string
  break_id: string
  end: string
}

export type InjuryBreakMutation = StartMutation | EndMutation

function addDays(d: Date, n: number): Date {
  const r = new Date(d)
  r.setDate(r.getDate() + n)
  return r
}

export function effectiveWindow(b: RawInjuryBreak): { start: Date; end: Date } {
  const start = new Date(b.start + 'T00:00:00')
  if (b.end) return { start, end: new Date(b.end + 'T00:00:00') }
  return { start, end: addDays(start, b.est_days) }
}

export function activeInjuryBreak(breaks: RawInjuryBreak[], today: Date): RawInjuryBreak | null {
  // today kommt in Settings.tsx als `new Date()` mit realer Uhrzeit, effectiveWindow()-Grenzen
  // sind aber immer lokale Mitternacht -> ohne Normalisierung faellt der letzte Kalendertag
  // eines offenen Breaks ab 00:00:01 Uhr faelschlich aus dem Fenster (T-132 Review-Fix).
  const t = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  for (const b of breaks) {
    if (b.end) continue
    const { start, end } = effectiveWindow(b)
    if (start <= t && t <= end) return b
  }
  return null
}

export function buildStartMutation(
  start: string, estDays: number, severity: InjurySeverity, note: string,
): StartMutation {
  return { type: 'start', ts: new Date().toISOString(), start, est_days: estDays, severity, note }
}

export function buildEndMutation(breakId: string, end: string): EndMutation {
  return { type: 'end', ts: new Date().toISOString(), break_id: breakId, end }
}

const PENDING_KEY = 'injury_pending_mutation'

export function loadPendingMutation(): InjuryBreakMutation | null {
  try {
    const raw = localStorage.getItem(PENDING_KEY)
    return raw ? (JSON.parse(raw) as InjuryBreakMutation) : null
  } catch {
    return null
  }
}

export function savePendingMutation(m: InjuryBreakMutation): void {
  try { localStorage.setItem(PENDING_KEY, JSON.stringify(m)) } catch { /* iOS private mode */ }
}

export function clearPendingMutation(): void {
  try { localStorage.removeItem(PENDING_KEY) } catch { /* iOS private mode */ }
}

export function isPendingMutationApplied(pending: InjuryBreakMutation, breaks: RawInjuryBreak[]): boolean {
  if (pending.type === 'start') {
    return breaks.some(b => b.start === pending.start && b.end === null)
  }
  return breaks.some(b => b.id === pending.break_id && b.end === pending.end)
}

// T-152: Minimal sync-state surface for resolver — subset of SyncData to avoid circular import.
export interface SyncInfo {
  injuryBreakMutations?: InjuryBreakMutation[]
  lastModified?: string
  lastDevice?: string
}

// T-152: Determine fate of a pending mutation against fresh sync data.
// 'applied'   — mutation effect is visible in breaks (normal success).
// 'discarded' — Desktop processed the queue AND removed our mutation WITHOUT applying it
//               (Guard 1: break already existed; Guard 2 T-150: same-start break existed).
//               Evidence required: mutation not in queue AND lastDevice='streamlit' AND
//               lastModified newer than pending.ts. Without evidence stays 'pending' to
//               avoid false-discarding directly after enqueue (queue still contains it)
//               or after a PWA-only push (lastDevice='pwa').
// 'pending'   — still waiting.
export function resolvePendingMutation(
  pending: InjuryBreakMutation,
  breaks: RawInjuryBreak[],
  sync: SyncInfo,
): 'applied' | 'discarded' | 'pending' {
  if (isPendingMutationApplied(pending, breaks)) return 'applied'

  const stillInQueue = (sync.injuryBreakMutations ?? []).some(m => m.ts === pending.ts)
  if (!stillInQueue && sync.lastDevice === 'streamlit' && sync.lastModified) {
    const desktopTime = new Date(sync.lastModified).getTime()
    const pendingTime = new Date(pending.ts).getTime()
    if (desktopTime > pendingTime) return 'discarded'
  }

  return 'pending'
}
