// Inhalt: Reine Helfer des Analyse-Tabs (aus Analysis.tsx verschoben, T-275 AC2).
// Einstieg: isoWeek (KW-Label fuer Wochen-Charts), syncedSessionToWorkout (SyncedPlanSession -> WorkoutSession).
// Regeln: pure Funktionen, kein State/DOM; importiert nur Typen aus lib/plan und lib/githubSync.

import type { WorkoutSession } from '../../lib/plan'
import type { SyncedPlanSession } from '../../lib/githubSync'

export function isoWeek(d: Date): string {
  // Use Date.UTC to avoid DST distortion: all operands are treated as UTC midnight,
  // so the 7-day divisor is always exact (no ±1h DST shift).
  const jan4   = new Date(d.getFullYear(), 0, 4)
  const startDay = jan4.getDate() - ((jan4.getDay() + 6) % 7)
  const startUTC = Date.UTC(jan4.getFullYear(), 0, startDay)
  const dUTC     = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())
  const week     = Math.floor((dUTC - startUTC) / (7 * 24 * 3600 * 1000)) + 1
  return `KW${week}`
}


// Convert SyncedPlanSession to the WorkoutSession shape expected by assessDeviation
export function syncedSessionToWorkout(s: SyncedPlanSession): WorkoutSession {
  return {
    session:   s.typ,
    typ:       s.typ,
    distanzKm: s.km ?? 0,
    vorgabe:   s.vorgabe,
    struktur:  s.struktur,
    dauerMin:  s.dauer,
    hinweis:   s.hinweis,
    wochentag: s.tag,
    // T-247: ohne Durchreichen bliebe struktur_daten (T-246) am RunDetail-Konsumenten immer
    // undefined — matchBlocksToPlan waere dadurch in der echten App unerreichbar, obwohl der
    // Desktop-Sync es schon serialisiert (T-247-Reviewer-Hinweis in SyncedPlanSession).
    struktur_daten: s.struktur_daten ?? null,
  }
}
