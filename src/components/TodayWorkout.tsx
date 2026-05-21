import { useState } from 'react'
import { generatePlan, allWeekSessions } from '../lib/plan'
import { buildPaceTable } from '../lib/vdot'
import { getCachedActivities, thisWeekKm } from '../lib/strava'
import type { AppSettings } from '../lib/storage'

interface Props { settings: AppSettings }

const DAY_MAP: Record<number, string> = { 0: 'So', 1: 'Mo', 2: 'Di', 3: 'Mi', 4: 'Do', 5: 'Fr', 6: 'Sa' }

export default function TodayWorkout({ settings }: Props) {
  const raceDate1 = new Date(settings.raceDate1)
  const raceDate2 = new Date(settings.raceDate2)
  const preRaceDate = settings.preRaceEnabled ? raceDate1 : undefined

  const plan = generatePlan(raceDate2, settings.currentWeeklyKm, settings.runsPerWeek, settings.raceType2, preRaceDate)
  const paces = buildPaceTable(settings.vdot)

  const currentRow = plan.find(r => r.isCurrent)
  const weekNum    = currentRow?.weekNr ?? 1
  const totalWeeks = plan.length - 1
  const phase      = currentRow?.phase ?? '—'
  const plannedKm  = currentRow?.plannedKm ?? 0

  // This-week progress from Strava cache
  const cached         = getCachedActivities()
  const actualKmWeek   = Math.round(thisWeekKm(cached) * 10) / 10
  const progressPct    = plannedKm > 0 ? Math.min(100, (actualKmWeek / plannedKm) * 100) : 0
  const progressColor  = progressPct >= 80 ? '#4CAF50' : progressPct >= 50 ? '#FFC107' : '#e53935'

  const todayTag = DAY_MAP[new Date().getDay()]
  const sessions = currentRow
    ? allWeekSessions(currentRow.phase, currentRow.plannedKm, settings.vdot, settings.runsPerWeek, settings.raceType2)
    : []

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

      {/* Day-by-day sessions */}
      <div className="section-title">Wochenplan</div>
      <div className="sessions-list">
        {sessions.length === 0 && (
          <div className="workout-card empty">
            <p>Kein Trainingsplan — Renntermin in den Einstellungen eintragen.</p>
          </div>
        )}
        {sessions.map(session => {
          const isToday = session.wochentag === todayTag
          const isOpen  = expanded === session.wochentag
          return (
            <div
              key={session.wochentag}
              className={`session-row ${isToday ? 'today' : ''} ${isOpen ? 'open' : ''}`}
            >
              <div className="session-header" onClick={() => setExpanded(isOpen ? null : session.wochentag)}>
                <div className="session-day-col">
                  <span className={`session-day ${isToday ? 'today-day' : ''}`}>{session.wochentag}</span>
                  {isToday && <span className="today-dot" />}
                </div>
                <div className="session-summary">
                  <span className="session-name">{session.session}</span>
                  <span className="session-meta">
                    {typeof session.distanzKm === 'number' ? `${session.distanzKm} km` : session.distanzKm}
                    {' · '}{session.dauerMin}
                  </span>
                </div>
                <div className="session-typ-badge">
                  <span>{session.typ}</span>
                </div>
                <span className="session-chevron">{isOpen ? '▲' : '▼'}</span>
              </div>

              {isOpen && (
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
  const diffMs   = date.getTime() - new Date().getTime()
  const diffDays = Math.max(0, Math.ceil(diffMs / (24 * 3600 * 1000)))
  const diffWeeks = Math.floor(diffDays / 7)
  const dateStr  = date.toLocaleDateString('de-AT', { day: '2-digit', month: 'short', year: 'numeric' })
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
