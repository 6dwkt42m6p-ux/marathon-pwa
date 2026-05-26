import { useState } from 'react'
import {
  getCachedActivities,
  parseRuns,
  parseAllActivities,
  computeWeeklyStats,
  vdotTrendFromActivities,
  thisWeekKm,
  type ActivitySummary,
} from '../lib/strava'
import { analyzeRun, analyzeRide } from '../lib/vdot'
import { fetchActivityStreams, detectStrides } from '../lib/strava'
import type { StrideAnalysis } from '../lib/strava'
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

const DAY_TAGS: Record<number, string> = { 0: 'So', 1: 'Mo', 2: 'Di', 3: 'Mi', 4: 'Do', 5: 'Fr', 6: 'Sa' }

function getPlannedSession(plan: PlanRow[], date: Date, settings: AppSettings): WorkoutSession | null {
  const row = [...plan].reverse().find(r => r.weekStart <= date)
  if (!row) return null
  const sessions = allWeekSessions(row.phase, row.plannedKm, settings.vdot, settings.runsPerWeek, settings.raceType2)
  const tag = DAY_TAGS[date.getDay()]
  return sessions.find(s => s.wochentag === tag) ?? null
}

function getPhaseForDate(plan: PlanRow[], date: Date): string {
  const monday = new Date(date)
  const day = monday.getDay()
  monday.setDate(monday.getDate() - (day === 0 ? 6 : day - 1))
  monday.setHours(0, 0, 0, 0)
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

  const actualKmThisWeek = hasStrava ? Math.round(thisWeekKm(cached) * 10) / 10 : 0
  const plannedKm        = currentRow?.plannedKm ?? 0
  const progressPct      = plannedKm > 0 ? Math.min(100, (actualKmThisWeek / plannedKm) * 100) : 0
  const progressColor    = progressPct >= 80 ? '#4CAF50' : progressPct >= 50 ? '#FFC107' : '#e53935'

  const weeklyStats  = computeWeeklyStats(runs)
  const last8Weeks   = weeklyStats.slice(-8)

  // Build planned km map per week
  const planWeekMap = new Map<string, number>()
  for (const row of plan) {
    const key = row.weekStart.toISOString().slice(0, 10)
    planWeekMap.set(key, row.plannedKm)
  }

  // Runs for VDOT trend (include all runs sorted newest first)
  const trend = hasStrava ? vdotTrendFromActivities(runs, settings.vdot) : null

  // Max planned km for chart scaling
  const maxChartKm = Math.max(
    ...last8Weeks.map(w => {
      const key = w.weekStart.toISOString().slice(0, 10)
      return Math.max(w.actualKm, planWeekMap.get(key) ?? 0)
    }),
    1,
  )

  // Count this week's runs
  const thisWeekRuns = useRunCount(cached)

  // Count this week's elevation
  const thisWeekElev = useElevationSum(cached)

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
            <span className="kpi-value">{thisWeekRuns}</span>
            <span className="kpi-label">Einheiten</span>
          </div>
          <div className="kpi-tile">
            <span className="kpi-value">{thisWeekElev}</span>
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
        {currentRow && (
          <div style={{ fontSize: '12px', color: 'var(--text2)', marginTop: '6px' }}>
            {currentRow.phase} · Woche {currentRow.weekNr}/{plan.length - 1}
          </div>
        )}
      </div>

      {/* B: VDOT Trend */}
      {trend && (
        <>
          <div className="section-title">VDOT Trend</div>
          <div className="activity-card" style={{ padding: '12px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <div
                className="trend-badge"
                style={{ background: `${trend.color}22`, color: trend.color }}
              >
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
              <div style={{ fontSize: '11px', color: 'var(--text2)', marginTop: '6px' }}>
                Berechnet aus Trainingsdaten (keine Rennen vorhanden)
              </div>
            )}
          </div>
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
}: {
  analysis: ReturnType<typeof analyzeRun>
  act: ActivitySummary
  phase: string
  plannedSession: WorkoutSession | null
}) {
  const [strideData,    setStrideData]    = useState<StrideAnalysis | null>(null)
  const [loadingStream, setLoadingStream] = useState(false)
  const [streamErr,     setStreamErr]     = useState<string | null>(null)

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

      {/* Key metrics grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '6px', marginTop: '6px' }}>
        <div style={{ background: 'var(--surface2)', borderRadius: '6px', padding: '6px 8px' }}>
          <div style={{ fontSize: '10px', color: 'var(--text2)', marginBottom: '2px' }}>Ø Pace</div>
          <div style={{ fontSize: '13px', fontWeight: 700 }}>{act.paceFmt} /km</div>
          <div style={{ fontSize: '10px', color: 'var(--text2)' }}>Abw. E-Mitte: {analysis.devStr}</div>
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

// Hooks to compute this-week stats from cached activities

function useRunCount(activities: ReturnType<typeof getCachedActivities>): number {
  const now    = new Date()
  const day    = now.getDay()
  const monday = new Date(now)
  monday.setDate(now.getDate() - (day === 0 ? 6 : day - 1))
  monday.setHours(0, 0, 0, 0)
  return activities.filter(a => {
    const isRun = a.type === 'Run' || a.sport_type === 'Run' || a.type === 'TrailRun' || a.sport_type === 'TrailRun'
    const d = new Date(a.start_date_local || a.start_date)
    return isRun && d >= monday && d <= now
  }).length
}

function useElevationSum(activities: ReturnType<typeof getCachedActivities>): number {
  const now    = new Date()
  const day    = now.getDay()
  const monday = new Date(now)
  monday.setDate(now.getDate() - (day === 0 ? 6 : day - 1))
  monday.setHours(0, 0, 0, 0)
  return activities.filter(a => {
    const isRun = a.type === 'Run' || a.sport_type === 'Run' || a.type === 'TrailRun' || a.sport_type === 'TrailRun'
    const d = new Date(a.start_date_local || a.start_date)
    return isRun && d >= monday && d <= now
  }).reduce((s, a) => s + Math.round(a.total_elevation_gain || 0), 0)
}
