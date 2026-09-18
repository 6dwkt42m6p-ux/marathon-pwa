import { useState, useMemo, useEffect, useRef } from 'react'
import {
  assessDeviation, assessDeviationForRestDay,
  syncedCurrentWeek, isPlanStale, weekHasSessionError,
  type PlanDeviation,
} from '../lib/plan'
import { buildPaceTable } from '../lib/vdot'
import {
  getCachedActivities, thisWeekKm, DAY_TAGS, parseAllActivities,
  computeAtlCtl, mondayOf, localISODate,
  type SyncedThreshold,
} from '../lib/strava'
import type { AppSettings } from '../lib/storage'
import { resolvePreRaceEnabled } from '../lib/storage'
import {
  hasToken, fetchSync, pushSync,
  type SyncData, type SyncedPlan, type SyncedPlanSession,
} from '../lib/githubSync'

interface Props {
  settings: AppSettings
  // Incremented by App after every successful syncActivities — triggers cache re-read
  activitiesVersion?: number
  // T-123: canonical VDOT from App — desktop sync wins, settings.vdot is offline fallback
  effectiveVdot?: number
  // T-128: FTP from sync — used for bike TSS (power-meter parity with Analysis tab)
  syncedFtp?: number | null
  // T-138: Threshold from sync — used for rTSS/hrTSS on Runs
  syncedThreshold?: SyncedThreshold | null
}

const DAYS_ORDER = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So']

interface DayAssignment { originalDay: string; currentDay: string }

function weekKey(weekStart: string | Date): string {
  if (typeof weekStart === 'string') return weekStart.slice(0, 10)
  return localISODate(weekStart)
}

function loadOverrides(key: string): DayAssignment[] | null {
  try {
    const raw = localStorage.getItem(`week_override_${key}`)
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

function saveOverrides(key: string, a: DayAssignment[]) {
  try { localStorage.setItem(`week_override_${key}`, JSON.stringify(a)) } catch {}
}

// T-231: "Zurücksetzen" removes ALL swaps of the week (Variante 2) — shown optimistically before
// Desktop has rebuilt the plan. Persisted per week so the pending hint survives a tab switch
// (component unmounts/remounts on tab change) until the wKey/syncedPlan effect below reconciles
// it against freshly synced session tags.
function loadResetPending(key: string): boolean {
  try { return localStorage.getItem(`reset_pending_${key}`) === '1' } catch { return false }
}

function saveResetPending(key: string, pending: boolean) {
  try {
    if (pending) localStorage.setItem(`reset_pending_${key}`, '1')
    else localStorage.removeItem(`reset_pending_${key}`)
  } catch {}
}

// T-024: plan-relevant input fingerprint — when this changes, request recompute
function planInputFingerprint(s: AppSettings): string {
  return [s.vdot, s.currentWeeklyKm, s.runsPerWeek, s.raceType1, s.raceDate1, s.raceType2, s.raceDate2, s.preRaceEnabled, s.experience].join('|')
}

// T-221: pure, exported so the pushed shape is unit-testable without mounting the component.
// Used both as the immediate payload builder (fetchSync(true).then(...)) and as the 409-retry
// rebuildFn passed to pushSync — closes the RMW race by re-applying against fresh remote state.
// Previously this also nested settings.vdot/event1/event2 into the payload; removed (T-221):
// grep across src/ AND Trainingscoach (github_sync.py/app.py/coach.py) found zero readers of
// those keys — planRecomputeRequested is the only signal Desktop actually consumes here.
export function buildSettingsPushPayload(base: SyncData): SyncData {
  return {
    ...base,
    planRecomputeRequested: true,
  }
}

export default function TodayWorkout({ settings, activitiesVersion = 0, effectiveVdot = settings.vdot, syncedFtp, syncedThreshold }: Props) {
  const raceDate1   = new Date(settings.raceDate1)
  const raceDate2   = new Date(settings.raceDate2)

  // ── T-024: Synced plan state ────────────────────────────────────────────────
  const [syncedPlan, setSyncedPlan] = useState<SyncedPlan | null>(null)
  const [syncSettings, setSyncSettings] = useState<Record<string, unknown> | null>(null)
  const [planRecomputeRequested, setPlanRecomputeRequested] = useState(false)
  const [syncLoading, setSyncLoading] = useState(true)
  // T-184: sync.json-derived per-activity °C (id-as-string → value). Explicit state (not a
  // hidden module store) so it participates in the useMemo deps below — otherwise a sync that
  // resolves after the first render would be invisible to React (coordinator fix-loop finding).
  const [syncedActivityTemps, setSyncedActivityTemps] = useState<Record<string, number> | undefined>(undefined)
  // T-217: Desktop-applied day-swaps per week (originalDay → currentDay), needed to tell a
  // still-pending local override apart from one Desktop has already baked into `tag`.
  const [syncedWeekOverrides, setSyncedWeekOverrides] = useState<Record<string, Record<string, string>> | undefined>(undefined)

  // Track previous settings fingerprint to detect plan-relevant changes
  const prevFingerprintRef = useRef<string | null>(null)

  useEffect(() => {
    let mounted = true
    fetchSync()
      .then(result => {
        if (mounted && result) {
          setSyncedPlan(result.data.plan ?? null)
          setSyncSettings(result.data.settings ?? null)
          setPlanRecomputeRequested(result.data.planRecomputeRequested ?? false)
          setSyncedActivityTemps(result.data.activityTemps)
          setSyncedWeekOverrides(result.data.weekOverrides)
        }
      })
      .catch(() => { /* offline — keep null, show hint screen */ })
      .finally(() => { if (mounted) setSyncLoading(false) })
    return () => { mounted = false }
  }, [])

  // T-024: Push planRecomputeRequested flag when plan-relevant inputs change
  useEffect(() => {
    const fp = planInputFingerprint(settings)
    if (prevFingerprintRef.current === null) {
      // First render — just record fingerprint
      prevFingerprintRef.current = fp
      return
    }
    if (fp === prevFingerprintRef.current) return
    // Settings changed — request recompute
    prevFingerprintRef.current = fp
    if (!hasToken()) return
    // Fire-and-forget: best effort, non-critical; force=true for fresh sha before push
    fetchSync(true)
      .then(fresh => {
        if (!fresh) return
        // rebuildFn closes the 409 RMW race: re-apply planRecomputeRequested against the
        // freshly fetched remote state, preserving concurrent Desktop changes.
        return pushSync(buildSettingsPushPayload(fresh.data), fresh.sha, buildSettingsPushPayload)
      })
      .catch(() => { /* non-critical */ })
  }, [settings])  // eslint-disable-line react-hooks/exhaustive-deps

  // ── Common data ─────────────────────────────────────────────────────────────
  const paces = useMemo(() => buildPaceTable(effectiveVdot), [effectiveVdot])
  // Re-read cache when App signals a fresh Strava sync (activitiesVersion bump)
  // or when effectiveVdot changes (pace table downstream depends on it).
  // activitiesVersion replaces the old syncedPlan dep — no longer tied to Mac-push timing.
  const cached = useMemo(() => getCachedActivities(), [activitiesVersion, effectiveVdot])  // eslint-disable-line react-hooks/exhaustive-deps
  // T-184: syncedActivityTemps must be an explicit dep — a sync resolving after first render
  // is otherwise invisible to this memo (coordinator fix-loop finding).
  const allActs      = useMemo(() => parseAllActivities(cached, syncedActivityTemps), [cached, syncedActivityTemps])
  // T-138: syncedThreshold enables rTSS/hrTSS for Runs (like syncedFtp enables bike-TSS)
  const tsbData      = useMemo(() => cached.length > 0 ? computeAtlCtl(cached, syncedFtp ?? undefined, syncedThreshold ?? undefined) : null, [cached, syncedFtp, syncedThreshold])
  const tsb           = tsbData?.tsb ?? 0
  const actualKmWeek  = useMemo(() => Math.round(thisWeekKm(cached) * 10) / 10, [cached])
  const todayTag      = DAY_TAGS[new Date().getDay()]

  // ── T-024: Render from synced plan ──────────────────────────────────────────
  const syncedCurrentW = syncedPlan ? syncedCurrentWeek(syncedPlan) : null
  const stale = syncedPlan
    ? isPlanStale(syncedPlan, settings.vdot, settings.raceDate1, settings.raceDate2, syncSettings)
    : false
  // T-182 Phase B: Event 1 (prep race) is desktop-controlled via the sync `settings` block.
  const preRaceActive = resolvePreRaceEnabled(settings.preRaceEnabled, syncSettings)

  // Derive PlanDeviation for the most recent activity against the synced plan
  let latestDeviation: PlanDeviation | null = null
  const latestAct = allActs.length > 0 ? allActs[0] : null

  // T-157: no deviation assessment when Desktop couldn't build sessions — week has no usable plan
  if (latestAct && syncedCurrentW && !weekHasSessionError(syncedCurrentW)) {
    const actDay    = new Date(latestAct.date)
    actDay.setHours(0, 0, 0, 0)
    const actMonday = mondayOf(actDay)
    const planMonday = new Date(syncedCurrentW.week_start)
    planMonday.setHours(0, 0, 0, 0)

    if (actMonday.getTime() === planMonday.getTime()) {
      const tag         = DAY_TAGS[latestAct.date.getDay()]
      const planSession = syncedCurrentW.sessions.find(s => s.tag === tag) ?? null
      if (planSession) {
        // Convert SyncedPlanSession to the shape assessDeviation expects
        const pseudoSession = {
          session:   planSession.typ,
          typ:       planSession.typ,
          distanzKm: planSession.km ?? 0,
          vorgabe:   planSession.vorgabe,
          struktur:  planSession.struktur,
          dauerMin:  planSession.dauer,
          hinweis:   planSession.hinweis,
          wochentag: planSession.tag,
        }
        latestDeviation = assessDeviation(pseudoSession, latestAct, null, tsb)
      } else {
        latestDeviation = assessDeviationForRestDay(latestAct, tsb)
      }
    }
  }

  // Day-swap state — keyed to the synced week's start date or fallback
  const wKey = syncedCurrentW ? weekKey(syncedCurrentW.week_start) : 'noweek'

  // Build DayAssignment array from synced sessions. Identity is the tag BEFORE Desktop applied
  // weekOverrides (T-217) — stable across a Desktop rebuild, unlike `s.tag` itself which changes
  // the moment Desktop bakes an override in. Falls back to `s.tag` for old sync.json snapshots
  // without `original_tag` (AC1 backward-compat).
  const rawSyncedSessions: SyncedPlanSession[] = syncedCurrentW?.sessions ?? []
  const defaultAssignments: DayAssignment[] = rawSyncedSessions
    .map(s => ({ originalDay: s.original_tag ?? s.tag, currentDay: s.original_tag ?? s.tag }))

  const [assignments, setAssignments] = useState<DayAssignment[]>(() =>
    loadOverrides(wKey) ?? defaultAssignments
  )
  // T-231: locally-pending "Zurücksetzen" — see displaySessions below for how it overrides tags.
  const [resetPending, setResetPending] = useState<boolean>(false)
  // T-217 AC3: `assignments` was only ever initialized once at mount, when `wKey` is still the
  // 'noweek' placeholder (fetchSync resolves after first render). Rebuild whenever the resolved
  // week or the synced plan itself changes, so a genuinely-saved override is picked up instead
  // of staying stuck on the 'noweek' initial value forever.
  useEffect(() => {
    setAssignments(loadOverrides(wKey) ?? defaultAssignments)
    // T-231: resolve a pending reset once Desktop has rebuilt THIS week's sessions with no shift
    // left. `weekOverrides[wKey]` alone is not a reliable signal — resetOverrides() already
    // pushes it empty the moment the button is clicked, before Desktop rebuilds `tag`; checking
    // it here would clear the hint before the swap is actually gone from the displayed plan.
    const pending = loadResetPending(wKey)
    const stillShiftedOnDesktop = rawSyncedSessions.some(s => s.tag !== (s.original_tag ?? s.tag))
    if (pending && stillShiftedOnDesktop) {
      setResetPending(true)
    } else {
      if (pending) saveResetPending(wKey, false)
      setResetPending(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wKey, syncedPlan])
  const [swapping, setSwapping] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(todayTag)

  async function pushOverridesToGitHub(overrides: DayAssignment[]) {
    if (!hasToken()) return
    try {
      const current = await fetchSync(true)  // force: need fresh sha before push
      const map: Record<string, string> = {}
      overrides.forEach(a => { if (a.originalDay !== a.currentDay) map[a.originalDay] = a.currentDay })
      // rebuildFn closes the 409 RMW race: re-apply THIS week's overrides against the
      // freshly fetched remote state, preserving other weeks and concurrent Desktop changes.
      const buildPayload = (base: SyncData): SyncData => ({
        ...base,
        weekOverrides: { ...(base.weekOverrides ?? {}), [wKey]: map },
      })
      await pushSync(buildPayload(current?.data ?? {}), current?.sha, buildPayload)
    } catch { /* sync failure is non-critical */ }
  }

  function handleSwap(originalDay: string, targetDay: string) {
    const next = assignments.map(a => ({ ...a }))
    const moving    = next.find(a => a.originalDay === originalDay)!
    const displaced = next.find(a => a.currentDay === targetDay && a.originalDay !== originalDay)
    if (displaced) displaced.currentDay = moving.currentDay
    moving.currentDay = targetDay
    setAssignments(next)
    saveOverrides(wKey, next)
    setSwapping(null)
    setExpanded(targetDay)
    pushOverridesToGitHub(next)
  }

  // T-231 Variante 2 (Coordinator-Entscheidung): "Zurücksetzen" heißt für den Nutzer "alle
  // Tausche weg" — entfernt ALLE Tausche der Woche (auch bereits Desktop-gebaute), zeigt das
  // sofort optimistisch an (original_tag) und blendet einen Hinweis ein, bis Desktop die Woche
  // tatsächlich neu gebaut hat (Muster injuryPending/Deferred-Write-Back).
  function resetOverrides() {
    setAssignments(defaultAssignments)
    saveOverrides(wKey, defaultAssignments)
    setSwapping(null)
    setResetPending(true)
    saveResetPending(wKey, true)
    pushOverridesToGitHub(defaultAssignments)
  }

  // Apply assignments to synced sessions and sort.
  // T-217 AC2: a local override is only applied as a PENDING overlay when Desktop hasn't
  // already baked the same swap into `tag` via weekOverrides — otherwise a swap of two
  // sessions (Do↔So) would shift a second time on top of the already-shifted plan.
  const displaySessions = useMemo(() => {
    if (!rawSyncedSessions.length) return []
    return rawSyncedSessions
      .map(s => {
        const identity = s.original_tag ?? s.tag
        // T-231: pending reset takes back ALL swaps of the week immediately, including ones
        // Desktop already baked into `tag` — resolved once Desktop rebuilds (see effect above).
        if (resetPending) {
          return { ...s, tag: identity, originalTag: identity, isShifted: false }
        }
        const local           = assignments.find(a => a.originalDay === identity)
        const localIsSwap     = !!local && local.originalDay !== local.currentDay
        const alreadyOnDesktop = localIsSwap &&
          syncedWeekOverrides?.[wKey]?.[local!.originalDay] === local!.currentDay
        const tag       = localIsSwap && !alreadyOnDesktop ? local!.currentDay : s.tag
        const isShifted = tag !== (s.original_tag ?? tag)
        return { ...s, tag, originalTag: identity, isShifted }
      })
      .sort((a, b) => DAYS_ORDER.indexOf(a.tag) - DAYS_ORDER.indexOf(b.tag))
  }, [rawSyncedSessions, assignments, syncedWeekOverrides, wKey, resetPending])

  // T-217 AC2/AC3: reset button must also surface a still-pending local swap that the
  // per-session `isShifted` formula can mask (old sync.json without `original_tag`, see
  // displaySessions comment above) — the two conditions are deliberately independent (OR).
  const hasOverrides = displaySessions.some(s => s.isShifted) ||
    assignments.some(a => a.originalDay !== a.currentDay)

  const plannedKmSynced  = syncedCurrentW?.planned_km ?? 0
  const progressPct      = plannedKmSynced > 0 ? Math.min(100, (actualKmWeek / plannedKmSynced) * 100) : 0
  const progressColor    = progressPct >= 80 ? '#4CAF50' : progressPct >= 50 ? '#FFC107' : '#e53935'

  const phase  = syncedCurrentW?.phase ?? '—'
  const pColor = PHASE_COLORS[phase.split(' ')[0]] || '#42A5F5'
  const totalWeeks = syncedPlan?.weeks.length ?? 0
  const weekNum    = syncedCurrentW?.week_nr ?? 1

  // ── No synced plan → hint screen (no local generator, no assessDeviation) ──
  if (!syncLoading && !syncedPlan) {
    return (
      <FallbackTodayWorkout
        settings={settings}
        cached={cached}
        paces={paces}
        effectiveVdot={effectiveVdot}
        preRaceActive={preRaceActive}
      />
    )
  }

  if (syncLoading) {
    return (
      <div className="tab-content">
        <div style={{ padding: '20px 0', textAlign: 'center', color: 'var(--text-2)', fontSize: '13px' }}>
          Plan wird geladen…
        </div>
      </div>
    )
  }

  // ── Synced plan available → render verbatim ─────────────────────────────────
  return (
    <div className="tab-content">
      {/* This-week progress */}
      {cached.length > 0 && (
        <div className="activity-card" style={{ padding: '10px 12px' }}>
          <div style={{ fontSize: '12px', color: 'var(--text-2)', marginBottom: '4px', display: 'flex', justifyContent: 'space-between' }}>
            <span>Diese Woche</span>
            <span style={{ color: progressColor, fontWeight: 700 }}>
              {actualKmWeek} km von {plannedKmSynced} km ({Math.round(progressPct)}%)
            </span>
          </div>
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: `${progressPct}%`, background: progressColor }} />
          </div>
        </div>
      )}

      {/* Staleness banner */}
      {(stale || planRecomputeRequested) && (
        <div style={{
          background: '#FF980020',
          border: '1px solid #FF980055',
          borderRadius: '8px',
          padding: '8px 12px',
          fontSize: '12px',
          color: '#FF9800',
        }}>
          ⚠️ Plan ggf. veraltet — am Desktop aktualisieren
        </div>
      )}

      {/* T-157: Session build error for current week */}
      {syncedCurrentW && weekHasSessionError(syncedCurrentW) && (
        <div style={{
          background: '#FF980020',
          border: '1px solid #FF980055',
          borderRadius: '8px',
          padding: '8px 12px',
          fontSize: '12px',
          color: '#FF9800',
        }}>
          ⚠️ Einheiten für diese Woche konnten nicht erzeugt werden — Desktop prüfen
        </div>
      )}

      {/* Plan-Abweichung letzte Aktivität (T-014) */}
      {latestDeviation && latestDeviation.badge !== 'frei' && latestAct && (
        <div style={{
          background: `${latestDeviation.badgeColor}12`,
          border: `1px solid ${latestDeviation.badgeColor}33`,
          borderRadius: '8px',
          padding: '10px 12px',
          fontSize: '12px',
        }}>
          <div style={{ fontWeight: 700, fontSize: '11px', color: 'var(--text-2)', marginBottom: '6px', letterSpacing: '0.04em' }}>
            LETZTE EINHEIT — PLAN-CHECK
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', rowGap: '3px', columnGap: '10px' }}>
            <span style={{ color: 'var(--text-2)' }}>Geplant:</span>
            <span style={{ fontWeight: 600 }}>{latestDeviation.plannedLabel}</span>
            <span style={{ color: 'var(--text-2)' }}>Trainiert:</span>
            <span style={{ fontWeight: 600, color: latestDeviation.badgeColor }}>
              {latestDeviation.actualType} — {latestDeviation.actualKm} km
            </span>
            {latestDeviation.kmDelta !== 0 && (
              <>
                <span style={{ color: 'var(--text-2)' }}>Abweichung:</span>
                <span style={{ fontWeight: 600, color: latestDeviation.badgeColor }}>
                  {latestDeviation.kmDelta > 0 ? '+' : ''}{latestDeviation.kmDelta} km
                </span>
              </>
            )}
          </div>
          <div style={{ marginTop: '6px', fontSize: '11px', color: 'var(--text-2)', fontStyle: 'italic', lineHeight: 1.5 }}>
            {latestDeviation.coachComment}
          </div>
        </div>
      )}

      {/* Week header */}
      <div className="week-badge" style={{ borderColor: pColor }}>
        <div className="week-badge-row">
          <span className="week-num">Woche {weekNum} / {totalWeeks}</span>
          <span className="phase-tag" style={{ color: pColor }}>{phase}</span>
        </div>
        <span className="planned-km">{plannedKmSynced} km geplant diese Woche</span>
      </div>

      {/* Wochenplan header row */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div className="section-title" style={{ flex: 1 }}>Wochenplan</div>
        {hasOverrides && (
          <button className="btn-small" onClick={resetOverrides} style={{ fontSize: '11px', padding: '3px 8px' }}>
            ↺ Zurücksetzen
          </button>
        )}
      </div>

      {/* T-231: pending reset — optimistic already applied above, this is the deferred-write hint */}
      {resetPending && (
        <div style={{
          background: '#FF980020',
          border: '1px solid #FF980055',
          borderRadius: '8px',
          padding: '8px 12px',
          fontSize: '12px',
          color: '#FF9800',
        }}>
          ↺ Zurückgesetzt — wird beim nächsten Desktop-Sync wirksam
        </div>
      )}

      <div className="sessions-list">
        {displaySessions.length === 0 && (
          <div className="workout-card empty">
            <p>Kein Trainingsplan — Renntermin in den Einstellungen eintragen.</p>
          </div>
        )}

        {DAYS_ORDER.map(day => {
          const session = displaySessions.find(s => s.tag === day) as (SyncedPlanSession & { originalTag: string; isShifted: boolean }) | undefined
          const isToday = day === todayTag

          if (!session) {
            return (
              <div key={day} className={`session-row rest-day ${isToday ? 'today' : ''}`}>
                <div className="session-header" style={{ cursor: 'default' }}>
                  <div className="session-day-col">
                    <span className={`session-day ${isToday ? 'today-day' : ''}`}>{day}</span>
                    {isToday && <span className="today-dot" />}
                  </div>
                  <div className="session-summary">
                    <span className="session-name" style={{ color: 'var(--text-2)' }}>Ruhetag</span>
                  </div>
                  <span className="rest-badge">😴</span>
                </div>
              </div>
            )
          }

          const isOpen     = expanded === day
          const isSwapping = swapping === session.originalTag
          const isShifted  = session.isShifted
          const kmDisplay  = session.km !== null ? `${session.km} km` : '—'

          return (
            <div key={day} className={`session-row ${isToday ? 'today' : ''} ${isOpen ? 'open' : ''}`}>
              <div className="session-header" onClick={() => { if (!isSwapping) setExpanded(isOpen ? null : day) }}>
                <div className="session-day-col">
                  <span className={`session-day ${isToday ? 'today-day' : ''}`}>{day}</span>
                  {isToday && <span className="today-dot" />}
                  {isShifted && <span className="shifted-dot" title="Verschoben" />}
                </div>
                <div className="session-summary">
                  {/* Verbatim typ as session name (T-024) */}
                  <span className="session-name">{session.typ}</span>
                  <span className="session-meta">
                    {kmDisplay}
                    {' · '}{session.dauer}
                    {isShifted && <span style={{ color: 'var(--yellow)', marginLeft: 4 }}>↻ verschoben</span>}
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <button
                    className={`swap-btn ${isSwapping ? 'active' : ''}`}
                    onClick={e => { e.stopPropagation(); setSwapping(isSwapping ? null : session.originalTag) }}
                    title="Einheit verschieben"
                  >
                    📅
                  </button>
                  <div className="session-typ-badge"><span>{session.typ}</span></div>
                  <span className="session-chevron">{isOpen ? '▲' : '▼'}</span>
                </div>
              </div>

              {/* Day picker for swapping */}
              {isSwapping && (
                <div className="day-picker">
                  <div className="day-picker-label">Verschieben auf:</div>
                  <div className="day-picker-row">
                    {DAYS_ORDER.map(targetDay => {
                      const targetSession = displaySessions.find(
                        s => s.tag === targetDay && (s as SyncedPlanSession & { originalTag: string }).originalTag !== session.originalTag
                      )
                      const isCurrent = day === targetDay
                      return (
                        <button
                          key={targetDay}
                          className={`day-pick-btn ${isCurrent ? 'current' : ''} ${targetDay === todayTag ? 'is-today' : ''}`}
                          onClick={() => !isCurrent && handleSwap(session.originalTag, targetDay)}
                          disabled={isCurrent}
                        >
                          <span className="day-pick-label">{targetDay}</span>
                          <span className="day-pick-sub">{targetSession ? '🏃' : isCurrent ? '●' : 'Ruhe'}</span>
                        </button>
                      )
                    })}
                  </div>
                  <div className="day-picker-hint">
                    {displaySessions.length > 0 ? 'Trainingstag = tauschen · Ruhetag = verschieben' : ''}
                  </div>
                </div>
              )}

              {/* Session detail — verbatim vorgabe, struktur, hinweis (T-024) */}
              {isOpen && !isSwapping && (
                <div className="session-detail">
                  <div className="detail-block">
                    <span className="detail-label">Vorgabe</span>
                    <p className="detail-vorgabe">{session.vorgabe}</p>
                  </div>
                  <div className="detail-block">
                    <span className="detail-label">Struktur</span>
                    <p>{session.struktur}</p>
                  </div>
                  <div className="detail-hinweis">
                    <span>💡</span>
                    <p>{session.hinweis}</p>
                  </div>
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* Quick pace reference — verbatim from synced plan paces, label uses effectiveVdot */}
      {syncedPlan && (
        <>
          <div className="section-title">Pace-Referenz (VDOT {effectiveVdot.toFixed(1)})</div>
          <div className="pace-grid">
            <PaceRow label="Easy" range={`${syncedPlan.paces.E_high} – ${syncedPlan.paces.E_low}`} color="#4CAF50" />
            <PaceRow label="Marathon-Pace" range={syncedPlan.paces.M} color="#FFC107" />
            <PaceRow label="Schwelle (T)" range={syncedPlan.paces.T} color="#FF9800" />
            <PaceRow label="Intervall (I)" range={syncedPlan.paces.I} color="#e53935" />
          </div>
        </>
      )}

      {/* Race countdowns */}
      <div className="section-title">Renntermine</div>
      <div className="race-list">
        {preRaceActive && (
          <RaceCountdownCard
            name={settings.raceType1 === 'hm' ? 'Halbmarathon' : 'Marathon'}
            badge={settings.raceType1 === 'hm' ? 'HM' : 'M'}
            date={raceDate1}
          />
        )}
        <RaceCountdownCard
          name={settings.raceType2 === 'marathon' ? 'Marathon' : 'Halbmarathon'}
          badge={settings.raceType2 === 'marathon' ? 'M' : 'HM'}
          date={raceDate2}
        />
      </div>
    </div>
  )
}

// ── Phase colors (shared) ────────────────────────────────────────────────────
const PHASE_COLORS: Record<string, string> = {
  'Basis': '#42A5F5', 'Aufbau': '#FFC107', 'Peak': '#FF9800',
  'Tapering': '#9C27B0', 'HM-Tapering': '#AB47BC', 'HM-Erholung': '#4CAF50',
  'Halbmarathon': '#e53935', 'Renntag': '#e53935',
}

// ── Fallback component when no synced plan is available ─────────────────────
// No local generator sessions or assessDeviation — SSoT via sync.json only.

interface FallbackProps {
  settings:      AppSettings
  cached:        ReturnType<typeof getCachedActivities>
  paces:         ReturnType<typeof buildPaceTable>
  effectiveVdot: number
  preRaceActive: boolean
}

function FallbackTodayWorkout({ settings, cached, paces, effectiveVdot, preRaceActive }: FallbackProps) {
  const raceDate2     = new Date(settings.raceDate2)
  const raceDate1     = new Date(settings.raceDate1)

  const actualKmWeek  = Math.round(thisWeekKm(cached) * 10) / 10

  return (
    <div className="tab-content">
      {/* "No plan" info screen — no local session details, no assessDeviation */}
      <div style={{
        background: '#42A5F520',
        border: '1px solid #42A5F555',
        borderRadius: '8px',
        padding: '14px 14px',
        fontSize: '13px',
        color: '#42A5F5',
        lineHeight: 1.6,
        marginBottom: '12px',
      }}>
        <div style={{ fontWeight: 700, marginBottom: '6px' }}>Plan wird am Desktop berechnet</div>
        <div style={{ color: 'var(--text-2)', fontSize: '12px' }}>
          Einmal Desktop-App (Streamlit) öffnen und GitHub-Token verbinden — dann erscheint der
          vollständige Wochenplan inkl. Soll-km und Session-Details hier.
        </div>
      </div>

      {cached.length > 0 && (
        <div className="activity-card" style={{ padding: '10px 12px' }}>
          <div style={{ fontSize: '12px', color: 'var(--text-2)', marginBottom: '4px' }}>
            Diese Woche gelaufen
          </div>
          <div style={{ fontSize: '18px', fontWeight: 700, color: 'var(--accent)' }}>
            {actualKmWeek} km
          </div>
        </div>
      )}

      <div className="section-title">Pace-Referenz (VDOT {effectiveVdot.toFixed(1)})</div>
      <div className="pace-grid">
        <PaceRow label="Easy" range={`${paces.E_high} – ${paces.E_low}`} color="#4CAF50" />
        <PaceRow label="Marathon-Pace" range={paces.M} color="#FFC107" />
        <PaceRow label="Schwelle (T)" range={paces.T} color="#FF9800" />
        <PaceRow label="Intervall (I)" range={paces.I} color="#e53935" />
      </div>

      <div className="section-title">Renntermine</div>
      <div className="race-list">
        {preRaceActive && (
          <RaceCountdownCard
            name={settings.raceType1 === 'hm' ? 'Halbmarathon' : 'Marathon'}
            badge={settings.raceType1 === 'hm' ? 'HM' : 'M'}
            date={raceDate1}
          />
        )}
        <RaceCountdownCard
          name={settings.raceType2 === 'marathon' ? 'Marathon' : 'Halbmarathon'}
          badge={settings.raceType2 === 'marathon' ? 'M' : 'HM'}
          date={raceDate2}
        />
      </div>
    </div>
  )
}

// ── Shared sub-components ───────────────────────────────────────────────────

function PaceRow({ label, range, color }: { label: string; range: string; color: string }) {
  return (
    <div className="pace-row">
      <div className="pace-dot" style={{ background: color }} />
      <span className="pace-label">{label}</span>
      <span className="pace-val">{range} /km</span>
    </div>
  )
}

function RaceCountdownCard({ name, badge, date }: { name: string; badge: string; date: Date }) {
  const today    = new Date()
  today.setHours(0, 0, 0, 0)
  const raceDay  = new Date(date)
  raceDay.setHours(0, 0, 0, 0)
  const diffMs   = raceDay.getTime() - today.getTime()
  const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24))
  const isPast   = diffDays < 0
  const isToday  = diffDays === 0
  const dateStr  = date.toLocaleDateString('de-AT', { day: '2-digit', month: 'short', year: 'numeric' })

  const accentColor = isToday
    ? 'var(--red)'
    : diffDays <= 30
    ? 'var(--orange)'
    : diffDays <= 90
    ? 'var(--yellow)'
    : 'var(--accent)'

  return (
    <div className={`race-countdown-card ${isPast ? 'past' : ''}`} style={{ borderColor: isPast ? 'var(--border)' : accentColor }}>
      <div className="rcc-left">
        <span className="rcc-badge" style={{ background: isPast ? 'var(--bg3)' : accentColor }}>{badge}</span>
      </div>
      <div className="rcc-info">
        <span className="rcc-name">{name}</span>
        <span className="rcc-date">{dateStr}</span>
      </div>
      <div className="rcc-countdown">
        {isPast
          ? <span className="rcc-past">Absolviert</span>
          : isToday
          ? <span className="rcc-today">Heute!</span>
          : (
            <>
              <span className="rcc-days" style={{ color: accentColor }}>{diffDays}</span>
              <span className="rcc-days-label">Tage</span>
            </>
          )
        }
      </div>
    </div>
  )
}
