import { useState, useEffect } from 'react'
import { generatePlan } from '../lib/plan'
import { getCachedActivities, parseRuns, computeWeeklyStats, mondayOf } from '../lib/strava'
import { fetchSync, type SyncedPlan, type SyncedPlanWeek } from '../lib/githubSync'
import { isPlanStale } from '../lib/plan'
import type { AppSettings } from '../lib/storage'

interface Props { settings: AppSettings }

const PHASE_COLORS: Record<string, string> = {
  'Basis':            '#42A5F5',
  'Aufbau':           '#FFC107',
  'Peak':             '#FF9800',
  'Tapering':         '#9C27B0',
  'HM-Tapering':      '#AB47BC',
  'HM-Erholung':      '#4CAF50',
  'Halbmarathon':     '#e53935',
  'Renntag':          '#e53935',
  'Urlaub':           '#26C6DA',
}

function phaseColor(phase: string): string {
  const base = phase.split(' ')[0].split('(')[0].trim()
  return PHASE_COLORS[base] || '#9E9E9E'
}

export default function TrainingPlan({ settings }: Props) {
  const raceDate1 = new Date(settings.raceDate1)
  const raceDate2 = new Date(settings.raceDate2)
  const preRaceDate = settings.preRaceEnabled ? raceDate1 : undefined

  const [syncedPlan, setSyncedPlan] = useState<SyncedPlan | null>(null)
  const [syncSettings, setSyncSettings] = useState<Record<string, unknown> | null>(null)
  const [planRecomputeRequested, setPlanRecomputeRequested] = useState(false)
  const [syncLoading, setSyncLoading] = useState(true)
  const [selectedPlan, setSelectedPlan] = useState<'1' | '2'>('2')

  // Fetch plan from sync.json on mount
  useEffect(() => {
    fetchSync()
      .then(result => {
        if (result) {
          setSyncedPlan(result.data.plan ?? null)
          setSyncSettings(result.data.settings ?? null)
          setPlanRecomputeRequested(result.data.planRecomputeRequested ?? false)
        }
      })
      .catch(() => { /* offline — keep null, show fallback */ })
      .finally(() => setSyncLoading(false))
  }, [])

  // Build actual km per week from Strava cache
  const cached      = getCachedActivities()
  const runs        = parseRuns(cached)
  const weeklyStats = computeWeeklyStats(runs)
  const actualKmMap = new Map<string, number>()
  for (const w of weeklyStats) {
    actualKmMap.set(w.weekStart.toISOString().slice(0, 10), w.actualKm)
  }

  // Staleness check
  const stale = syncedPlan
    ? isPlanStale(syncedPlan, settings.vdot, settings.raceDate1, settings.raceDate2, syncSettings)
    : false

  if (syncLoading) {
    return (
      <div className="tab-content">
        <div style={{ padding: '20px 0', textAlign: 'center', color: 'var(--text2)', fontSize: '13px' }}>
          Plan wird geladen…
        </div>
      </div>
    )
  }

  // ── Synced plan present → render verbatim ───────────────────────────────────
  if (syncedPlan) {
    return (
      <div className="tab-content">
        {/* Status banners */}
        {(stale || planRecomputeRequested) && (
          <div style={{
            background: '#FF980020',
            border: '1px solid #FF980055',
            borderRadius: '8px',
            padding: '8px 12px',
            fontSize: '12px',
            color: '#FF9800',
            marginBottom: '8px',
          }}>
            ⚠️ Plan ggf. veraltet — am Desktop aktualisieren
          </div>
        )}

        <SyncedPlanTable
          plan={syncedPlan}
          actualKmMap={actualKmMap}
        />

        <div style={{ fontSize: '11px', color: 'var(--text2)', textAlign: 'right', marginTop: '4px' }}>
          Erstellt {new Date(syncedPlan.generatedAt).toLocaleDateString('de-AT')} · VDOT {syncedPlan.vdot}
        </div>
      </div>
    )
  }

  // ── No synced plan — show hint and local fallback ───────────────────────────
  const plan1 = generatePlan(raceDate1, settings.currentWeeklyKm, settings.runsPerWeek, settings.raceType1)
  const plan2 = generatePlan(raceDate2, settings.currentWeeklyKm, settings.runsPerWeek, settings.raceType2, preRaceDate)
  const activePlan = selectedPlan === '1' ? plan1 : plan2
  const currentIdx = activePlan.findIndex(r => r.isCurrent)

  return (
    <div className="tab-content">
      {/* "No plan" hint */}
      <div style={{
        background: '#42A5F520',
        border: '1px solid #42A5F555',
        borderRadius: '8px',
        padding: '10px 12px',
        fontSize: '12px',
        color: '#42A5F5',
        marginBottom: '8px',
        lineHeight: 1.5,
      }}>
        Noch kein Plan — am Desktop erstellen (Trainingsplan-Tab öffnen).
        <br />
        <span style={{ color: 'var(--text2)' }}>Vorschau unten: lokale Schätzung (nicht maßgeblich).</span>
      </div>

      <div className="plan-selector">
        <button
          className={`plan-btn ${selectedPlan === '1' ? 'active' : ''}`}
          onClick={() => setSelectedPlan('1')}
        >
          {settings.raceType1 === 'hm' ? 'Halbmarathon' : 'Marathon'}
          <small>{new Date(settings.raceDate1).toLocaleDateString('de-AT', { day: '2-digit', month: 'short', year: '2-digit' })}</small>
        </button>
        <button
          className={`plan-btn ${selectedPlan === '2' ? 'active' : ''}`}
          onClick={() => setSelectedPlan('2')}
        >
          {settings.raceType2 === 'marathon' ? 'Marathon' : 'Halbmarathon'}
          <small>{new Date(settings.raceDate2).toLocaleDateString('de-AT', { day: '2-digit', month: 'short', year: '2-digit' })}</small>
        </button>
      </div>

      <div className="plan-table">
        {activePlan.map((row, i) => {
          const isCurrentWeek = row.isCurrent
          const isPast = !isCurrentWeek && i < (currentIdx < 0 ? 0 : currentIdx)
          const dateStr = row.weekStart.toLocaleDateString('de-AT', { day: '2-digit', month: 'short' })
          const color = phaseColor(row.phase)
          const weekKey = row.weekStart.toISOString().slice(0, 10)
          const actualKm = actualKmMap.get(weekKey)
          const kmDiffPct = actualKm !== undefined && row.plannedKm > 0
            ? Math.abs(actualKm - row.plannedKm) / row.plannedKm
            : 0
          const plannedColor = actualKm !== undefined && isPast && kmDiffPct > 0.2
            ? (actualKm < row.plannedKm ? '#FF9800' : '#4CAF50')
            : color

          return (
            <div
              key={row.weekNr}
              className={`plan-row ${isCurrentWeek ? 'current' : ''} ${isPast ? 'past' : ''}`}
            >
              <div className="plan-row-left">
                <span className="plan-week">W{row.weekNr}</span>
                <span className="plan-date">{dateStr}</span>
              </div>
              <div className="plan-row-center">
                <div className="plan-phase-badge" style={{ borderLeftColor: color }}>
                  {row.phase}
                </div>
                <div className="plan-workouts">{row.workouts}</div>
              </div>
              <div className="plan-row-right">
                <span className="plan-km" style={{ color: plannedColor }}>{row.plannedKm}</span>
                <span className="plan-km-unit">km</span>
                {actualKm !== undefined && (
                  <span style={{ fontSize: '10px', color: 'var(--text2)' }}>
                    {actualKm}
                  </span>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── Synced-plan table (T-024: verbatim render) ──────────────────────────────

interface SyncedPlanTableProps {
  plan:         SyncedPlan
  actualKmMap:  Map<string, number>
}

function SyncedPlanTable({ plan, actualKmMap }: SyncedPlanTableProps) {
  return (
    <div className="plan-table">
      {plan.weeks.map(week => (
        <SyncedPlanRow key={week.week_nr} week={week} actualKm={actualKmMap.get(week.week_start)} />
      ))}
    </div>
  )
}

interface SyncedPlanRowProps {
  week:     SyncedPlanWeek
  actualKm: number | undefined
}

function SyncedPlanRow({ week, actualKm }: SyncedPlanRowProps) {
  const [expanded, setExpanded] = useState(false)
  const color     = phaseColor(week.phase)
  const dateStr   = new Date(week.week_start).toLocaleDateString('de-AT', { day: '2-digit', month: 'short' })
  const kmDiffPct = actualKm !== undefined && week.planned_km > 0
    ? Math.abs(actualKm - week.planned_km) / week.planned_km
    : 0
  // Use date-based current-week detection — is_current flag is stale after generation day
  const todayMonday = mondayOf(new Date()).toISOString().slice(0, 10)
  const isCurrent = week.week_start === todayMonday
  const isPast    = !isCurrent && new Date(week.week_start) < new Date()
  const plannedColor = actualKm !== undefined && isPast && kmDiffPct > 0.2
    ? (actualKm < week.planned_km ? '#FF9800' : '#4CAF50')
    : color

  // Session summary line (verbatim typ values joined)
  const sessionSummary = week.sessions
    .filter(s => s.km !== null)
    .map(s => s.typ)
    .join(', ')

  return (
    <>
      <div
        className={`plan-row ${isCurrent ? 'current' : ''} ${isPast ? 'past' : ''}`}
        onClick={() => setExpanded(e => !e)}
        style={{ cursor: 'pointer' }}
      >
        <div className="plan-row-left">
          <span className="plan-week">W{week.week_nr}</span>
          <span className="plan-date">{dateStr}</span>
        </div>
        <div className="plan-row-center">
          <div className="plan-phase-badge" style={{ borderLeftColor: color }}>
            {week.phase}
          </div>
          <div className="plan-workouts">{sessionSummary}</div>
        </div>
        <div className="plan-row-right">
          <span className="plan-km" style={{ color: plannedColor }}>{week.planned_km}</span>
          <span className="plan-km-unit">km</span>
          {actualKm !== undefined && (
            <span style={{ fontSize: '10px', color: 'var(--text2)' }}>
              {actualKm}
            </span>
          )}
          <span style={{ fontSize: '11px', color: 'var(--text2)', marginLeft: 4 }}>
            {expanded ? '▲' : '▼'}
          </span>
        </div>
      </div>

      {/* Expanded: show all sessions verbatim */}
      {expanded && (
        <div style={{ paddingLeft: '12px', paddingRight: '12px', paddingBottom: '8px' }}>
          {week.sessions.map(s => (
            <div key={s.tag} style={{
              borderLeft: `2px solid ${color}`,
              paddingLeft: '10px',
              marginBottom: '8px',
              fontSize: '12px',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '2px' }}>
                <span style={{ fontWeight: 700, color }}>{s.tag}</span>
                <span style={{ color: 'var(--text2)' }}>{s.typ}</span>
                <span style={{ color: 'var(--text2)' }}>{s.km !== null ? `${s.km} km` : '—'} · {s.dauer}</span>
              </div>
              <div style={{ fontWeight: 600, marginBottom: '2px' }}>{s.vorgabe}</div>
              <div style={{ color: 'var(--text2)', lineHeight: 1.5, marginBottom: '2px' }}>{s.struktur}</div>
              <div style={{ color: 'var(--text2)', fontSize: '11px', fontStyle: 'italic', lineHeight: 1.5 }}>
                💡 {s.hinweis}
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  )
}
