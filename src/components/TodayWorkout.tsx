import { useState, useMemo } from 'react'
import { generatePlan, allWeekSessions } from '../lib/plan'
import { buildPaceTable } from '../lib/vdot'
import { getCachedActivities, thisWeekKm, DAY_TAGS } from '../lib/strava'
import type { AppSettings } from '../lib/storage'
import { hasToken, fetchSync, pushSync } from '../lib/githubSync'

interface Props { settings: AppSettings }

const DAYS_ORDER = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So']

interface DayAssignment { originalDay: string; currentDay: string }

function weekKey(weekStart: Date): string {
  return weekStart.toISOString().slice(0, 10)
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

export default function TodayWorkout({ settings }: Props) {
  const raceDate1   = new Date(settings.raceDate1)
  const raceDate2   = new Date(settings.raceDate2)
  const preRaceDate = settings.preRaceEnabled ? raceDate1 : undefined

  const plan       = generatePlan(raceDate2, settings.currentWeeklyKm, settings.runsPerWeek, settings.raceType2, preRaceDate)
  const paces      = buildPaceTable(settings.vdot)
  const currentRow = plan.find(r => r.isCurrent)

  const weekNum    = currentRow?.weekNr ?? 1
  const totalWeeks = plan.length - 1
  const phase      = currentRow?.phase ?? '—'
  const plannedKm  = currentRow?.plannedKm ?? 0

  const cached        = getCachedActivities()
  const actualKmWeek  = Math.round(thisWeekKm(cached) * 10) / 10
  const progressPct   = plannedKm > 0 ? Math.min(100, (actualKmWeek / plannedKm) * 100) : 0
  const progressColor = progressPct >= 80 ? '#4CAF50' : progressPct >= 50 ? '#FFC107' : '#e53935'

  const todayTag  = DAY_TAGS[new Date().getDay()]
  const rawSessions = currentRow
    ? allWeekSessions(currentRow.phase, currentRow.plannedKm, settings.vdot, settings.runsPerWeek, settings.raceType2)
    : []

  // ── Day-swap state ──────────────────────────────────────────────────────────
  const wKey = currentRow ? weekKey(currentRow.weekStart) : 'noweek'
  const defaultAssignments: DayAssignment[] = rawSessions.map(s => ({ originalDay: s.wochentag, currentDay: s.wochentag }))

  const [assignments, setAssignments] = useState<DayAssignment[]>(() =>
    loadOverrides(wKey) ?? defaultAssignments
  )
  const [swapping, setSwapping] = useState<string | null>(null) // originalDay currently being moved

  async function pushOverridesToGitHub(overrides: DayAssignment[]) {
    if (!hasToken()) return
    try {
      const current = await fetchSync()
      const map: Record<string, string> = {}
      overrides.forEach(a => { if (a.originalDay !== a.currentDay) map[a.originalDay] = a.currentDay })
      const allWeekOverrides = { ...(current?.data.weekOverrides ?? {}), [wKey]: map }
      await pushSync({ settings: current?.data.settings, weekOverrides: allWeekOverrides }, current?.sha)
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

  function resetOverrides() {
    setAssignments(defaultAssignments)
    saveOverrides(wKey, defaultAssignments)
    setSwapping(null)
    pushOverridesToGitHub(defaultAssignments)
  }

  // Apply current assignments to sessions and sort by calendar order
  const displaySessions = useMemo(() =>
    rawSessions
      .map(s => {
        const assigned = assignments.find(a => a.originalDay === s.wochentag)
        return { ...s, wochentag: assigned?.currentDay ?? s.wochentag, originalDay: s.wochentag }
      })
      .sort((a, b) => DAYS_ORDER.indexOf(a.wochentag) - DAYS_ORDER.indexOf(b.wochentag)),
  [rawSessions, assignments])

  const hasOverrides = assignments.some(a => a.originalDay !== a.currentDay)

  const [expanded, setExpanded] = useState<string | null>(todayTag)

  const phaseColor: Record<string, string> = {
    'Basis': '#42A5F5', 'Aufbau': '#FFC107', 'Peak': '#FF9800',
    'Tapering': '#9C27B0', 'HM-Tapering': '#AB47BC', 'HM-Erholung': '#4CAF50',
    'Halbmarathon': '#e53935', 'Renntag': '#e53935',
  }
  const pColor = phaseColor[phase.split(' ')[0]] || '#42A5F5'

  return (
    <div className="tab-content">
      {/* This-week progress */}
      {cached.length > 0 && (
        <div className="activity-card" style={{ padding: '10px 12px' }}>
          <div style={{ fontSize: '12px', color: 'var(--text2)', marginBottom: '4px', display: 'flex', justifyContent: 'space-between' }}>
            <span>Diese Woche</span>
            <span style={{ color: progressColor, fontWeight: 700 }}>
              {actualKmWeek} km von {plannedKm} km ({Math.round(progressPct)}%)
            </span>
          </div>
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: `${progressPct}%`, background: progressColor }} />
          </div>
        </div>
      )}

      {/* Week header */}
      <div className="week-badge" style={{ borderColor: pColor }}>
        <div className="week-badge-row">
          <span className="week-num">Woche {weekNum} / {totalWeeks}</span>
          <span className="phase-tag" style={{ color: pColor }}>{phase}</span>
        </div>
        <span className="planned-km">{plannedKm} km geplant diese Woche</span>
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

      <div className="sessions-list">
        {displaySessions.length === 0 && (
          <div className="workout-card empty">
            <p>Kein Trainingsplan — Renntermin in den Einstellungen eintragen.</p>
          </div>
        )}

        {/* All 7 days — training days + rest days interleaved */}
        {DAYS_ORDER.map(day => {
          const session = displaySessions.find(s => s.wochentag === day)
          const isToday = day === todayTag

          if (!session) {
            // Rest day
            return (
              <div key={day} className={`session-row rest-day ${isToday ? 'today' : ''}`}>
                <div className="session-header" style={{ cursor: 'default' }}>
                  <div className="session-day-col">
                    <span className={`session-day ${isToday ? 'today-day' : ''}`}>{day}</span>
                    {isToday && <span className="today-dot" />}
                  </div>
                  <div className="session-summary">
                    <span className="session-name" style={{ color: 'var(--text2)' }}>Ruhetag</span>
                  </div>
                  <span className="rest-badge">😴</span>
                </div>
              </div>
            )
          }

          const isOpen     = expanded === day
          const isSwapping = swapping === session.originalDay
          const isShifted  = session.originalDay !== session.wochentag

          return (
            <div key={day} className={`session-row ${isToday ? 'today' : ''} ${isOpen ? 'open' : ''}`}>
              <div className="session-header" onClick={() => { if (!isSwapping) setExpanded(isOpen ? null : day) }}>
                <div className="session-day-col">
                  <span className={`session-day ${isToday ? 'today-day' : ''}`}>{day}</span>
                  {isToday && <span className="today-dot" />}
                  {isShifted && <span className="shifted-dot" title="Verschoben" />}
                </div>
                <div className="session-summary">
                  <span className="session-name">{session.session}</span>
                  <span className="session-meta">
                    {typeof session.distanzKm === 'number' ? `${session.distanzKm} km` : session.distanzKm}
                    {' · '}{session.dauerMin}
                    {isShifted && <span style={{ color: 'var(--yellow)', marginLeft: 4 }}>↻ verschoben</span>}
                  </span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <button
                    className={`swap-btn ${isSwapping ? 'active' : ''}`}
                    onClick={e => { e.stopPropagation(); setSwapping(isSwapping ? null : session.originalDay) }}
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
                      const targetSession = displaySessions.find(s => s.wochentag === targetDay && s.originalDay !== session.originalDay)
                      const isCurrent = day === targetDay
                      return (
                        <button
                          key={targetDay}
                          className={`day-pick-btn ${isCurrent ? 'current' : ''} ${targetDay === todayTag ? 'is-today' : ''}`}
                          onClick={() => !isCurrent && handleSwap(session.originalDay, targetDay)}
                          disabled={isCurrent}
                        >
                          <span className="day-pick-label">{targetDay}</span>
                          <span className="day-pick-sub">{targetSession ? '🏃' : isCurrent ? '●' : 'Ruhe'}</span>
                        </button>
                      )
                    })}
                  </div>
                  <div className="day-picker-hint">
                    {displaySessions.find(s => s.wochentag !== day) ? 'Trainingstag = tauschen · Ruhetag = verschieben' : ''}
                  </div>
                </div>
              )}

              {/* Session detail */}
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

      {/* Quick pace reference */}
      <div className="section-title">Pace-Referenz (VDOT {settings.vdot})</div>
      <div className="pace-grid">
        <PaceRow label="Easy" range={`${paces.E_high} – ${paces.E_low}`} color="#4CAF50" />
        <PaceRow label="Marathon-Pace" range={paces.M} color="#FFC107" />
        <PaceRow label="Schwelle (T)" range={paces.T} color="#FF9800" />
        <PaceRow label="Intervall (I)" range={paces.I} color="#e53935" />
      </div>

      {/* Race countdowns */}
      <div className="section-title">Renntermine</div>
      <div className="race-list">
        <RaceItem type={settings.raceType1 === 'hm' ? 'Halbmarathon' : 'Marathon'} date={raceDate1} icon="🏃" />
        <RaceItem type={settings.raceType2 === 'marathon' ? 'Marathon' : 'Halbmarathon'} date={raceDate2} icon="🏆" />
      </div>
    </div>
  )
}

function PaceRow({ label, range, color }: { label: string; range: string; color: string }) {
  return (
    <div className="pace-row">
      <div className="pace-dot" style={{ background: color }} />
      <span className="pace-label">{label}</span>
      <span className="pace-val">{range} /km</span>
    </div>
  )
}

function RaceItem({ type, date, icon }: { type: string; date: Date; icon: string }) {
  const diffMs    = date.getTime() - new Date().getTime()
  const diffDays  = Math.max(0, Math.ceil(diffMs / (24 * 3600 * 1000)))
  const diffWeeks = Math.floor(diffDays / 7)
  const dateStr   = date.toLocaleDateString('de-AT', { day: '2-digit', month: 'short', year: 'numeric' })
  return (
    <div className="race-item">
      <span className="race-icon">{icon}</span>
      <div className="race-info">
        <span className="race-type">{type}</span>
        <span className="race-date">{dateStr}</span>
      </div>
      <div className="race-countdown">
        {diffDays === 0
          ? <span className="countdown-today">Heute!</span>
          : <><span className="countdown-weeks">{diffWeeks}W</span><span className="countdown-days">{diffDays} Tage</span></>
        }
      </div>
    </div>
  )
}
