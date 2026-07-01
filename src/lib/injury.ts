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
  for (const b of breaks) {
    if (b.end) continue
    const { start, end } = effectiveWindow(b)
    if (start <= today && today <= end) return b
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
