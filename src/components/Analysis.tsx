import { useState } from 'react'
import {
  getCachedActivities,
  parseRuns,
  parseAllActivities,
  computeWeeklyStats,
  computeWeeklyStatsBySport,
  vdotTrendFromActivities,
  thisWeekStatsBySport,
  computeAtlCtl,
  mondayOf,
  DAY_TAGS,
  fetchActivityStreams,
  fetchActivityLaps,
  detectStrides,
  type ActivitySummary,
  type StrideAnalysis,
} from '../lib/strava'
import { analyzeRun, analyzeRide, analyzeWorkoutLaps, type WorkoutLapAnalysis } from '../lib/vdot'
import { generatePlan, allWeekSessions, type PlanRow, type WorkoutSession } from '../lib/plan'
import type { AppSettings } from '../lib/storage'

interface Props {
  settings: AppSettings
  onGoToSettings: () => void
}

const ZONE_COLORS: Record<string, string> = {
  Z1: '#42A5F5', Z2: '#4CAF50', Z3: '#FFC107', Z4: '#FF9800', Z5: '#e53935',
}

function isoWeek(d: Date): string {
  const jan4   = new Date(d.getFullYear(), 0, 4)
  const start  = new Date(jan4)
  start.setDate(jan4.getDate() - ((jan4.getDay() + 6) % 7))
  const diff = d.getTime() - start.getTime()
  const week = Math.floor(diff / (7 * 24 * 3600 * 1000)) + 1
  return `KW${week}`
}

function getPlannedSession(plan: PlanRow[], date: Date, settings: AppSettings): WorkoutSession | null {
  const row = [...plan].reverse().find(r => r.weekStart <= date)
  if (!row) return null
  const sessions = allWeekSessions(row.phase, row.plannedKm, settings.vdot, settings.runsPerWeek, settings.raceType2)
  const tag = DAY_TAGS[date.getDay()]
  return sessions.find(s => s.wochentag === tag) ?? null
}

function getPhaseForDate(plan: PlanRow[], date: Date): string {
  const monday = mondayOf(date)
  const row = plan.find(r => {
    const ws = new Date(r.weekStart)
    ws.setHours(0, 0, 0, 0)
    return ws.getTime() === monday.getTime()
  })
  return row?.phase ?? 'Aufbau'
}

export default function Analysis({ settings, onGoToSettings }: Props) {
  const [expandedId, setExpandedId] = useState<number | null>(null)

  const cached      = getCachedActivities()
  const hasStrava   = cached.length > 0
  const runs        = parseRuns(cached)
  const allActs     = parseAllActivities(cached)
  const recentActs  = allActs.slice(0, 14)

  const raceDate2   = new Date(settings.raceDate2)
  const raceDate1   = new Date(settings.raceDate1)
  const preRaceDate = settings.preRaceEnabled ? raceDate1 : undefined
  const plan        = generatePlan(raceDate2, settings.currentWeeklyKm, settings.runsPerWeek, settings.raceType2, preRaceDate)
  const currentRow  = plan.find(r => r.isCurrent)

  const weeklyStats  = computeWeeklyStats(runs)
  const last8Weeks   = weeklyStats.slice(-8)
  const last12Weeks  = weeklyStats.slice(-12)
  const sportWeekly  = computeWeeklyStatsBySport(cached)
  const weekStats    = thisWeekStatsBySport(cached)

  const actualKmThisWeek = hasStrava ? weekStats.run.km : 0
  const plannedKm        = currentRow?.plannedKm ?? 0
  const progressPct      = plannedKm > 0 ? Math.min(100, (actualKmThisWeek / plannedKm) * 100) : 0
  const progressColor    = progressPct >= 80 ? '#4CAF50' : progressPct >= 50 ? '#FFC107' : '#e53935'

  // Build planned km map per week
  const planWeekMap = new Map<string, number>()
  for (const row of plan) {
    const key = row.weekStart.toISOString().slice(0, 10)
    planWeekMap.set(key, row.plannedKm)
  }

  const trend   = hasStrava
    ? vdotTrendFromActivities(runs, settings.vdot, settings.maxHr, settings.restHr)
    : null
  const tsbData = hasStrava ? computeAtlCtl(cached) : null

  // Max planned km for chart scaling
  const maxChartKm = Math.max(
    ...last8Weeks.map(w => {
      const key = w.weekStart.toISOString().slice(0, 10)
      return Math.max(w.actualKm, planWeekMap.get(key) ?? 0)
    }),
    1,
  )
  const maxChart12Km = Math.max(
    ...last12Weeks.map(w => {
      const key = w.weekStart.toISOString().slice(0, 10)
      return Math.max(w.actualKm, planWeekMap.get(key) ?? 0)
    }),
    1,
  )

  function toggleExpand(id: number) {
    setExpandedId(prev => (prev === id ? null : id))
  }

  if (!hasStrava) {
    return (
      <div className="tab-content">
        <div className="strava-connect" style={{ padding: '32px 0' }}>
          <div className="strava-logo">📊</div>
          <h3>Keine Strava-Daten</h3>
          <p>Verbinde Strava um Analysen, VDOT-Trends und Wochenauswertungen zu sehen.</p>
          <button className="btn-primary" onClick={onGoToSettings}>
            Zu den Einstellungen
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="tab-content">
      {/* A: Diese Woche */}
      <div className="section-title">Diese Woche</div>
      <div className="activity-card" style={{ padding: '12px' }}>
        <div className="kpi-row" style={{ marginBottom: '10px' }}>
          <div className="kpi-tile">
            <span className="kpi-value" style={{ color: progressColor }}>{actualKmThisWeek}</span>
            <span className="kpi-label">km gelaufen</span>
          </div>
          <div className="kpi-tile">
            <span className="kpi-value">{plannedKm}</span>
            <span className="kpi-label">km geplant</span>
          </div>
          <div className="kpi-tile">
            <span className="kpi-value">{weekStats.run.count}</span>
            <span className="kpi-label">Einheiten</span>
          </div>
          <div className="kpi-tile">
            <span className="kpi-value">{weekStats.run.elevationM}</span>
            <span className="kpi-label">m Höhe</span>
          </div>
        </div>
        <div style={{ fontSize: '12px', color: 'var(--text2)', marginBottom: '4px' }}>
          {actualKmThisWeek} km von {plannedKm} km ({Math.round(progressPct)}%)
        </div>
        <div className="progress-bar">
          <div
            className="progress-fill"
            style={{ width: `${progressPct}%`, background: progressColor }}
          />
        </div>
        {/* Cross-sport row */}
        {(weekStats.ride.count > 0 || weekStats.hike.count > 0 || weekStats.swim.count > 0) && (
          <div style={{ display: 'flex', gap: '14px', marginTop: '8px', flexWrap: 'wrap', fontSize: '12px', color: 'var(--text2)' }}>
            {weekStats.ride.count > 0 && (
              <span>🚴 <strong style={{ color: '#17a2b8' }}>{weekStats.ride.km} km</strong> · {Math.round(weekStats.ride.durationSec / 3600 * 10) / 10} h</span>
            )}
            {weekStats.hike.count > 0 && (
              <span>🥾 <strong style={{ color: '#28a745' }}>{weekStats.hike.km} km</strong> · ↑ {weekStats.hike.elevationM} m</span>
            )}
            {weekStats.swim.count > 0 && (
              <span>🏊 <strong style={{ color: '#00B4D8' }}>{weekStats.swim.km} km</strong></span>
            )}
          </div>
        )}
        {currentRow && (
          <div style={{ fontSize: '12px', color: 'var(--text2)', marginTop: '6px' }}>
            {currentRow.phase} · Woche {currentRow.weekNr}/{plan.length - 1}
          </div>
        )}
      </div>

      {/* B: Trainingsform (TSB) */}
      {tsbData && (() => {
        const { atl, ctl, tsb } = tsbData
        let tsbColor: string
        let tsbLabel: string
        let tsbIcon: string
        if      (tsb < -30) { tsbColor = '#e53935'; tsbLabel = 'Überbelastung';  tsbIcon = '🔴' }
        else if (tsb < 0)   { tsbColor = '#FFC107'; tsbLabel = 'Aufbau';         tsbIcon = '🟡' }
        else if (tsb <= 20) { tsbColor = '#4CAF50'; tsbLabel = 'Fit';            tsbIcon = '🟢' }
        else                { tsbColor = '#3b82f6'; tsbLabel = 'Rennform';       tsbIcon = '🏁' }
        return (
          <>
            <div className="section-title">Trainingsform (TSB)</div>
            <div className="activity-card" style={{ padding: '12px' }}>
              <div className="kpi-row" style={{ marginBottom: '10px' }}>
                <div className="kpi-tile">
                  <span className="kpi-value" style={{ color: tsbColor }}>{tsb > 0 ? '+' : ''}{tsb}</span>
                  <span className="kpi-label">TSB</span>
                </div>
                <div className="kpi-tile">
                  <span className="kpi-value">{ctl}</span>
                  <span className="kpi-label">CTL (42d)</span>
                </div>
                <div className="kpi-tile">
                  <span className="kpi-value">{atl}</span>
                  <span className="kpi-label">ATL (7d)</span>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ fontSize: '18px' }}>{tsbIcon}</span>
                <div>
                  <span style={{ fontSize: '14px', fontWeight: 700, color: tsbColor }}>{tsbLabel}</span>
                  <div style={{ fontSize: '11px', color: 'var(--text2)', marginTop: '2px' }}>
                    TSB = CTL − ATL · positiv = frisch, negativ = ermüdet
                  </div>
                </div>
              </div>
              {/* TSB scale bar */}
              <div style={{ marginTop: '10px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: 'var(--text2)', marginBottom: '3px' }}>
                  <span>−50</span>
                  <span>−30</span>
                  <span>0</span>
                  <span>+20</span>
                  <span>+50</span>
                </div>
                <div style={{ height: '6px', background: 'var(--surface2)', borderRadius: '3px', position: 'relative', overflow: 'visible' }}>
                  {/* Colored segments */}
                  <div style={{ position: 'absolute', left: '0%',   width: '20%', height: '100%', background: '#e5393533', borderRadius: '3px 0 0 3px' }} />
                  <div style={{ position: 'absolute', left: '20%',  width: '30%', height: '100%', background: '#FFC10733' }} />
                  <div style={{ position: 'absolute', left: '50%',  width: '20%', height: '100%', background: '#4CAF5033' }} />
                  <div style={{ position: 'absolute', left: '70%',  width: '30%', height: '100%', background: '#3b82f633', borderRadius: '0 3px 3px 0' }} />
                  {/* Marker */}
                  <div style={{
                    position: 'absolute',
                    left: `${Math.min(100, Math.max(0, ((tsb + 50) / 100) * 100))}%`,
                    top: '-3px',
                    width: '4px',
                    height: '12px',
                    background: tsbColor,
                    borderRadius: '2px',
                    transform: 'translateX(-50%)',
                  }} />
                </div>
              </div>
            </div>
          </>
        )
      })()}

      {/* D: Fitnesstrend */}
      {trend && (
        <>
          <div className="section-title">Fitnesstrend</div>

          {/* VDOT trend — only shown when effort runs are available */}
          {!trend.insufficientEffortRuns ? (
            <div className="activity-card" style={{ padding: '12px' }}>
              <div style={{ fontSize: '11px', color: 'var(--text2)', marginBottom: '4px', fontWeight: 600, letterSpacing: '0.04em' }}>VDOT AUS TEMPOLÄUFEN</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <div className="trend-badge" style={{ background: `${trend.color}22`, color: trend.color }}>
                  <span>{trend.direction}</span>
                  <span>{trend.label}</span>
                </div>
              </div>
              <div style={{ fontSize: '13px', color: 'var(--text2)', marginTop: '8px', display: 'flex', gap: '16px' }}>
                <span>Früher: {trend.early}</span>
                <span>Aktuell: {trend.recent}</span>
                <span style={{ color: trend.color }}>Δ {trend.delta > 0 ? '+' : ''}{trend.delta}</span>
              </div>
              {trend.fromTraining && (
                <div style={{ fontSize: '11px', color: 'var(--text2)', marginTop: '4px' }}>
                  Aus Trainingsläufen — genauer nach Wettkampf- oder Tempoeinheiten
                </div>
              )}
            </div>
          ) : (
            <div className="activity-card" style={{ padding: '10px 12px', fontSize: '12px', color: 'var(--text2)' }}>
              VDOT-Trend folgt ab der Aufbauphase — wird aus Tempo- und Intervallläufen berechnet, nicht aus Easy-Läufen.
            </div>
          )}

          {/* Easy-run HR trend — aerobic efficiency (Basis phase signal) */}
          {trend.easyHrTrend && (() => {
            const hr = trend.easyHrTrend!
            return (
              <div className="activity-card" style={{ padding: '12px', marginTop: '6px' }}>
                <div style={{ fontSize: '11px', color: 'var(--text2)', marginBottom: '4px', fontWeight: 600, letterSpacing: '0.04em' }}>AEROBE EFFIZIENZ (EASY-LÄUFE)</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <div className="trend-badge" style={{ background: `${hr.color}22`, color: hr.color }}>
                    <span>{hr.direction}</span>
                    <span>{hr.label}</span>
                  </div>
                </div>
                <div style={{ fontSize: '13px', color: 'var(--text2)', marginTop: '8px', display: 'flex', gap: '16px' }}>
                  <span>Früher: Ø {hr.earlyAvgHr} bpm</span>
                  <span>Aktuell: Ø {hr.recentAvgHr} bpm</span>
                  <span style={{ color: hr.color }}>Δ {hr.deltaBpm > 0 ? '+' : ''}{hr.deltaBpm} bpm</span>
                </div>
                <div style={{ fontSize: '11px', color: 'var(--text2)', marginTop: '4px' }}>
                  Niedrigerer Puls bei gleicher Easy-Pace = aerobe Adaptation ✓
                </div>
              </div>
            )
          })()}
        </>
      )}

      {/* C: Coach-Auswertung */}
      <div className="section-title">Coach-Auswertung (letzte 14)</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        {recentActs.length === 0 && (
          <div style={{ fontSize: '13px', color: 'var(--text2)', padding: '12px 0' }}>
            Keine Aktivitäten vorhanden.
          </div>
        )}
        {recentActs.map(act => {
          const isExpanded = expandedId === act.id
          const phase          = getPhaseForDate(plan, act.date)
          const plannedSession = getPlannedSession(plan, act.date, settings)

          let analysis: ReturnType<typeof analyzeRun> | ReturnType<typeof analyzeRide> | null = null
          let zoneBadgeColor = '#42A5F5'
          let zoneBadgeLabel = ''

          if (act.actType === 'run') {
            const isWorkout = (act.workoutType ?? 0) > 1
            analysis = analyzeRun(
              act.paceSec,
              act.distanceKm,
              act.avgHr,
              act.maxHr,
              settings.vdot,
              settings.maxHr,
              settings.restHr,
              phase,
              isWorkout,
              act.isTrail,
              act.tempC,
            )
            const ra = analysis as ReturnType<typeof analyzeRun>
            zoneBadgeColor = ra.zoneColor
            zoneBadgeLabel = ra.zoneCode
          } else if (act.actType === 'ride') {
            analysis = analyzeRide(
              act.durationSec,
              act.speedKmh ?? 0,
              act.avgHr,
              settings.maxHr,
              settings.restHr,
            )
            const rideA = analysis as ReturnType<typeof analyzeRide>
            zoneBadgeColor = rideA.color
            zoneBadgeLabel = rideA.hrZoneCode
          } else {
            zoneBadgeLabel = 'Hike'
            zoneBadgeColor = '#9C27B0'
          }

          const dateStr = act.date.toLocaleDateString('de-AT', { day: '2-digit', month: 'short' })
          const actIcon = act.isTrail ? '🏔️' : act.actType === 'run' ? '🏃' : act.actType === 'ride' ? '🚴' : '🥾'

          return (
            <div key={act.id} className="activity-card">
              <div
                className="activity-header"
                onClick={() => toggleExpand(act.id)}
              >
                <span style={{ fontSize: '16px' }}>{actIcon}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: '13px', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {act.name}
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--text2)' }}>
                    {dateStr} ·{' '}
                    {act.actType === 'ride'
                      ? `${act.durationSec > 0 ? Math.round(act.durationSec / 60) : 0} min`
                      : `${act.distanceKm} km`}
                    {act.avgHr ? ` · ♡ ${Math.round(act.avgHr)}` : ''}
                  </div>
                </div>
                <div
                  style={{
                    fontSize: '11px',
                    fontWeight: 700,
                    padding: '3px 8px',
                    borderRadius: '12px',
                    background: `${zoneBadgeColor}22`,
                    color: zoneBadgeColor,
                    whiteSpace: 'nowrap',
                    flexShrink: 0,
                  }}
                >
                  {zoneBadgeLabel}
                </div>
                <span style={{ fontSize: '10px', color: 'var(--text2)', marginLeft: '4px' }}>
                  {isExpanded ? '▲' : '▼'}
                </span>
              </div>

              {isExpanded && analysis && (
                <div className="activity-detail">
                  {act.actType === 'run' ? (
                    <RunDetail
                      analysis={analysis as ReturnType<typeof analyzeRun>}
                      act={act}
                      phase={phase}
                      plannedSession={plannedSession}
                      vdot={settings.vdot}
                    />
                  ) : act.actType === 'ride' ? (
                    <RideDetail analysis={analysis as ReturnType<typeof analyzeRide>} act={act} />
                  ) : (
                    <div style={{ fontSize: '13px', color: 'var(--text2)' }}>
                      Wanderung · {act.distanceKm} km · {act.elevationM} m Höhe
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {/* D: Wöchentliche Km */}
      {last8Weeks.length > 0 && (
        <>
          <div className="section-title">Wöchentliche km (letzte 8 Wochen)</div>

          <div className="activity-card" style={{ padding: '12px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'var(--text2)', marginBottom: '8px' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                <span style={{ display: 'inline-block', width: '10px', height: '6px', background: 'var(--border)', borderRadius: '3px' }} />
                Geplant
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                <span style={{ display: 'inline-block', width: '10px', height: '6px', background: 'var(--accent)', borderRadius: '3px' }} />
                Gelaufen
              </span>
            </div>
            <div className="weekly-chart">
              {last8Weeks.map(week => {
                const key        = week.weekStart.toISOString().slice(0, 10)
                const plannedW   = planWeekMap.get(key) ?? 0
                const actualW    = week.actualKm
                const planBarPct  = Math.min(100, (plannedW / maxChartKm) * 100)
                const actBarPct   = Math.min(100, (actualW  / maxChartKm) * 100)
                return (
                  <div key={key} className="weekly-chart-row">
                    <div className="weekly-chart-label">{isoWeek(week.weekStart)}</div>
                    <div className="weekly-chart-bars">
                      <div className="chart-bar-planned" style={{ width: `${planBarPct}%` }} />
                      <div className="chart-bar-actual"  style={{ width: `${actBarPct}%`  }} />
                    </div>
                    <div className="weekly-chart-km">
                      <span style={{ color: 'var(--accent)', fontWeight: 700 }}>{actualW}</span>
                      <span style={{ color: 'var(--text2)' }}>/{plannedW > 0 ? plannedW : '—'}</span>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </>
      )}

      {/* E: Langzeit-Statistiken */}
      {weeklyStats.length >= 4 && (() => {
        const totalKm    = Math.round(weeklyStats.reduce((s, w) => s + w.actualKm, 0))
        const avgKmWeek  = Math.round(totalKm / weeklyStats.length * 10) / 10
        const maxKmWeek  = Math.max(...weeklyStats.map(w => w.actualKm))
        const peakWeek   = weeklyStats.find(w => w.actualKm === maxKmWeek)
        return (
          <>
            <div className="section-title">Langzeit-Statistiken (52 Wochen)</div>
            <div className="activity-card" style={{ padding: '12px' }}>
              <div className="kpi-row" style={{ marginBottom: '10px' }}>
                <div className="kpi-tile">
                  <span className="kpi-value">{avgKmWeek}</span>
                  <span className="kpi-label">Ø km/Woche</span>
                </div>
                <div className="kpi-tile">
                  <span className="kpi-value">{maxKmWeek}</span>
                  <span className="kpi-label">Max km/Woche</span>
                </div>
                <div className="kpi-tile">
                  <span className="kpi-value">{totalKm}</span>
                  <span className="kpi-label">Gesamt km</span>
                </div>
                <div className="kpi-tile">
                  <span className="kpi-value">{weeklyStats.length}</span>
                  <span className="kpi-label">Aktive Wochen</span>
                </div>
              </div>
              {peakWeek && (
                <div style={{ fontSize: '11px', color: 'var(--text2)', marginBottom: '8px' }}>
                  Aktivste Woche: {isoWeek(peakWeek.weekStart)} · {peakWeek.actualKm} km
                </div>
              )}
              {/* Extended 12-week chart */}
              <div className="weekly-chart">
                {last12Weeks.map(week => {
                  const key       = week.weekStart.toISOString().slice(0, 10)
                  const plannedW  = planWeekMap.get(key) ?? 0
                  const planPct   = Math.min(100, (plannedW / maxChart12Km) * 100)
                  const actPct    = Math.min(100, (week.actualKm / maxChart12Km) * 100)
                  return (
                    <div key={key} className="weekly-chart-row">
                      <div className="weekly-chart-label">{isoWeek(week.weekStart)}</div>
                      <div className="weekly-chart-bars">
                        <div className="chart-bar-planned" style={{ width: `${planPct}%` }} />
                        <div className="chart-bar-actual"  style={{ width: `${actPct}%`  }} />
                      </div>
                      <div className="weekly-chart-km">
                        <span style={{ color: 'var(--accent)', fontWeight: 700 }}>{week.actualKm}</span>
                        <span style={{ color: 'var(--text2)' }}>/{plannedW > 0 ? plannedW : '—'}</span>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          </>
        )
      })()}

      {/* F: Trainingsverteilung */}
      {sportWeekly.length > 0 && (() => {
        const runKmTotal  = Math.round(sportWeekly.reduce((s, w) => s + w.runKm,  0))
        const rideKmTotal = Math.round(sportWeekly.reduce((s, w) => s + w.rideKm, 0))
        const hikeKmTotal = Math.round(sportWeekly.reduce((s, w) => s + w.hikeKm, 0))
        const runH  = Math.round(sportWeekly.reduce((s, w) => s + w.runH,  0) * 10) / 10
        const rideH = Math.round(sportWeekly.reduce((s, w) => s + w.rideH, 0) * 10) / 10
        const hikeH = Math.round(sportWeekly.reduce((s, w) => s + w.hikeH, 0) * 10) / 10
        const totalKm = runKmTotal + rideKmTotal + hikeKmTotal
        if (totalKm === 0) return null
        const sports = [
          { icon: '🏃', label: 'Laufen',    km: runKmTotal,  h: runH,  color: 'var(--accent)' },
          { icon: '🚴', label: 'Radfahren', km: rideKmTotal, h: rideH, color: '#17a2b8' },
          { icon: '🥾', label: 'Wandern',   km: hikeKmTotal, h: hikeH, color: '#28a745' },
        ].filter(s => s.km > 0)
        return (
          <>
            <div className="section-title">Trainingsverteilung (52 Wochen)</div>
            <div className="activity-card" style={{ padding: '12px' }}>
              {sports.map(sport => (
                <div key={sport.label} style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px' }}>
                  <span style={{ fontSize: '18px', width: '26px' }}>{sport.icon}</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', marginBottom: '3px' }}>
                      <span style={{ fontWeight: 600 }}>{sport.label}</span>
                      <span style={{ color: 'var(--text2)' }}>{sport.km} km · {sport.h} h</span>
                    </div>
                    <div style={{ height: '6px', background: 'var(--surface2)', borderRadius: '3px', overflow: 'hidden' }}>
                      <div style={{ height: '100%', background: sport.color, borderRadius: '3px', width: `${Math.min(100, sport.km / totalKm * 100)}%` }} />
                    </div>
                  </div>
                  <span style={{ fontSize: '11px', color: 'var(--text2)', minWidth: '34px', textAlign: 'right' }}>
                    {Math.round(sport.km / totalKm * 100)}%
                  </span>
                </div>
              ))}
            </div>
          </>
        )
      })()}

      {/* G: Pace/HF-Trend-Tabelle */}
      {weeklyStats.length >= 4 && (() => {
        const trendRows = weeklyStats.filter(w => w.runs > 0).slice(-12)
        if (trendRows.length < 4) return null
        return (
          <>
            <div className="section-title">Pace &amp; HF-Trend (letzte Wochen)</div>
            <div className="activity-card" style={{ padding: '12px', overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px' }}>
                <thead>
                  <tr style={{ color: 'var(--text2)' }}>
                    <th style={{ textAlign: 'left',  padding: '3px 4px', fontWeight: 600 }}>Woche</th>
                    <th style={{ textAlign: 'right', padding: '3px 4px', fontWeight: 600 }}>km</th>
                    <th style={{ textAlign: 'right', padding: '3px 4px', fontWeight: 600 }}>Läufe</th>
                    <th style={{ textAlign: 'right', padding: '3px 4px', fontWeight: 600 }}>Ø Pace</th>
                    <th style={{ textAlign: 'right', padding: '3px 4px', fontWeight: 600 }}>Ø HF</th>
                  </tr>
                </thead>
                <tbody>
                  {trendRows.map(w => {
                    const key = w.weekStart.toISOString().slice(0, 10)
                    const isCurrent = planWeekMap.has(key)
                    return (
                      <tr key={key} style={{ borderTop: '1px solid var(--border)' }}>
                        <td style={{ padding: '4px', color: isCurrent ? 'var(--accent)' : 'var(--text2)', fontWeight: isCurrent ? 700 : 400 }}>{isoWeek(w.weekStart)}</td>
                        <td style={{ padding: '4px', textAlign: 'right', fontWeight: 600 }}>{w.actualKm}</td>
                        <td style={{ padding: '4px', textAlign: 'right', color: 'var(--text2)' }}>{w.runs}</td>
                        <td style={{ padding: '4px', textAlign: 'right' }}>{w.avgPaceSec ? fmt(w.avgPaceSec) : '—'}</td>
                        <td style={{ padding: '4px', textAlign: 'right' }}>{w.avgHr ? Math.round(w.avgHr) : '—'}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </>
        )
      })()}

      {/* H: Wandern & Trekking */}
      {(() => {
        const hikeActs = allActs.filter(a => a.actType === 'hike')
        if (hikeActs.length === 0) return null
        const hikeKmTotal  = Math.round(hikeActs.reduce((s, a) => s + a.distanceKm, 0))
        const hikeElevTotal = Math.round(hikeActs.reduce((s, a) => s + a.elevationM, 0))
        return (
          <>
            <div className="section-title">🥾 Wandern &amp; Trekking (52 Wochen)</div>
            <div className="activity-card" style={{ padding: '12px' }}>
              <div className="kpi-row">
                <div className="kpi-tile">
                  <span className="kpi-value">{hikeActs.length}</span>
                  <span className="kpi-label">Wanderungen</span>
                </div>
                <div className="kpi-tile">
                  <span className="kpi-value">{hikeKmTotal}</span>
                  <span className="kpi-label">km gesamt</span>
                </div>
                <div className="kpi-tile">
                  <span className="kpi-value">{hikeElevTotal}</span>
                  <span className="kpi-label">m Höhe gesamt</span>
                </div>
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text2)', marginTop: '8px' }}>
                💡 Wandern zählt als aerobe Zusatzbelastung — Höhenmeter stärken die kardiale Grundlage.
              </div>
            </div>
          </>
        )
      })()}
    </div>
  )
}

const ZONE_LABELS_SHORT: Record<string, string> = {
  Z1: 'Z1 · Regeneration', Z2: 'Z2 · Grundlage', Z3: 'Z3 · Aerob',
  Z4: 'Z4 · Schwelle', Z5: 'Z5 · Maximal',
}

function fmt(s: number) {
  const m = Math.floor(s / 60); const sec = Math.round(s % 60)
  return `${m}:${sec.toString().padStart(2, '0')}`
}

function planCheck(planned: WorkoutSession, act: ActivitySummary, strideData: StrideAnalysis | null, analysis: ReturnType<typeof analyzeRun>): { icon: string; text: string; color: string }[] {
  const checks: { icon: string; text: string; color: string }[] = []
  const sessionName = planned.session.toLowerCase()
  const plannedKm = typeof planned.distanzKm === 'number' ? planned.distanzKm : parseFloat(String(planned.distanzKm))

  // Distance check
  if (!isNaN(plannedKm) && plannedKm > 0) {
    const pct = act.distanceKm / plannedKm
    if (pct >= 0.90)       checks.push({ icon: '✅', text: `Distanz: ${act.distanceKm} km (geplant ${plannedKm} km)`, color: '#4CAF50' })
    else if (pct >= 0.75)  checks.push({ icon: '🟡', text: `Distanz: ${act.distanceKm} km — etwas kürzer als geplant ${plannedKm} km`, color: '#FFC107' })
    else                   checks.push({ icon: '⚠️', text: `Distanz: nur ${act.distanceKm} km von ${plannedKm} km`, color: '#e53935' })
  }

  // Stride count check
  const strideMatch = planned.session.match(/(\d+)[×x]/)
  if (strideMatch && strideData) {
    const targetN = parseInt(strideMatch[1])
    const actualN = strideData.strideCount
    if (actualN >= targetN)          checks.push({ icon: '✅', text: `Strides: ${actualN} erkannt (${targetN} geplant)`, color: '#4CAF50' })
    else if (actualN >= targetN - 1) checks.push({ icon: '🟡', text: `Strides: ${actualN} erkannt (${targetN} geplant — fast vollständig)`, color: '#FFC107' })
    else                             checks.push({ icon: '⚠️', text: `Strides: nur ${actualN} erkannt (${targetN} geplant)`, color: '#e53935' })
  } else if (strideMatch && !strideData) {
    const targetN = parseInt(strideMatch[1])
    checks.push({ icon: '📈', text: `${targetN} Strides geplant — Pace-Verlauf laden um zu prüfen`, color: '#FF9800' })
  }

  // Recovery pattern check (for stride sessions)
  if (strideData && strideData.avgRecoverySec !== null && sessionName.includes('stride')) {
    const rec = strideData.avgRecoverySec
    if (rec >= 35 && rec <= 70) checks.push({ icon: '✅', text: `Erholung Ø ${rec} s zwischen Strides — ideal`, color: '#4CAF50' })
    else if (rec < 35)          checks.push({ icon: '🟡', text: `Erholung Ø ${rec} s — etwas kurz, min. 35 s empfohlen`, color: '#FFC107' })
    else                        checks.push({ icon: '🟡', text: `Erholung Ø ${rec} s — sehr locker, passt`, color: '#4CAF50' })
  }

  // Tempo session check (e.g. "7km easy + 3km M-Pace")
  if ((sessionName.includes('marathon-pace') || sessionName.includes('m-pace') || sessionName.includes('tempo')) && !sessionName.includes('stride')) {
    if (analysis.zoneCode === 'M' || analysis.zoneCode === 'T') {
      checks.push({ icon: '✅', text: `Tempo korrekt — Pace im ${analysis.zoneName}-Bereich`, color: '#4CAF50' })
    } else if (analysis.zoneCode === 'E') {
      checks.push({ icon: '🟡', text: `Durchschnitt Easy — Tempo-Abschnitt evtl. kürzer als geplant`, color: '#FFC107' })
    }
  }

  return checks
}

function RunDetail({
  analysis,
  act,
  phase,
  plannedSession,
  vdot,
}: {
  analysis: ReturnType<typeof analyzeRun>
  act: ActivitySummary
  phase: string
  plannedSession: WorkoutSession | null
  vdot: number
}) {
  const [strideData,    setStrideData]    = useState<StrideAnalysis | null>(null)
  const [loadingStream, setLoadingStream] = useState(false)
  const [streamErr,     setStreamErr]     = useState<string | null>(null)
  const [lapData,       setLapData]       = useState<WorkoutLapAnalysis | null>(null)
  const [loadingLaps,   setLoadingLaps]   = useState(false)
  const [lapErr,        setLapErr]        = useState<string | null>(null)

  async function loadLaps(vdot: number) {
    setLoadingLaps(true); setLapErr(null)
    try {
      const laps = await fetchActivityLaps(act.id)
      if (!laps || laps.length === 0) { setLapErr('Keine Lap-Daten verfügbar — bitte Lap-Taste auf der Uhr nutzen.'); return }
      const result = analyzeWorkoutLaps(laps, vdot)
      if (!result) setLapErr('Zu wenige Laps für Intervallauswertung.')
      else         setLapData(result)
    } catch { setLapErr('Fehler beim Laden der Lap-Daten.') }
    finally   { setLoadingLaps(false) }
  }

  async function loadStreams() {
    setLoadingStream(true); setStreamErr(null)
    try {
      const streams = await fetchActivityStreams(act.id)
      if (!streams || streams.velocity_smooth.length === 0) {
        setStreamErr('Keine Stream-Daten verfügbar.')
      } else {
        setStrideData(detectStrides(streams, act.paceSec))
      }
    } catch { setStreamErr('Fehler beim Laden der Stream-Daten.') }
    finally { setLoadingStream(false) }
  }

  const durationMin = act.durationSec > 0 ? Math.round(act.durationSec / 60) : null
  return (
    <>
      {/* Verdict row */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px' }}>
        <div>
          <div style={{ fontSize: '14px', fontWeight: 700 }}>{analysis.verdict}</div>
          <div style={{ fontSize: '12px', color: 'var(--text2)', marginTop: '3px' }}>{analysis.note}</div>
        </div>
        <div style={{
          fontSize: '11px', padding: '3px 8px', borderRadius: '12px',
          background: `${analysis.zoneColor}22`, color: analysis.zoneColor, whiteSpace: 'nowrap', flexShrink: 0,
        }}>
          {analysis.zoneName}
        </div>
      </div>

      {/* Temperature adjustment note */}
      {analysis.tempNote && (
        <div style={{ fontSize: '11px', color: '#FF9800', marginTop: '4px', lineHeight: 1.4 }}>
          {analysis.tempNote}
        </div>
      )}

      {/* Key metrics grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '6px', marginTop: '6px' }}>
        <div style={{ background: 'var(--surface2)', borderRadius: '6px', padding: '6px 8px' }}>
          <div style={{ fontSize: '10px', color: 'var(--text2)', marginBottom: '2px' }}>
            Ø Pace{act.tempC !== undefined ? ` · ${Math.round(act.tempC)}°C` : ''}
          </div>
          <div style={{ fontSize: '13px', fontWeight: 700 }}>{act.paceFmt} /km</div>
          <div style={{ fontSize: '10px', color: 'var(--text2)' }}>
            {analysis.adjPaceSec
              ? `≈ ${Math.floor(analysis.adjPaceSec / 60)}:${String(Math.round(analysis.adjPaceSec % 60)).padStart(2, '0')} bereinigt`
              : `Abw. E-Mitte: ${analysis.devStr}`}
          </div>
        </div>
        <div style={{ background: 'var(--surface2)', borderRadius: '6px', padding: '6px 8px' }}>
          <div style={{ fontSize: '10px', color: 'var(--text2)', marginBottom: '2px' }}>Ø Herzfrequenz</div>
          <div style={{ fontSize: '13px', fontWeight: 700 }}>{act.avgHr ? `${Math.round(act.avgHr)} bpm` : '—'}</div>
          <div style={{ fontSize: '10px', color: analysis.hrZone ? (ZONE_COLORS[analysis.hrZone] ?? 'var(--text2)') : 'var(--text2)' }}>
            {analysis.hrZone ? ZONE_LABELS_SHORT[analysis.hrZone] ?? analysis.hrZone : '—'}
          </div>
        </div>
        <div style={{ background: 'var(--surface2)', borderRadius: '6px', padding: '6px 8px' }}>
          <div style={{ fontSize: '10px', color: 'var(--text2)', marginBottom: '2px' }}>HF-Max</div>
          <div style={{ fontSize: '13px', fontWeight: 700 }}>{act.maxHr ? `${Math.round(act.maxHr)} bpm` : '—'}</div>
          <div style={{ fontSize: '10px', color: analysis.maxHrZone ? (ZONE_COLORS[analysis.maxHrZone] ?? 'var(--text2)') : 'var(--text2)' }}>
            {analysis.maxHrZone ? `${ZONE_LABELS_SHORT[analysis.maxHrZone] ?? analysis.maxHrZone} · ${analysis.maxHrPct}% HFR` : '—'}
          </div>
        </div>
      </div>

      {/* Stride detection block */}
      {analysis.strideDetected && (
        <div style={{ background: '#FF980022', border: '1px solid #FF980044', borderRadius: '6px', padding: '8px 10px', fontSize: '12px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
            <span style={{ fontWeight: 700, color: '#FF9800' }}>⚡ Stride-Analyse</span>
            {!strideData && (
              <button
                style={{ fontSize: '11px', padding: '2px 8px', borderRadius: '8px', border: '1px solid #FF9800', background: 'transparent', color: '#FF9800', cursor: 'pointer' }}
                onClick={loadStreams}
                disabled={loadingStream}
              >
                {loadingStream ? '⏳ Lädt…' : '📈 Pace-Verlauf laden'}
              </button>
            )}
          </div>
          <div style={{ color: 'var(--text2)', lineHeight: 1.5 }}>
            <span style={{ color: 'var(--text1)' }}>HF-Spitzen: +{analysis.hrSpikeBpm} bpm</span> über Ø — Intensitätsspitzen bestätigt.{' '}
            HF-Max ({act.maxHr ? `${Math.round(act.maxHr)} bpm` : '—'}) {analysis.maxHrZone ?? ''} ({analysis.maxHrPct}% HFR).
          </div>
          {streamErr && <div style={{ color: '#e53935', fontSize: '11px', marginTop: '4px' }}>{streamErr}</div>}

          {/* Stream-based stride results */}
          {strideData && (
            <div style={{ marginTop: '8px', borderTop: '1px solid #FF980033', paddingTop: '8px' }}>
              <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', marginBottom: '6px' }}>
                <span><strong style={{ color: '#FF9800' }}>{strideData.strideCount}</strong> <span style={{ color: 'var(--text2)' }}>Strides erkannt</span></span>
                {strideData.fastestPaceSec > 0 && (
                  <span><strong style={{ color: '#FF9800' }}>{fmt(strideData.fastestPaceSec)}</strong> <span style={{ color: 'var(--text2)' }}>/km schnellste</span></span>
                )}
                {strideData.avgPeakPaceSec > 0 && (
                  <span><strong style={{ color: '#FF9800' }}>{fmt(strideData.avgPeakPaceSec)}</strong> <span style={{ color: 'var(--text2)' }}>/km Ø Peak</span></span>
                )}
              </div>
              {strideData.strides.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
                  {strideData.strides.map((s, i) => (
                    <div key={i} style={{ display: 'flex', gap: '8px', fontSize: '11px', color: 'var(--text2)', alignItems: 'center' }}>
                      <span style={{ color: '#FF9800', fontWeight: 700, minWidth: '18px' }}>#{i + 1}</span>
                      <span>{s.distanceM} m</span>
                      <span>{s.durationSec} s</span>
                      <span style={{ color: 'var(--text1)' }}>⚡ {fmt(s.peakPaceSec)} /km</span>
                      {s.peakHr && <span>♡ {s.peakHr}</span>}
                    </div>
                  ))}
                </div>
              )}
              {strideData.strideCount === 0 && (
                <div style={{ color: 'var(--text2)', fontSize: '11px' }}>
                  Keine klaren Pace-Spitzen im Stream erkannt. GPS-Genauigkeit oder sehr kurze Strides können Erkennung erschweren.
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Stream load button for non-stride runs */}
      {!analysis.strideDetected && !strideData && (
        <button
          style={{ fontSize: '11px', padding: '3px 10px', borderRadius: '8px', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text2)', cursor: 'pointer', alignSelf: 'flex-start' }}
          onClick={loadStreams}
          disabled={loadingStream}
        >
          {loadingStream ? '⏳ Lädt…' : '📈 Pace-Verlauf analysieren'}
        </button>
      )}
      {!analysis.strideDetected && strideData && strideData.strideCount > 0 && (
        <div style={{ background: 'var(--surface2)', borderRadius: '6px', padding: '8px 10px', fontSize: '12px' }}>
          <div style={{ fontWeight: 700, marginBottom: '4px' }}>📈 Pace-Spitzen</div>
          {strideData.strides.map((s, i) => (
            <div key={i} style={{ display: 'flex', gap: '8px', fontSize: '11px', color: 'var(--text2)', alignItems: 'center' }}>
              <span style={{ color: 'var(--accent)', fontWeight: 700, minWidth: '18px' }}>#{i + 1}</span>
              <span>{s.distanceM} m</span>
              <span>{s.durationSec} s</span>
              <span style={{ color: 'var(--text1)' }}>⚡ {fmt(s.peakPaceSec)} /km</span>
              {s.peakHr && <span>♡ {s.peakHr}</span>}
            </div>
          ))}
        </div>
      )}

      {/* Workout Lap Analysis */}
      {(act.workoutType ?? 0) > 1 && (
        <div style={{ background: '#FFC10722', border: '1px solid #FFC10744', borderRadius: '6px', padding: '8px 10px', fontSize: '12px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: lapData ? '8px' : '0' }}>
            <span style={{ fontWeight: 700, color: '#FFC107' }}>🏋️ Intervallauswertung</span>
            {!lapData && (
              <button
                style={{ fontSize: '11px', padding: '2px 8px', borderRadius: '8px', border: '1px solid #FFC107', background: 'transparent', color: '#FFC107', cursor: 'pointer' }}
                onClick={() => loadLaps(vdot)}
                disabled={loadingLaps}
              >
                {loadingLaps ? '⏳ Lädt…' : '📊 Laps laden'}
              </button>
            )}
          </div>
          {lapErr && <div style={{ color: '#e53935', fontSize: '11px' }}>{lapErr}</div>}
          {lapData && (
            <>
              {lapData.isAutoSplit ? (
                <div style={{ color: 'var(--text2)', fontSize: '11px' }}>
                  ℹ️ Nur automatische 1km-Splits erkannt — für Intervallauswertung bitte Lap-Taste auf der Uhr drücken.
                </div>
              ) : (
                <>
                  <div style={{ color: 'var(--text2)', marginBottom: '6px', lineHeight: 1.5 }}>
                    {lapData.wuNote} · {lapData.cdNote}<br />{lapData.rvNote}
                  </div>
                  {lapData.nIntervals > 0 && (
                    <div style={{ borderTop: '1px solid #FFC10733', paddingTop: '6px' }}>
                      <div style={{ fontSize: '10px', color: 'var(--text2)', marginBottom: '4px', fontWeight: 600 }}>
                        {lapData.nIntervals} INTERVALLE · ZIEL {lapData.iPaceTarget} /km
                      </div>
                      {lapData.intervals.map((iv, i) => (
                        <div key={i} style={{ lineHeight: 1.6, color: iv.dev <= 6 ? '#4CAF50' : iv.dev > 15 ? '#e53935' : '#FFC107' }}>
                          #{i + 1} {iv.verdict}{iv.hrStr}
                        </div>
                      ))}
                    </div>
                  )}
                  {lapData.laps.length > 0 && (
                    <div style={{ marginTop: '8px', borderTop: '1px solid #FFC10733', paddingTop: '6px' }}>
                      <div style={{ fontSize: '10px', color: 'var(--text2)', marginBottom: '4px', fontWeight: 600 }}>ALLE LAPS</div>
                      {lapData.laps.map((lp, i) => {
                        const roleColor: Record<string, string> = { warmup: '#42A5F5', interval: '#e53935', recovery: '#4CAF50', cooldown: '#42A5F5', easy: 'var(--text2)' }
                        return (
                          <div key={i} style={{ display: 'flex', gap: '8px', fontSize: '11px', color: 'var(--text2)', alignItems: 'center', lineHeight: 1.7 }}>
                            <span style={{ color: roleColor[lp.role] ?? 'var(--text2)', minWidth: '18px', fontWeight: 600 }}>#{lp.idx}</span>
                            <span style={{ color: roleColor[lp.role], fontSize: '10px', minWidth: '56px' }}>{lp.role}</span>
                            <span style={{ color: 'var(--text1)', fontWeight: lp.role === 'interval' ? 700 : 400 }}>{lp.paceFmt}</span>
                            <span>{lp.distKm} km</span>
                            {lp.avgHr && <span>♡ {Math.round(lp.avgHr)}</span>}
                          </div>
                        )
                      })}
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </div>
      )}

      {/* Plan-Check */}
      {plannedSession && (() => {
        const checks = planCheck(plannedSession, act, strideData, analysis)
        if (checks.length === 0) return null
        return (
          <div style={{ background: 'var(--surface2)', borderRadius: '6px', padding: '8px 10px', fontSize: '12px' }}>
            <div style={{ fontWeight: 700, marginBottom: '4px', fontSize: '11px', color: 'var(--text2)' }}>
              PLAN-CHECK · {plannedSession.session}
            </div>
            {checks.map((c, i) => (
              <div key={i} style={{ color: c.color, lineHeight: 1.6 }}>{c.icon} {c.text}</div>
            ))}
          </div>
        )
      })()}

      {/* Secondary info */}
      <div style={{ fontSize: '11px', color: 'var(--text2)', display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
        <span>Phase: {phase}</span>
        {act.distanceKm > 0 && <span>{act.distanceKm} km</span>}
        {durationMin && <span>{durationMin} min</span>}
        {act.elevationM > 0 && <span>↑ {act.elevationM} m</span>}
      </div>

      {/* HR note (non-stride mismatch) */}
      {analysis.hrNote && !analysis.strideDetected && (
        <div style={{ fontSize: '12px', color: 'var(--text2)', fontStyle: 'italic' }}>
          💬 {analysis.hrNote}
        </div>
      )}
    </>
  )
}

function RideDetail({
  analysis,
  act,
}: {
  analysis: ReturnType<typeof analyzeRide>
  act: ActivitySummary
}) {
  const durationMin = Math.round(act.durationSec / 60)
  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px' }}>
        <div>
          <div style={{ fontSize: '14px', fontWeight: 700 }}>{analysis.verdict}</div>
          <div style={{ fontSize: '12px', color: 'var(--text2)', marginTop: '3px' }}>{analysis.note}</div>
        </div>
        <div
          style={{
            fontSize: '11px',
            padding: '3px 8px',
            borderRadius: '12px',
            background: `${analysis.color}22`,
            color: analysis.color,
            whiteSpace: 'nowrap',
            flexShrink: 0,
          }}
        >
          {analysis.hrZone}
        </div>
      </div>
      <div style={{ fontSize: '12px', color: 'var(--text2)', display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
        <span>{durationMin} min</span>
        {analysis.speedKmh > 0 && <span>{analysis.speedKmh} km/h</span>}
        <span>Laufäquivalent: ~{analysis.runEquivMin} min</span>
        <span>Nutzen: {analysis.trainingBenefit}</span>
      </div>
    </>
  )
}

