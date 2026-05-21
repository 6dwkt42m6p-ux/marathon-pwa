import { useState } from 'react'
import { generatePlan } from '../lib/plan'
import { getCachedActivities, parseRuns, computeWeeklyStats } from '../lib/strava'
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
  const [selectedPlan, setSelectedPlan] = useState<'1' | '2'>('2')

  // Build actual km per week from Strava cache
  const cached      = getCachedActivities()
  const runs        = parseRuns(cached)
  const weeklyStats = computeWeeklyStats(runs)
  const actualKmMap = new Map<string, number>()
  for (const w of weeklyStats) {
    actualKmMap.set(w.weekStart.toISOString().slice(0, 10), w.actualKm)
  }

  const plan1 = generatePlan(raceDate1, settings.currentWeeklyKm, settings.runsPerWeek, settings.raceType1)
  const plan2 = generatePlan(raceDate2, settings.currentWeeklyKm, settings.runsPerWeek, settings.raceType2, preRaceDate)

  const activePlan = selectedPlan === '1' ? plan1 : plan2

  const currentIdx = activePlan.findIndex(r => r.isCurrent)

  return (
    <div className="tab-content">
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
