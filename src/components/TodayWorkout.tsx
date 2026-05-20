import { generatePlan, todayWorkout } from '../lib/plan'
import { buildPaceTable } from '../lib/vdot'
import type { AppSettings } from '../lib/storage'

interface Props { settings: AppSettings }

export default function TodayWorkout({ settings }: Props) {
  const raceDate1 = new Date(settings.raceDate1)
  const raceDate2 = new Date(settings.raceDate2)
  const preRaceDate = settings.preRaceEnabled ? raceDate1 : undefined

  // Build primary plan (race 2 = marathon, with HM as pre-race)
  const plan = generatePlan(raceDate2, settings.currentWeeklyKm, settings.runsPerWeek, settings.raceType2, preRaceDate)
  const workout = todayWorkout(plan, settings.vdot, settings.runsPerWeek, settings.raceType2)
  const paces = buildPaceTable(settings.vdot)

  const currentRow = plan.find(r => r.isCurrent)
  const weekNum = currentRow?.weekNr ?? 1
  const totalWeeks = plan.length - 1 // -1 for race day row
  const phase = currentRow?.phase ?? '—'
  const plannedKm = currentRow?.plannedKm ?? 0

  const today = new Date()
  const dayNames = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag']
  const todayName = dayNames[today.getDay()]

  const phaseColor: Record<string, string> = {
    'Basis': '#42A5F5', 'Aufbau': '#FFC107', 'Peak': '#FF9800',
    'Tapering': '#9C27B0', 'HM-Tapering': '#AB47BC', 'HM-Erholung': '#4CAF50',
    'Halbmarathon 🏁': '#e53935', 'Renntag 🏁': '#e53935',
  }
  const basePhase = phase.split(' ')[0]
  const pColor = phaseColor[basePhase] || phaseColor[phase] || '#42A5F5'

  return (
    <div className="tab-content">
      {/* Week header */}
      <div className="week-header">
        <div className="week-badge" style={{ borderColor: pColor }}>
          <span className="week-num">KW {weekNum}/{totalWeeks}</span>
          <span className="phase-tag" style={{ color: pColor }}>{phase}</span>
          <span className="planned-km">{plannedKm} km geplant</span>
        </div>
        <div className="today-label">{todayName}</div>
      </div>

      {/* Today's key workout */}
      {workout ? (
        <div className="workout-card">
          <div className="workout-header">
            <span className="workout-session">{workout.session}</span>
            <span className="workout-typ">{workout.typ}</span>
          </div>

          <div className="workout-stats">
            <div className="stat">
              <span className="stat-label">Distanz</span>
              <span className="stat-val">{typeof workout.distanzKm === 'number' ? `${workout.distanzKm} km` : workout.distanzKm}</span>
            </div>
            <div className="stat">
              <span className="stat-label">Dauer</span>
              <span className="stat-val">{workout.dauerMin}</span>
            </div>
            <div className="stat">
              <span className="stat-label">Tag</span>
              <span className="stat-val">{workout.wochentag}</span>
            </div>
          </div>

          <div className="workout-vorgabe">
            <span className="label-small">Vorgabe</span>
            <p>{workout.vorgabe}</p>
          </div>

          <div className="workout-struktur">
            <span className="label-small">Struktur</span>
            <p>{workout.struktur}</p>
          </div>

          <div className="workout-hinweis">
            <span className="hinweis-icon">💡</span>
            <p>{workout.hinweis}</p>
          </div>
        </div>
      ) : (
        <div className="workout-card empty">
          <p>Kein Trainingsplan gefunden. Bitte Renntermin in den Einstellungen eintragen.</p>
        </div>
      )}

      {/* Quick pace reference */}
      <div className="section-title">Pace-Referenz (VDOT {settings.vdot})</div>
      <div className="pace-grid">
        <PaceRow label="Easy" range={`${paces.E_high} – ${paces.E_low}`} color="#4CAF50" />
        <PaceRow label="Marathon-Pace" range={paces.M} color="#FFC107" />
        <PaceRow label="Schwelle (T)" range={paces.T} color="#FF9800" />
        <PaceRow label="Intervall (I)" range={paces.I} color="#e53935" />
      </div>

      {/* Race targets */}
      <div className="section-title">Renntermine</div>
      <div className="race-list">
        <RaceItem
          type={settings.raceType1 === 'hm' ? 'Halbmarathon' : 'Marathon'}
          date={raceDate1}
          icon={settings.raceType1 === 'hm' ? '🏃' : '🏁'}
        />
        <RaceItem
          type={settings.raceType2 === 'marathon' ? 'Marathon' : 'Halbmarathon'}
          date={raceDate2}
          icon="🏆"
        />
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
  const now = new Date()
  const diffMs = date.getTime() - now.getTime()
  const diffDays = Math.max(0, Math.ceil(diffMs / (24 * 3600 * 1000)))
  const diffWeeks = Math.floor(diffDays / 7)
  const dateStr = date.toLocaleDateString('de-AT', { day: '2-digit', month: 'short', year: 'numeric' })

  return (
    <div className="race-item">
      <span className="race-icon">{icon}</span>
      <div className="race-info">
        <span className="race-type">{type}</span>
        <span className="race-date">{dateStr}</span>
      </div>
      <div className="race-countdown">
        {diffDays === 0 ? (
          <span className="countdown-today">Heute!</span>
        ) : (
          <>
            <span className="countdown-weeks">{diffWeeks}W</span>
            <span className="countdown-days">{diffDays} Tage</span>
          </>
        )}
      </div>
    </div>
  )
}
