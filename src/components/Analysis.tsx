import { useState, useEffect, useMemo } from 'react'
import {
  getCachedActivities,
  syncActivities,
  getValidToken,
  parseRuns,
  parseAllActivities,
  computeWeeklyStats,
  computeWeeklyStatsBySport,
  vdotTrendFromActivities,
  efficiencyFactorTrend,
  thisWeekStatsBySport,
  computeAtlCtl,
  mondayOf,
  localISODate,
  DAY_TAGS,
  loadAnalyticsStreams,
  type StravaActivity,
  type ActivitySummary,
  type StrideDataEntry,
  type SyncedThreshold,
} from '../lib/strava'
import { analyzeRun, analyzeRide, formatPace } from '../lib/vdot'
import {
  intensityDistribution,
  stagnationCheck,
  vdotAdherenceCheck,
  aggregateStrideTrend,
  injuryRisk,
  type AdherenceSession,
  type InjuryRiskResult,
} from '../lib/analytics'
import {
  durabilityTrend,
  loadAllDurability,
  type DurabilityTrend,
  type DurabilitySignalTrend,
} from '../lib/durability'
import {
  generatePlan,
  assessDeviation,
  assessDeviationForRestDay,
  syncedWeekForDate,
  syncedSessionForTag,
  type PlanRow,
  type WorkoutSession,
  type PlanDeviation,
} from '../lib/plan'
import type { AppSettings } from '../lib/storage'
import { loadNote } from '../lib/storage'
import { fetchSync, type SyncedPlan, type SyncedPlanSession } from '../lib/githubSync'
import RunDetail from './RunDetail'

interface Props {
  settings: AppSettings
  onGoToSettings: () => void
  // T-123: canonical VDOT from App — desktop sync wins, settings.vdot is offline fallback
  effectiveVdot: number
  // T-125: FTP from Desktop sync.json plan — null when not yet synced or not set
  syncedFtp?: number | null
  // T-138: Threshold from Desktop sync.json plan — null when not yet synced or not set
  syncedThreshold?: SyncedThreshold | null
  // T-124: work-interval splits per quality session (workout_type==3) for adherence check.
  // Map of activityId(string) → list of interval-lap paces (sec/km).
  // Null = no quality sessions found in cache yet.
  workSplits?: Record<string, number[]> | null
  // T-124: stride data by activity id, for stride trend.
  strideDataById?: Record<string, { strideCount: number; strides: { peakPaceSec: number }[]; avgPeakPaceSec?: number }> | null
}

function fmt(s: number) {
  const m = Math.floor(s / 60); const sec = Math.round(s % 60)
  return `${m}:${sec.toString().padStart(2, '0')}`
}

function isoWeek(d: Date): string {
  // Use Date.UTC to avoid DST distortion: all operands are treated as UTC midnight,
  // so the 7-day divisor is always exact (no ±1h DST shift).
  const jan4   = new Date(d.getFullYear(), 0, 4)
  const startDay = jan4.getDate() - ((jan4.getDay() + 6) % 7)
  const startUTC = Date.UTC(jan4.getFullYear(), 0, startDay)
  const dUTC     = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())
  const week     = Math.floor((dUTC - startUTC) / (7 * 24 * 3600 * 1000)) + 1
  return `KW${week}`
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

// Convert SyncedPlanSession to the WorkoutSession shape expected by assessDeviation
function syncedSessionToWorkout(s: SyncedPlanSession): WorkoutSession {
  return {
    session:   s.typ,
    typ:       s.typ,
    distanzKm: s.km ?? 0,
    vorgabe:   s.vorgabe,
    struktur:  s.struktur,
    dauerMin:  s.dauer,
    hinweis:   s.hinweis,
    wochentag: s.tag,
  }
}


// T-142: Inline-SVG-Sparkline für Durability-Signale (Drift + Fade).
function DurabilitySparkline({ series, color }: { series: Array<[number, number]>; color: string }) {
  if (!series || series.length < 2) return null
  const w = 120, h = 32, pad = 3
  const xs = series.map(p => p[0]), ys = series.map(p => p[1])
  const xMin = Math.min(...xs), xMax = Math.max(...xs)
  const yMin = Math.min(...ys), yMax = Math.max(...ys)
  const sx = (x: number) => xMax === xMin ? w / 2 : pad + (x - xMin) / (xMax - xMin) * (w - 2 * pad)
  const sy = (y: number) => yMax === yMin ? h / 2 : h - pad - (y - yMin) / (yMax - yMin) * (h - 2 * pad)
  const pts = series.map(([x, y]) => `${sx(x).toFixed(1)},${sy(y).toFixed(1)}`).join(' ')
  return (
    <svg width={w} height={h} style={{ display: 'block', marginTop: 4 }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} />
      {series.map(([x, y], i) => (
        <circle key={i} cx={sx(x)} cy={sy(y)} r={1.8} fill={color} />
      ))}
    </svg>
  )
}

export default function Analysis({ settings, onGoToSettings, effectiveVdot, syncedFtp, syncedThreshold, workSplits: workSplitsProp, strideDataById: strideDataByIdProp }: Props) {
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [noteVersion, setNoteVersion] = useState(0)
  const [cached, setCached] = useState<StravaActivity[]>(getCachedActivities)
  const [syncedPlan, setSyncedPlan] = useState<SyncedPlan | null>(null)
  const [syncLoading, setSyncLoading] = useState(true)
  // T-124-fix: bulk-fetched stream/lap analytics — loaded once per mount when Strava is connected.
  const [localWorkSplits, setLocalWorkSplits]       = useState<Record<string, number[]> | null>(workSplitsProp ?? null)
  const [localStrideData, setLocalStrideData]       = useState<Record<string, StrideDataEntry> | null>(strideDataByIdProp ?? null)
  const [analyticsLoading, setAnalyticsLoading]     = useState(false)
  const [analyticsPartial, setAnalyticsPartial]     = useState(false)
  const [analyticsFetched, setAnalyticsFetched]     = useState(0)
  const [analyticsTotal, setAnalyticsTotal]         = useState(0)

  function onNoteSaved() { setNoteVersion(v => v + 1) }

  // Stale-while-revalidate: show cache immediately, delta-sync in background
  useEffect(() => {
    let mounted = true
    getValidToken().then(token => {
      if (!token) return
      syncActivities(52).then(fresh => {
        if (mounted && fresh && fresh.length > 0) setCached(fresh)
      }).catch(() => {})
    }).catch(() => {})
    return () => { mounted = false }
  }, [])

  // Load synced plan from GitHub (SSoT for deviation assessment)
  useEffect(() => {
    let mounted = true
    fetchSync()
      .then(result => { if (mounted && result) setSyncedPlan(result.data.plan ?? null) })
      .catch(() => { /* offline — keep null */ })
      .finally(() => { if (mounted) setSyncLoading(false) })
    return () => { mounted = false }
  }, [])

  const hasStrava   = cached.length > 0

  // T-124-fix: Bulk-fetch streams (strides) + laps (VDOT adherence) once per mount.
  // mounted-guard (T-083 gotcha: async useEffect → setState-after-unmount).
  // Runs only when Strava activities are available; re-runs when cached activities change
  // so newly synced activities are picked up automatically.
  // Sequentially fetches missing data; cache-hits are free (localStorage, no API call).
  useEffect(() => {
    if (!hasStrava) return
    let mounted = true

    async function bulkFetch() {
      setAnalyticsLoading(true)
      try {
        const runs = parseRuns(cached)
        // Quality runs: workout_type==3, identified by checking cached raw activities
        const qualityIds = new Set(
          cached
            .filter(a => a.workout_type === 3)
            .map(a => a.id)
        )
        const qualityRuns = runs.filter(r => qualityIds.has(r.id))

        const result = await loadAnalyticsStreams(runs, qualityRuns, effectiveVdot)
        if (!mounted) return

        setLocalStrideData(result.strideDataById)
        setLocalWorkSplits(result.workSplits)
        setAnalyticsPartial(result.partial)
        setAnalyticsFetched(result.fetched)
        setAnalyticsTotal(result.total)
      } catch {
        // Silently ignore — analytics is best-effort, not critical path
      } finally {
        if (mounted) setAnalyticsLoading(false)
      }
    }

    bulkFetch()
    return () => { mounted = false }
  // effectiveVdot change = new VDOT from sync → re-run to recalculate adherence thresholds
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasStrava, cached, effectiveVdot])

  // Expensive parse/aggregate — only recompute when cached activities change
  const runs       = useMemo(() => parseRuns(cached), [cached])
  const allActs    = useMemo(() => parseAllActivities(cached), [cached])
  const recentActs = useMemo(() => allActs.slice(0, 14), [allActs])
  const weeklyStats  = useMemo(() => computeWeeklyStats(runs), [runs])
  const sportWeekly  = useMemo(() => computeWeeklyStatsBySport(cached), [cached])
  const weekStats    = useMemo(() => thisWeekStatsBySport(cached), [cached])
  // T-125/T-138: pass syncedFtp + syncedThreshold so Rides use bike_tss, Runs use rTSS/hrTSS
  const tsbData      = useMemo(
    () => hasStrava ? computeAtlCtl(cached, syncedFtp ?? undefined, syncedThreshold ?? undefined) : null,
    [cached, hasStrava, syncedFtp, syncedThreshold],
  )
  // T-144: ACWR + CTL-Ramp injury risk (shares dailyLoadSeries with computeAtlCtl)
  const injury: InjuryRiskResult | null = useMemo(
    () => hasStrava ? injuryRisk(cached, syncedFtp ?? undefined, syncedThreshold ?? undefined) : null,
    [hasStrava, cached, syncedFtp, syncedThreshold],
  )
  const trend        = useMemo(
    () => hasStrava ? vdotTrendFromActivities(runs, effectiveVdot, settings.maxHr, settings.restHr) : null,
    [hasStrava, runs, effectiveVdot, settings.maxHr, settings.restHr],
  )
  const efTrend      = useMemo(
    () => hasStrava ? efficiencyFactorTrend(runs, settings.maxHr, settings.restHr) : null,
    [hasStrava, runs, settings.maxHr, settings.restHr],
  )
  // T-142: Durability-Trend aus localStorage-Cache (befüllt von loadAnalyticsStreams).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const durTrend: DurabilityTrend | null = useMemo(
    () => hasStrava ? durabilityTrend(loadAllDurability()) : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [hasStrava, analyticsFetched, analyticsPartial],
  )

  // T-124: four new analytics — each independent signal with its own guard
  const intDist = useMemo(
    () => hasStrava ? intensityDistribution(runs, settings.maxHr, settings.restHr) : null,
    [hasStrava, runs, settings.maxHr, settings.restHr],
  )
  const stagnation = useMemo(
    () => hasStrava && trend ? stagnationCheck(
      runs,
      trend ? { delta: trend.delta, insufficientEffortRuns: trend.insufficientEffortRuns } : null,
      settings.maxHr, settings.restHr, 8, 0.3,
      efTrend ? { deltaPct: efTrend.deltaPct ?? undefined, noHrData: efTrend.noHrData } : undefined,
    ) : null,
    [hasStrava, trend, efTrend, runs, settings.maxHr, settings.restHr],
  )
  // T-124-fix: use local bulk-fetched state; props serve as optional external override.
  const workSplits     = localWorkSplits     ?? workSplitsProp     ?? null
  const strideDataById = localStrideData     ?? strideDataByIdProp ?? null

  const adherence = useMemo(
    () => hasStrava && workSplits ? vdotAdherenceCheck(runs, effectiveVdot, workSplits) : null,
    [hasStrava, runs, effectiveVdot, workSplits],
  )
  const strideTrend = useMemo(
    () => hasStrava && strideDataById ? aggregateStrideTrend(strideDataById, runs) : null,
    [hasStrava, runs, strideDataById],
  )

  const last8Weeks   = useMemo(() => weeklyStats.slice(-8), [weeklyStats])
  const last12Weeks  = useMemo(() => weeklyStats.slice(-12), [weeklyStats])

  // Local plan: only compute when no synced plan is available (expensive ~40-week generation)
  const raceDate2   = new Date(settings.raceDate2)
  const raceDate1   = new Date(settings.raceDate1)
  const preRaceDate = settings.preRaceEnabled ? raceDate1 : undefined
  const localPlan   = syncedPlan
    ? null
    : generatePlan(raceDate2, settings.currentWeeklyKm, settings.runsPerWeek, settings.raceType2, preRaceDate)

  // Planned km for "Diese Woche": prefer synced plan, fall back to local
  const syncedCurrentMonday = localISODate(mondayOf(new Date()))
  const syncedCurrentW = syncedPlan?.weeks.find(w => w.week_start === syncedCurrentMonday)
    ?? syncedPlan?.weeks.find(w => w.is_current)
    ?? null
  const plannedKmFromSync  = syncedCurrentW?.planned_km ?? null
  const localCurrentRow    = localPlan?.find(r => r.isCurrent) ?? null
  const currentPhase       = syncedCurrentW?.phase ?? localCurrentRow?.phase ?? ''
  const currentWeekNr      = syncedCurrentW?.week_nr ?? localCurrentRow?.weekNr ?? 0
  const totalWeeks         = syncedPlan?.weeks.length ?? (localPlan?.length ?? 1) - 1

  const actualKmThisWeek = hasStrava ? weekStats.run.km : 0
  const plannedKm        = plannedKmFromSync ?? localCurrentRow?.plannedKm ?? 0
  const progressPct      = plannedKm > 0 ? Math.min(100, (actualKmThisWeek / plannedKm) * 100) : 0
  const progressColor    = progressPct >= 80 ? '#4CAF50' : progressPct >= 50 ? '#FFC107' : '#e53935'

  // Build planned km map per week — prefer synced plan weeks, fall back to local
  const planWeekMap = useMemo(() => {
    const map = new Map<string, number>()
    if (syncedPlan) {
      for (const week of syncedPlan.weeks) map.set(week.week_start, week.planned_km)
    } else {
      for (const row of localPlan ?? []) map.set(localISODate(row.weekStart), row.plannedKm)
    }
    return map
  // localPlan reference changes when syncedPlan is null and settings change — deps cover it
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncedPlan, localPlan])

  // Max planned km for chart scaling
  const maxChartKm = Math.max(
    ...last8Weeks.map(w => {
      const key = localISODate(w.weekStart)
      return Math.max(w.actualKm, planWeekMap.get(key) ?? 0)
    }),
    1,
  )
  const maxChart12Km = Math.max(
    ...last12Weeks.map(w => {
      const key = localISODate(w.weekStart)
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
        <div style={{ fontSize: '12px', color: 'var(--text-2)', marginBottom: '4px' }}>
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
          <div style={{ display: 'flex', gap: '14px', marginTop: '8px', flexWrap: 'wrap', fontSize: '12px', color: 'var(--text-2)' }}>
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
        {(syncedCurrentW || localCurrentRow) && (
          <div style={{ fontSize: '12px', color: 'var(--text-2)', marginTop: '6px' }}>
            {currentPhase} · Woche {currentWeekNr}/{totalWeeks}
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
                  <div style={{ fontSize: '11px', color: 'var(--text-2)', marginTop: '2px' }}>
                    TSB = CTL − ATL · positiv = frisch, negativ = ermüdet
                  </div>
                </div>
              </div>
              {/* TSB scale bar */}
              <div style={{ marginTop: '10px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: 'var(--text-2)', marginBottom: '3px' }}>
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
              {/* T-144: Verletzungsrisiko-Block (ACWR + CTL-Ramp) */}
              {injury && injury.enoughData && (
                <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border, #ffffff22)' }}>
                  <div style={{ fontSize: '13px', fontWeight: 600 }}>
                    {injury.riskEmoji} Verletzungsrisiko
                  </div>
                  <div style={{ fontSize: '12px', color: injury.acwrColor, marginTop: 2 }}>{injury.acwrLabel}</div>
                  {injury.rampLabel && (
                    <div style={{ fontSize: '11px', color: injury.rampColor, marginTop: 2 }}>{injury.rampLabel}</div>
                  )}
                </div>
              )}
              {injury && !injury.enoughData && (
                <div style={{ fontSize: '11px', color: 'var(--text-2)', marginTop: 8 }}>
                  Verletzungsrisiko-Insight ab ~4 Wochen Trainingshistorie.
                </div>
              )}
            </div>
          </>
        )
      })()}

      {/* D: Fitnesstrend — shown if EITHER VDOT trend OR EF trend exists (T-120:
          EF is the primary aerobic signal and must render independently of the
          VDOT trend, matching the Desktop where EF is its own section). */}
      {(trend || efTrend) && (
        <>
          <div className="section-title">Fitnesstrend</div>

          {/* VDOT trend — only shown when effort runs are available */}
          {trend && (!trend.insufficientEffortRuns ? (
            <div className="activity-card" style={{ padding: '12px' }}>
              <div style={{ fontSize: '11px', color: 'var(--text-2)', marginBottom: '4px', fontWeight: 600, letterSpacing: '0.04em' }}>VDOT AUS TEMPOLÄUFEN</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <div className="trend-badge" style={{ background: `${trend.color}22`, color: trend.color }}>
                  <span>{trend.direction}</span>
                  <span>{trend.label}</span>
                </div>
              </div>
              <div style={{ fontSize: '13px', color: 'var(--text-2)', marginTop: '8px', display: 'flex', gap: '16px' }}>
                <span>Früher: {trend.early}</span>
                <span>Aktuell: {trend.recent}</span>
                <span style={{ color: trend.color }}>Δ {trend.delta > 0 ? '+' : ''}{trend.delta}</span>
              </div>
              {trend.fromTraining && (
                <div style={{ fontSize: '11px', color: 'var(--text-2)', marginTop: '4px' }}>
                  Aus Trainingsläufen — genauer nach Wettkampf- oder Tempoeinheiten
                </div>
              )}
            </div>
          ) : (
            <div className="activity-card" style={{ padding: '10px 12px', fontSize: '12px', color: 'var(--text-2)' }}>
              VDOT-Trend folgt ab der Aufbauphase — wird aus Tempo- und Intervallläufen berechnet, nicht aus Easy-Läufen.
            </div>
          ))}

          {/* Efficiency Factor — PRIMARY aerobic efficiency signal (T-120, analog Desktop Tab 4) */}
          {efTrend && (
            <div className="activity-card" style={{ padding: '12px', marginTop: '6px' }}>
              <div style={{ fontSize: '11px', color: 'var(--text-2)', marginBottom: '4px', fontWeight: 600, letterSpacing: '0.04em' }}>AEROBE EFFIZIENZ (EF)</div>
              {efTrend.noHrData ? (
                <div style={{ fontSize: '12px', color: 'var(--text-2)' }}>{efTrend.label}</div>
              ) : (
                <>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                    <div className="trend-badge" style={{ background: `${efTrend.color}22`, color: efTrend.color }}>
                      <span>{efTrend.direction}</span>
                      <span>{efTrend.label}</span>
                    </div>
                  </div>
                  <div style={{ fontSize: '13px', color: 'var(--text-2)', marginTop: '8px', display: 'flex', gap: '16px' }}>
                    <span>Früher: EF {efTrend.earlyEf?.toFixed(3)}</span>
                    <span>Aktuell: EF {efTrend.recentEf?.toFixed(3)}</span>
                    <span style={{ color: efTrend.color }}>Δ {(efTrend.deltaPct ?? 0) > 0 ? '+' : ''}{efTrend.deltaPct?.toFixed(1)}%</span>
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--text-2)', marginTop: '4px' }}>
                    EF = Geschwindigkeit / Puls — steigend = aerobe Adaptation (Friel)
                  </div>
                </>
              )}
            </div>
          )}

          {/* Easy-run HR trend — SECONDARY aerobic efficiency signal (Basis phase) */}
          {trend?.easyHrTrend && (() => {
            const hr = trend!.easyHrTrend!
            return (
              <div className="activity-card" style={{ padding: '12px', marginTop: '6px' }}>
                <div style={{ fontSize: '11px', color: 'var(--text-2)', marginBottom: '4px', fontWeight: 600, letterSpacing: '0.04em' }}>EASY-HF-TREND (SEKUNDÄR)</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                  <div className="trend-badge" style={{ background: `${hr.color}22`, color: hr.color }}>
                    <span>{hr.direction}</span>
                    <span>{hr.label}</span>
                  </div>
                </div>
                <div style={{ fontSize: '13px', color: 'var(--text-2)', marginTop: '8px', display: 'flex', gap: '16px' }}>
                  <span>Früher: Ø {hr.earlyAvgHr} bpm</span>
                  <span>Aktuell: Ø {hr.recentAvgHr} bpm</span>
                  <span style={{ color: hr.color }}>Δ {hr.deltaBpm > 0 ? '+' : ''}{hr.deltaBpm} bpm</span>
                </div>
                <div style={{ fontSize: '11px', color: 'var(--text-2)', marginTop: '4px' }}>
                  Niedrigerer Puls bei gleicher Easy-Pace = aerobe Adaptation
                </div>
              </div>
            )
          })()}
        </>
      )}

      {/* T-142: Durability-Trend — Sub-3-Limiter (analog Desktop Tab 4), eigenständiger Guard */}
      {hasStrava && durTrend && durTrend.nLongruns > 0 && (durTrend.drift || durTrend.fade) && (
        <>
          <div className="section-title">Durability-Trend (Longruns)</div>
          <div className="activity-card" style={{ padding: '12px' }}>
            {(
              [
                ['HR-Decoupling', durTrend.drift],
                ['Pace-Fade (2. Hälfte)', durTrend.fade],
              ] as Array<[string, DurabilitySignalTrend | null]>
            ).map(([title, sg]) => (
              <div key={title} style={{ marginBottom: 8 }}>
                <div style={{ fontSize: '11px', color: 'var(--text-2)', fontWeight: 600, letterSpacing: '0.04em', marginBottom: 4 }}>{title.toUpperCase()}</div>
                {sg ? (
                  <>
                    <div className="trend-badge" style={{ background: `${sg.color}22`, color: sg.color }}>
                      <span>{sg.direction}</span>
                      <span>{sg.label}</span>
                    </div>
                    <div style={{ fontSize: '11px', color: 'var(--text-2)', marginTop: 2 }}>
                      Ø zuletzt {sg.recentAvg}% · früher {sg.earlyAvg}% · {sg.slopePerWeek > 0 ? '+' : ''}{sg.slopePerWeek.toFixed(2)} %/Woche
                    </div>
                    <DurabilitySparkline series={sg.series} color={sg.color} />
                  </>
                ) : (
                  <div style={{ fontSize: '11px', color: 'var(--text-2)' }}>Zu wenige Longruns</div>
                )}
              </div>
            ))}
          </div>
        </>
      )}
      {hasStrava && durTrend && durTrend.nLongruns === 0 && (
        <div style={{ fontSize: '12px', color: 'var(--text-2)', marginTop: 4, padding: '4px 0' }}>
          Öffne Longruns / Sync für den Durability-Trend (≥75 min oder ≥18 km)
        </div>
      )}

      {/* T-124-G1: 80/20 Intensitätsverteilung — independent signal */}
      {intDist?.hasData && (
        <>
          <div className="section-title">80/20 Intensitätsverteilung (12 Wochen)</div>
          <div className="activity-card" style={{ padding: '12px' }}>
            <div style={{ fontSize: '11px', color: 'var(--text-2)', marginBottom: '8px', fontWeight: 600, letterSpacing: '0.04em' }}>ZONENVERTEILUNG</div>
            {/* Zone bars */}
            {(
              [
                { label: 'Easy (Z1–Z2)', pct: intDist.totals.easyPct,    min: intDist.totals.easyMin,    color: '#4CAF50', target: '≥80%' },
                { label: 'Grau (Z3)',    pct: intDist.totals.greyPct,    min: intDist.totals.greyMin,    color: '#FFC107', target: '<15%' },
                { label: 'Qualität (Z4–Z5)', pct: intDist.totals.qualityPct, min: intDist.totals.qualityMin, color: '#e53935', target: '~20%' },
              ] as { label: string; pct: number; min: number; color: string; target: string }[]
            ).map(z => (
              <div key={z.label} style={{ marginBottom: '8px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', marginBottom: '3px' }}>
                  <span style={{ fontWeight: 600 }}>{z.label}</span>
                  <span style={{ color: 'var(--text-2)' }}>{z.pct.toFixed(0)}% · {Math.round(z.min)} min · Ziel {z.target}</span>
                </div>
                <div style={{ height: '7px', background: 'var(--surface2)', borderRadius: '4px', overflow: 'hidden' }}>
                  <div style={{ height: '100%', background: z.color, borderRadius: '4px', width: `${Math.min(100, z.pct)}%` }} />
                </div>
              </div>
            ))}
            {intDist.warning && (
              <div style={{ fontSize: '12px', color: '#e6a817', marginTop: '6px', padding: '6px 8px', background: '#e6a81711', borderRadius: '6px' }}>
                {intDist.warning}
              </div>
            )}
            <div style={{ fontSize: '10px', color: 'var(--text-2)', marginTop: '6px' }}>
              Aus Ø-HF-Klassifikation — nur Aktivitäten mit HF-Sensor einbezogen
            </div>
          </div>
        </>
      )}

      {/* T-124-G2: Stagnations-Check — independent signal */}
      {stagnation?.stagnating && (
        <>
          <div className="section-title">Stagnations-Frühwarnung</div>
          <div className="activity-card" style={{ padding: '12px', borderLeft: `3px solid ${stagnation.color}` }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' }}>
              <span style={{ fontSize: '16px' }}>{stagnation.color === '#dc3545' ? '🔴' : '🟡'}</span>
              <div>
                <div style={{ fontSize: '13px', fontWeight: 700, color: stagnation.color }}>{stagnation.primaryCause}</div>
                <div style={{ fontSize: '11px', color: 'var(--text-2)' }}>VDOT-Delta: {stagnation.trendDelta > 0 ? '+' : ''}{stagnation.trendDelta} (Ziel ≥ +0.3)</div>
              </div>
            </div>
            {stagnation.causes.map((c, i) => (
              <div key={i} style={{ fontSize: '12px', color: 'var(--text-2)', marginBottom: '4px', paddingLeft: '8px', borderLeft: `2px solid ${c.severity === 'error' ? '#dc3545' : '#e6a817'}` }}>
                <strong style={{ color: c.severity === 'error' ? '#dc3545' : '#e6a817' }}>{c.label}:</strong> {c.detail}
              </div>
            ))}
            {stagnation.recommendation && (
              <div style={{ fontSize: '12px', color: 'var(--text-2)', marginTop: '8px', padding: '6px 8px', background: 'var(--surface2)', borderRadius: '6px' }}>
                {stagnation.recommendation}
              </div>
            )}
          </div>
        </>
      )}

      {/* T-124-fix: Loading/partial hint for stream-dependent metrics */}
      {analyticsLoading && (
        <div style={{ fontSize: '11px', color: 'var(--text-2)', padding: '4px 0', textAlign: 'center' }}>
          Lade Lap- &amp; Stream-Daten…
        </div>
      )}
      {!analyticsLoading && analyticsPartial && (
        <div style={{ fontSize: '11px', color: '#e6a817', padding: '4px 8px', background: '#e6a81711', borderRadius: '6px', marginBottom: '4px' }}>
          {analyticsFetched}/{analyticsTotal} Aktivitäten ausgewertet (Rate-Limit — vollständige Daten beim nächsten Öffnen)
        </div>
      )}

      {/* T-124-G3: VDOT-Adherence — independent signal */}
      {adherence && (
        <>
          <div className="section-title">VDOT-Adherence (Soll/Ist)</div>
          <div className="activity-card" style={{ padding: '12px' }}>
            <div style={{ fontSize: '11px', color: 'var(--text-2)', marginBottom: '6px', fontWeight: 600, letterSpacing: '0.04em' }}>QUALITÄTSEINHEITEN VS. ZIEL-PACE</div>
            <div style={{ display: 'flex', gap: '12px', marginBottom: '8px', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '12px' }}>T-Pace Soll: <strong>{adherence.tPaceFmt}</strong></span>
              <span style={{ fontSize: '12px' }}>I-Pace Soll: <strong>{adherence.iPaceFmt}</strong></span>
            </div>
            <div style={{
              fontSize: '13px', fontWeight: 700, marginBottom: '6px',
              color: adherence.status === 'beating' ? '#4CAF50' : adherence.status === 'missing' ? '#e53935' : '#FFC107',
            }}>
              {adherence.status === 'beating' ? '⚡ Paces konstant schneller als Ziel' : adherence.status === 'missing' ? '⚠️ Paces konstant langsamer als Ziel' : '✅ Paces im Zielbereich'}
            </div>
            <div style={{ fontSize: '12px', color: 'var(--text-2)', marginBottom: '8px' }}>{adherence.reason}</div>
            {adherence.suggestedVdot && (
              <div style={{ fontSize: '12px', padding: '6px 8px', background: 'var(--surface2)', borderRadius: '6px', marginBottom: '8px' }}>
                Empfohlener VDOT: <strong>{adherence.suggestedVdot}</strong> (aktuell: {adherence.currentVdot})
              </div>
            )}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              {(adherence.sessions as AdherenceSession[]).slice(0, 5).map((s, i) => (
                <div key={i} style={{ fontSize: '11px', display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderTop: '1px solid var(--border)' }}>
                  <span style={{ color: 'var(--text-2)' }}>{s.date} {s.name.slice(0, 20)}</span>
                  <span style={{ color: 'var(--text-2)' }}>{s.targetZone}: {s.targetPaceFmt}</span>
                  <span style={{ fontWeight: 600 }}>{s.actualPaceFmt}</span>
                  <span style={{ color: s.deltaSec < -5 ? '#4CAF50' : s.deltaSec > 8 ? '#e53935' : 'var(--text-2)', fontSize: '10px' }}>
                    {s.deltaSec > 0 ? '+' : ''}{Math.round(s.deltaSec)}s
                  </span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {/* T-124-G4: Stride-Trend — independent signal */}
      {strideTrend && strideTrend.length >= 2 && (
        <>
          <div className="section-title">Stride-Trend</div>
          <div className="activity-card" style={{ padding: '12px' }}>
            <div style={{ fontSize: '11px', color: 'var(--text-2)', marginBottom: '8px', fontWeight: 600, letterSpacing: '0.04em' }}>STRIDES PRO WOCHE (LETZTE {strideTrend.length} WOCHEN)</div>
            {(() => {
              const maxStrides = Math.max(...strideTrend.map(w => w.strideCount), 1)
              return strideTrend.slice(-8).map((w, i) => {
                const barPct = Math.min(100, (w.strideCount / maxStrides) * 100)
                const label = (() => {
                  const d = w.weekStart
                  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}`
                })()
                return (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '5px' }}>
                    <div style={{ fontSize: '10px', color: 'var(--text-2)', width: '36px', flexShrink: 0 }}>{label}</div>
                    <div style={{ flex: 1, height: '7px', background: 'var(--surface2)', borderRadius: '4px', overflow: 'hidden' }}>
                      <div style={{ height: '100%', background: '#3b82f6', borderRadius: '4px', width: `${barPct}%` }} />
                    </div>
                    <div style={{ fontSize: '10px', color: 'var(--text-2)', width: '70px', flexShrink: 0, textAlign: 'right' }}>
                      {w.strideCount}× · {formatPace(w.bestPeakPaceSec)}/km
                    </div>
                  </div>
                )
              })
            })()}
            <div style={{ fontSize: '10px', color: 'var(--text-2)', marginTop: '6px' }}>
              Strides aus Lauf-Lap-Daten — schnellste Peak-Pace je Woche
            </div>
          </div>
        </>
      )}

      {/* C: Coach-Auswertung */}
      <div className="section-title">Coach-Auswertung (letzte 14)</div>
      {!syncLoading && !syncedPlan && (
        <div className="activity-card" style={{ padding: '10px 12px', fontSize: '12px', color: 'var(--text-2)', marginBottom: '6px' }}>
          Plan wird am Desktop berechnet — einmal Desktop-App öffnen um Plan-Abweichungen zu sehen.
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
        {recentActs.length === 0 && (
          <div style={{ fontSize: '13px', color: 'var(--text-2)', padding: '12px 0' }}>
            Keine Aktivitäten vorhanden.
          </div>
        )}
        {recentActs.map((act, actIdx) => {
          const isExpanded = expandedId === act.id

          // Planned session: prefer synced plan (SSoT), no fallback to local generator
          const actTag = DAY_TAGS[act.date.getDay()]
          const syncedWeek = syncedPlan ? syncedWeekForDate(syncedPlan, act.date) : null
          // Phase from synced week when available; local plan only as fallback
          const phase          = syncedWeek?.phase ?? getPhaseForDate(localPlan ?? [], act.date)
          const syncedSession: SyncedPlanSession | null = syncedWeek
            ? syncedSessionForTag(syncedWeek, actTag)
            : null
          // plannedSession shape for RunDetail (display only — uses WorkoutSession interface)
          const plannedSession: WorkoutSession | null = syncedSession
            ? syncedSessionToWorkout(syncedSession)
            : null

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
              effectiveVdot,
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

          // Deviation badge for last 7 activities — only from synced plan (SSoT)
          let deviation: PlanDeviation | null = null
          if (actIdx < 7 && syncedPlan && syncedWeek) {
            const tsb = tsbData?.tsb ?? 0
            if (!syncedSession) {
              // Day not in synced plan = rest day
              deviation = assessDeviationForRestDay(act, tsb)
            } else {
              // null classification is fine — assessDeviation handles it
              deviation = assessDeviation(syncedSessionToWorkout(syncedSession), act, null, tsb)
            }
          }

          const BADGE_LABELS: Record<string, string> = {
            plangemäß: '📋 plangemäß',
            mehr:      '↗️ mehr',
            weniger:   '↘️ weniger',
            ruhetag:   '💤 Ruhetag trainiert',
            frei:      '',  // no plan — don't show badge
          }

          // noteVersion read ensures the list re-renders after a note is saved
          const hasNote = noteVersion >= 0 && loadNote(act.id) !== null
          return (
            <div key={act.id} className="activity-card">
              <div
                className="activity-header"
                onClick={() => toggleExpand(act.id)}
              >
                <span style={{ fontSize: '16px' }}>{actIcon}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '5px', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: '13px', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '160px' }}>
                      {act.name}
                    </span>
                    {deviation && deviation.badge !== 'frei' && (
                      <span style={{
                        fontSize: '10px',
                        padding: '1px 5px',
                        borderRadius: '8px',
                        background: `${deviation.badgeColor}22`,
                        color: deviation.badgeColor,
                        whiteSpace: 'nowrap',
                        flexShrink: 0,
                        fontWeight: 600,
                      }}>
                        {BADGE_LABELS[deviation.badge]}
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--text-2)' }}>
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
                {hasNote && (
                  <span style={{ fontSize: '12px', marginLeft: '2px', flexShrink: 0 }} title="Notiz vorhanden">📝</span>
                )}
                <span style={{ fontSize: '10px', color: 'var(--text-2)', marginLeft: '4px' }}>
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
                      deviation={deviation}
                      vdot={effectiveVdot}
                      onNoteSaved={onNoteSaved}
                    />
                  ) : act.actType === 'ride' ? (
                    <RideDetail analysis={analysis as ReturnType<typeof analyzeRide>} act={act} />
                  ) : (
                    <div style={{ fontSize: '13px', color: 'var(--text-2)' }}>
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
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'var(--text-2)', marginBottom: '8px' }}>
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
                const key        = localISODate(week.weekStart)
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
                      <span style={{ color: 'var(--text-2)' }}>/{plannedW > 0 ? plannedW : '—'}</span>
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
                <div style={{ fontSize: '11px', color: 'var(--text-2)', marginBottom: '8px' }}>
                  Aktivste Woche: {isoWeek(peakWeek.weekStart)} · {peakWeek.actualKm} km
                </div>
              )}
              {/* Extended 12-week chart */}
              <div className="weekly-chart">
                {last12Weeks.map(week => {
                  const key       = localISODate(week.weekStart)
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
                        <span style={{ color: 'var(--text-2)' }}>/{plannedW > 0 ? plannedW : '—'}</span>
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
                      <span style={{ color: 'var(--text-2)' }}>{sport.km} km · {sport.h} h</span>
                    </div>
                    <div style={{ height: '6px', background: 'var(--surface2)', borderRadius: '3px', overflow: 'hidden' }}>
                      <div style={{ height: '100%', background: sport.color, borderRadius: '3px', width: `${Math.min(100, sport.km / totalKm * 100)}%` }} />
                    </div>
                  </div>
                  <span style={{ fontSize: '11px', color: 'var(--text-2)', minWidth: '34px', textAlign: 'right' }}>
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
                  <tr style={{ color: 'var(--text-2)' }}>
                    <th style={{ textAlign: 'left',  padding: '3px 4px', fontWeight: 600 }}>Woche</th>
                    <th style={{ textAlign: 'right', padding: '3px 4px', fontWeight: 600 }}>km</th>
                    <th style={{ textAlign: 'right', padding: '3px 4px', fontWeight: 600 }}>Läufe</th>
                    <th style={{ textAlign: 'right', padding: '3px 4px', fontWeight: 600 }}>Ø Pace</th>
                    <th style={{ textAlign: 'right', padding: '3px 4px', fontWeight: 600 }}>Ø HF</th>
                  </tr>
                </thead>
                <tbody>
                  {trendRows.map(w => {
                    const key = localISODate(w.weekStart)
                    const isCurrent = planWeekMap.has(key)
                    return (
                      <tr key={key} style={{ borderTop: '1px solid var(--border)' }}>
                        <td style={{ padding: '4px', color: isCurrent ? 'var(--accent)' : 'var(--text-2)', fontWeight: isCurrent ? 700 : 400 }}>{isoWeek(w.weekStart)}</td>
                        <td style={{ padding: '4px', textAlign: 'right', fontWeight: 600 }}>{w.actualKm}</td>
                        <td style={{ padding: '4px', textAlign: 'right', color: 'var(--text-2)' }}>{w.runs}</td>
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
              <div style={{ fontSize: '11px', color: 'var(--text-2)', marginTop: '8px' }}>
                💡 Wandern zählt als aerobe Zusatzbelastung — Höhenmeter stärken die kardiale Grundlage.
              </div>
            </div>
          </>
        )
      })()}
    </div>
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
          <div style={{ fontSize: '12px', color: 'var(--text-2)', marginTop: '3px' }}>{analysis.note}</div>
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
      <div style={{ fontSize: '12px', color: 'var(--text-2)', display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
        <span>{durationMin} min</span>
        {analysis.speedKmh > 0 && <span>{analysis.speedKmh} km/h</span>}
        <span>Laufäquivalent: ~{analysis.runEquivMin} min</span>
        <span>Nutzen: {analysis.trainingBenefit}</span>
      </div>
    </>
  )
}

