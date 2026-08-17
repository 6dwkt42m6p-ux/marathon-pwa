// SSoT for the training plan is sync.json (Desktop build_plan_payload, T-024/T-078).
// T-169: the local Pfitzinger-fork generator (generatePlan) was removed — it had
// drifted badly from the Desktop periodization (missing T-055/T-066/T-087/T-102/T-131)
// and produced invalid plans (no taper, inverted periodization). No local fallback
// planner is kept; consumers show an explicit empty state instead.
import { mondayOf, localISODate, DAY_TAGS, type ActivitySummary, type WorkoutClassification } from './strava'
import type { SyncedPlan, SyncedPlanWeek, SyncedPlanSession } from './githubSync'

// Re-export synced plan types for convenience in components
export type { SyncedPlan, SyncedPlanWeek, SyncedPlanSession }

// Return the current week from a synced plan — matched by today's Monday date,
// not by the is_current flag (which is baked in at generation time and goes stale).
// Falls back to is_current only when no week_start matches today's Monday.
export function syncedCurrentWeek(plan: SyncedPlan): SyncedPlanWeek | null {
  const todayMonday = localISODate(mondayOf(new Date()))
  const byDate = plan.weeks.find(w => w.week_start === todayMonday)
  if (byDate) return byDate
  return plan.weeks.find(w => w.is_current) ?? null
}

// Return the synced plan week whose week_start matches the Monday of the given date.
// Returns null if the date falls outside all synced weeks (no match = no plan for that week).
export function syncedWeekForDate(plan: SyncedPlan, date: Date): SyncedPlanWeek | null {
  const monday = localISODate(mondayOf(date))
  return plan.weeks.find(w => w.week_start === monday) ?? null
}

// Return the session for a given weekday tag from a synced plan week.
// Returns null if the weekday is a rest day or not in the plan.
export function syncedSessionForTag(week: SyncedPlanWeek, tag: string): SyncedPlanSession | null {
  return week.sessions.find(s => s.tag === tag) ?? null
}

// Return the session for today's weekday tag from a synced plan week
export function syncedTodaySession(week: SyncedPlanWeek): SyncedPlanSession | null {
  const todayTag = DAY_TAGS[new Date().getDay()]
  return week.sessions.find(s => s.tag === todayTag) ?? null
}

// T-157: True when the Desktop flagged the week with a session-build error.
// Defensively truthy — any non-empty error string counts, not just the canonical value.
export function weekHasSessionError(week: SyncedPlanWeek): boolean {
  return !!week.error
}

// T-169 follow-up: "no synced plan for this week" (null) and "the plan says 0 km"
// (a real injury-break/vacation week, coach.py T-131 sets planned_km = 0.0) are
// DIFFERENT states and must never collapse into one truthiness check
// (`plannedKm > 0` alone treats a real 0-km plan the same as no plan at all).
export type WeeklyPlanStatus = 'no-plan' | 'zero-planned' | 'planned'

export function weeklyPlanStatus(plannedKm: number | null): WeeklyPlanStatus {
  if (plannedKm === null) return 'no-plan'
  if (plannedKm > 0) return 'planned'
  return 'zero-planned'
}

// Plans older than this many days are considered stale regardless of other signals.
const PLAN_STALE_DAYS = 7

// True when the local settings diverge from what the synced plan was generated with,
// or the plan itself is too old to be considered current.
export function isPlanStale(
  plan: SyncedPlan,
  localVdot: number,
  localRaceDate1: string,
  localRaceDate2: string,
  syncSettings: Record<string, unknown> | null,
): boolean {
  // VDOT mismatch
  if (Math.abs(plan.vdot - localVdot) > 0.1) return true

  // Age check: plan generated more than PLAN_STALE_DAYS days ago
  if (plan.generatedAt) {
    const generatedMs = new Date(plan.generatedAt).getTime()
    if (!isNaN(generatedMs)) {
      const ageDays = (Date.now() - generatedMs) / (1000 * 60 * 60 * 24)
      if (ageDays > PLAN_STALE_DAYS) return true
    }
  }

  // Race date mismatch via sync.json settings keys raceDate1/raceDate2.
  // T-182 Phase A actually writes this block now (it was dead before — B3 in T-182: neither
  // Streamlit nor the PWA ever wrote `settings`, so this branch never fired in practice).
  // raceDate1 is `null` when Event 1 (the prep race) is disabled on the Desktop — the `d1 &&`
  // guard already treats that as "no signal" and skips the comparison, which is correct: a
  // disabled Event 1 has no date to be stale against. Covered by a dedicated test below so a
  // future cleanup pass doesn't "simplify" this into a false-positive staleness check.
  if (syncSettings) {
    const d1 = syncSettings['raceDate1'] as string | null | undefined
    const d2 = syncSettings['raceDate2'] as string | null | undefined
    if (d1 && d1 !== localRaceDate1) return true
    if (d2 && d2 !== localRaceDate2) return true
  }

  return false
}

export interface WorkoutSession {
  session:    string
  typ:        string
  distanzKm:  string | number
  vorgabe:    string
  struktur:   string
  dauerMin:   string
  hinweis:    string
  wochentag:  string
}

// ── Plan-Abweichungserkennung (T-014) ────────────────────────────────────────

export interface PlanDeviation {
  plannedLabel: string       // e.g. "Ruhetag", "Easy-DL", "Intervalle (400–800m)"
  actualType:   string       // from WorkoutClassification.workoutType or zoneCode
  actualKm:     number
  kmDelta:      number       // actual − planned (0 when rest day planned)
  coachComment: string
  badge:        'plangemäß' | 'mehr' | 'weniger' | 'ruhetag' | 'frei'
  badgeColor:   string
}

// Maps WorkoutSession.typ to broad intensity categories for comparison
function sessionIntensityLevel(typ: string): 'easy' | 'quality' | 'long' {
  const t = typ.toLowerCase()
  if (t.includes('qualität') || t.includes('speed') || t.includes('schärfung')) return 'quality'
  if (t.includes('ausdauer')) return 'long'
  return 'easy'
}

function classificationIntensityLevel(wt: WorkoutClassification['workoutType']): 'easy' | 'quality' {
  return (wt === 'strides' || wt === 'intervals' || wt === 'tempo' || wt === 'mixed') ? 'quality' : 'easy'
}

export function assessDeviation(
  plannedSession: WorkoutSession | null,  // null = rest day
  actual: ActivitySummary,
  classification: WorkoutClassification | null,
  tsb: number,
): PlanDeviation {
  const actualKm    = actual.distanceKm
  const tsbContext  = tsb > -10 ? 'im grünen Bereich' : 'bereits im Minus'
  const actualLabel = classification
    ? classification.workoutType.charAt(0).toUpperCase() + classification.workoutType.slice(1)
    : actual.actType === 'run' ? 'Lauf' : actual.actType === 'ride' ? 'Radfahrt' : 'Wanderung'

  // No plan for this day
  if (!plannedSession) {
    return {
      plannedLabel: 'Kein Plantag',
      actualType:   actualLabel,
      actualKm,
      kmDelta:      0,
      coachComment: 'Kein Plantag — freies Training.',
      badge:        'frei',
      badgeColor:   '#9C27B0',
    }
  }

  const plannedLabel = plannedSession.session
  const plannedKm    = typeof plannedSession.distanzKm === 'number'
    ? plannedSession.distanzKm
    : parseFloat(String(plannedSession.distanzKm)) || 0

  const plannedIntensity = sessionIntensityLevel(plannedSession.typ)
  const actualIntensity  = classification ? classificationIntensityLevel(classification.workoutType) : 'easy'

  // T-158(a): when plannedKm is non-numeric (e.g. "Renndistanz", "—") or zero, skip km-comparison.
  // pct=Infinity would produce a spurious "Deutlich mehr Volumen" badge on race/special days.
  if (plannedKm <= 0) {
    return {
      plannedLabel,
      actualType: actualLabel,
      actualKm,
      kmDelta:     0,
      coachComment: 'Sondereinheit — kein km-Soll.',
      badge:        'plangemäß',
      badgeColor:   '#4CAF50',
    }
  }

  // Rest day (no planned session typ that indicates running) → we use null session for rest
  // At this point we have a planned session, so check if it's a quality mismatch
  const kmDelta   = Math.round((actualKm - plannedKm) * 10) / 10
  const pct       = actualKm / plannedKm

  let coachComment: string
  let badge: PlanDeviation['badge']
  let badgeColor: string

  if (plannedIntensity === 'easy' && actualIntensity === 'quality') {
    // Easy or long planned but higher intensity done
    coachComment = 'Intensiver als geplant — stelle sicher dass der nächste Long Run trotzdem klappt.'
    badge = 'mehr'
    badgeColor = '#FF9800'
  } else if (pct > 1.20) {
    // >20% more km than planned
    coachComment = `Deutlich mehr Volumen als geplant — gönn dir in den nächsten 48h extra Erholung.`
    badge = 'mehr'
    badgeColor = '#FF9800'
  } else if (pct < 0.70) {
    // <70% of planned km (i.e. <-30%)
    coachComment = 'Weniger als geplant — kein Nachholen empfohlen, einfach weiter im Rhythmus.'
    badge = 'weniger'
    badgeColor = '#42A5F5'
  } else {
    // Typ + km within ±20%
    coachComment = 'Plangemäß trainiert. ✓'
    badge = 'plangemäß'
    badgeColor = '#4CAF50'
  }

  // TSB context appended for intensity-mismatch case
  if (badge === 'mehr' && plannedIntensity === 'easy' && actualIntensity === 'quality') {
    coachComment += ` TSB aktuell ${tsbContext}.`
  }

  return {
    plannedLabel,
    actualType: actualLabel,
    actualKm,
    kmDelta: Math.round(kmDelta * 10) / 10,
    coachComment,
    badge,
    badgeColor,
  }
}

// assessDeviationForRestDay: used when the plan shows a rest day and the user trained anyway
export function assessDeviationForRestDay(
  actual: ActivitySummary,
  tsb: number,
): PlanDeviation {
  const tsbContext  = tsb > -10 ? 'im grünen Bereich' : 'bereits im Minus'
  const actualLabel = actual.actType === 'run' ? 'Lauf' : actual.actType === 'ride' ? 'Radfahrt' : 'Wanderung'
  return {
    plannedLabel: 'Ruhetag',
    actualType:   actualLabel,
    actualKm:     actual.distanceKm,
    kmDelta:      actual.distanceKm,
    coachComment: `Training statt Ruhetag — TSB aktuell ${tsbContext}, beobachte die Erholung.`,
    badge:        'ruhetag',
    badgeColor:   '#FFC107',
  }
}
