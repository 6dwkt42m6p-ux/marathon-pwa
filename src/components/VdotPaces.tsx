import { useState, useEffect } from 'react'
import { buildPaceTable, feasibilityCheck, vdotFromRace, hrZones, racePredictor, type RacePredictorResult } from '../lib/vdot'
import { getCachedActivities, computeAtlCtl, ctlRising, type SyncedThreshold } from '../lib/strava'
import { durabilityTrend, loadAllDurability } from '../lib/durability'
import type { AppSettings } from '../lib/storage'
import { resolvePreRaceEnabled } from '../lib/storage'
import { fetchSync } from '../lib/githubSync'

interface Props {
  settings: AppSettings
  // T-123: canonical VDOT from App — desktop sync wins, settings.vdot is offline fallback
  effectiveVdot: number
  syncedFtp?: number | null
  syncedThreshold?: SyncedThreshold | null
  // T-158(b): true when no settings saved and no sync → DEFAULTS.vdot in use (show notice)
  usingDefaultVdot?: boolean
}

export default function VdotPaces({ settings, effectiveVdot, syncedFtp, syncedThreshold, usingDefaultVdot = false }: Props) {
  const vdot = effectiveVdot
  const paces = buildPaceTable(vdot)

  // T-182 Phase B review fix (Bug 2): Event 1 (the prep race) can be disabled on the Desktop
  // (preRaceEnabled: false). mergeRemoteSettings (storage.ts) already stops a `null`
  // raceDate1 from corrupting settings.raceDate1 into an epoch date — but even with a valid
  // leftover local raceDate1, showing a countdown for a race the Desktop says no longer exists
  // is misleading. Own fetchSync() call, same pattern as TodayWorkout.tsx/Settings.tsx; the
  // module-level 60s cache in githubSync.ts means this is not an extra network round-trip.
  const [syncSettings, setSyncSettings] = useState<Record<string, unknown> | null>(null)
  useEffect(() => {
    let mounted = true
    fetchSync().then(result => { if (mounted && result) setSyncSettings(result.data.settings ?? null) })
      .catch(() => { /* best-effort, same pattern as other components */ })
    return () => { mounted = false }
  }, [])
  const preRaceActive = resolvePreRaceEnabled(settings.preRaceEnabled, syncSettings)

  // Target VDOTs
  const vdotHmSub130 = vdotFromRace(21097, 89 * 60 + 59)
  const vdotMarSub300 = vdotFromRace(42195, 179 * 60 + 59)

  const hmDate  = new Date(settings.raceDate1)
  const marDate = new Date(settings.raceDate2)
  const now     = new Date()
  const hmWeeks  = Math.max(0, Math.floor((hmDate.getTime()  - now.getTime()) / (7 * 24 * 3600 * 1000)))
  const marWeeks = Math.max(0, Math.floor((marDate.getTime() - now.getTime()) / (7 * 24 * 3600 * 1000)))

  const hmFeas  = feasibilityCheck(vdot, vdotHmSub130,  hmWeeks)
  const marFeas = feasibilityCheck(vdot, vdotMarSub300, marWeeks)

  // T-146: Race-Predictor inputs from cached activities + derived signals
  const _acts    = getCachedActivities()
  const _atl     = computeAtlCtl(_acts, syncedFtp ?? undefined, syncedThreshold ?? undefined)
  const _rising  = ctlRising(_acts, syncedFtp ?? undefined, syncedThreshold ?? undefined)
  const _fade    = durabilityTrend(loadAllDurability())?.fade?.recentAvg ?? null
  const _lowData = _acts.length < 10

  const hmPred  = racePredictor(vdot, 21097, { weeksToRace: hmWeeks,  tsb: _atl.tsb, ctlRising: _rising, paceFadeRecent: _fade, lowData: _lowData })
  const marPred = racePredictor(vdot, 42195, { weeksToRace: marWeeks, tsb: _atl.tsb, ctlRising: _rising, paceFadeRecent: _fade, lowData: _lowData })

  return (
    <div className="tab-content">
      <div className="section-title">VDOT {vdot.toFixed(1)} — Trainingspaces</div>
      {usingDefaultVdot && (
        <div className="info-banner" style={{ marginBottom: '12px', opacity: 0.8, fontSize: '0.82rem' }}>
          (Standardwert — bitte Settings/Sync)
        </div>
      )}

      <div className="paces-table">
        <PaceSection label="Easy (E)" sub="Grundlagentraining" color="#4CAF50">
          <PaceRow label="Obere Grenze" val={paces.E_high} />
          <PaceRow label="Untere Grenze" val={paces.E_low} />
        </PaceSection>

        <PaceSection label="Marathon-Pace (M)" sub="Mittellange DLs" color="#FFC107">
          <PaceRow label="M-Pace" val={paces.M} />
        </PaceSection>

        <PaceSection label="Schwelle (T)" sub="Lactate threshold" color="#FF9800">
          <PaceRow label="T-Pace" val={paces.T} />
        </PaceSection>

        <PaceSection label="Intervall (I)" sub="VO2max-Training" color="#e53935">
          <PaceRow label="I-Pace" val={paces.I} />
          <PaceRow label="400m" val={paces.I_400m} sub />
          <PaceRow label="600m" val={paces.I_600m} sub />
          <PaceRow label="800m" val={paces.I_800m} sub />
          <PaceRow label="1000m" val={paces.I_1000m} sub />
          <PaceRow label="1200m" val={paces.I_1200m} sub />
        </PaceSection>

        <PaceSection label="Repetition (R)" sub="Neuromuskulär" color="#9C27B0">
          <PaceRow label="R-Pace" val={paces.R} />
        </PaceSection>
      </div>

      <div className="section-title">Zielbewertung</div>

      <div className="feasibility-list">
        {preRaceActive && (
          <>
            <FeasCard
              title="Sub 1:30h Halbmarathon"
              date={hmDate}
              weeks={hmWeeks}
              currentVdot={vdot}
              targetVdot={vdotHmSub130}
              feas={hmFeas}
            />
            <PredictorCard title="Prognose Halbmarathon" pred={hmPred} />
          </>
        )}
        <FeasCard
          title="Sub 3:00h Marathon"
          date={marDate}
          weeks={marWeeks}
          currentVdot={vdot}
          targetVdot={vdotMarSub300}
          feas={marFeas}
        />
        <PredictorCard title="Prognose Marathon" pred={marPred} />
      </div>

      <div className="section-title">Herzfrequenzzonen (Karvonen)</div>
      <HrZonesTable maxHr={settings.maxHr} restHr={settings.restHr} />
    </div>
  )
}

function _fmtHms(sec: number | null): string {
  if (sec == null) return '—'
  const s = Math.round(sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = s % 60
  return `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
}

function PredictorCard({ title, pred }: { title: string; pred: RacePredictorResult }) {
  if (pred.predictedSec == null) {
    return (
      <div className="feas-card">
        <div className="feas-header">
          <div>
            <span className="feas-title">{title}</span>
          </div>
        </div>
        <p className="feas-msg" style={{ color: 'var(--text-2)', fontSize: 12 }}>
          Prognose noch nicht möglich (zu wenig Daten).
        </p>
      </div>
    )
  }
  const confColor = pred.confidence === 'hoch' ? '#2ECC71' : pred.confidence === 'mittel' ? '#F1C40F' : '#E74C3C'
  return (
    <div className="feas-card">
      <div className="feas-header">
        <span className="feas-emoji">&#128302;</span>
        <div>
          <span className="feas-title">{title}</span>
          <span className="feas-rating" style={{ color: confColor }}>Konfidenz {pred.confidence}</span>
        </div>
      </div>
      <div className="feas-details">
        <span style={{ fontSize: 20, fontWeight: 700 }}>{_fmtHms(pred.predictedSec)}</span>
        <span style={{ color: confColor }}>
          {_fmtHms(pred.rangeLowSec)} – {_fmtHms(pred.rangeHighSec)}
        </span>
      </div>
      {pred.notes.map((n, i) => (
        <p key={i} className="feas-msg" style={{ fontSize: 11, marginTop: 2 }}>• {n}</p>
      ))}
    </div>
  )
}

function PaceSection({ label, sub, color, children }: { label: string; sub: string; color: string; children: React.ReactNode }) {
  return (
    <div className="pace-section">
      <div className="pace-section-header">
        <div className="pace-section-dot" style={{ background: color }} />
        <div>
          <span className="pace-section-label">{label}</span>
          <span className="pace-section-sub">{sub}</span>
        </div>
      </div>
      {children}
    </div>
  )
}

function PaceRow({ label, val, sub = false }: { label: string; val: string; sub?: boolean }) {
  return (
    <div className={`pace-detail-row ${sub ? 'sub' : ''}`}>
      <span className="pd-label">{label}</span>
      <span className="pd-val">{val} /km</span>
    </div>
  )
}

function FeasCard({ title, date, weeks, currentVdot, targetVdot, feas }:
  { title: string; date: Date; weeks: number; currentVdot: number; targetVdot: number; feas: ReturnType<typeof feasibilityCheck> }) {
  const dateStr = date.toLocaleDateString('de-AT', { day: '2-digit', month: 'long', year: 'numeric' })
  return (
    <div className="feas-card" style={{ borderLeftColor: feas.color }}>
      <div className="feas-header">
        <span className="feas-emoji">{feas.emoji}</span>
        <div>
          <span className="feas-title">{title}</span>
          <span className="feas-rating" style={{ color: feas.color }}>{feas.rating}</span>
        </div>
      </div>
      <div className="feas-details">
        <span>{dateStr} · {weeks} Wochen</span>
        <span>VDOT: {currentVdot.toFixed(1)} → {targetVdot.toFixed(1)} (Δ{feas.delta > 0 ? '+' : ''}{feas.delta.toFixed(1)})</span>
      </div>
      <p className="feas-msg">{feas.message}</p>
    </div>
  )
}

const HR_ZONE_COLORS = ['#42A5F5', '#4CAF50', '#FFC107', '#FF9800', '#e53935']

function HrZonesTable({ maxHr, restHr }: { maxHr: number; restHr: number }) {
  const zones = hrZones(maxHr, restHr)
  return (
    <div className="hr-zones-table">
      {zones.map((z, i) => (
        <div key={z.zone} className="hr-zone-row">
          <div className="hz-dot" style={{ background: HR_ZONE_COLORS[i] }} />
          <span className="hz-name">{z.zone}</span>
          <span className="hz-bpm">{z.hfRange} · {z.pctMax} HFmax</span>
          <span className="hz-jd">JD: {z.jdZone}</span>
        </div>
      ))}
    </div>
  )
}
