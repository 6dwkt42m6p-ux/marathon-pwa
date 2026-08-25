import { useState } from 'react'
import {
  fetchActivityStreams,
  fetchActivityLaps,
  classifyWorkoutStructure,
  type ActivitySummary,
  type WorkoutClassification,
  type ActivityStreams,
} from '../lib/strava'
import { analyzeRun, analyzeWorkoutLaps, type WorkoutLapAnalysis } from '../lib/vdot'
import { loadNote, saveNote, deleteNote, type ActivityNote } from '../lib/storage'
import type { WorkoutSession, PlanDeviation } from '../lib/plan'
import { sessionExecutionQuality, executionBadgeParts, dataQualityScore } from '../lib/analytics'
import { fetchSync, pushSync, type SyncData } from '../lib/githubSync'
import {
  buildSaveNoteMutation, buildDeleteNoteMutation,
  appendPendingNoteMutation, loadPendingNoteMutations,
  resolveNote,
  type SyncedNote,
} from '../lib/notesSync'

const ZONE_COLORS: Record<string, string> = {
  Z1: '#42A5F5', Z2: '#4CAF50', Z3: '#FFC107', Z4: '#FF9800', Z5: '#e53935',
}

const ZONE_LABELS_SHORT: Record<string, string> = {
  Z1: 'Z1 · Regeneration', Z2: 'Z2 · Grundlage', Z3: 'Z3 · Aerob',
  Z4: 'Z4 · Schwelle', Z5: 'Z5 · Maximal',
}

function fmt(s: number) {
  const m = Math.floor(s / 60); const sec = Math.round(s % 60)
  return `${m}:${sec.toString().padStart(2, '0')}`
}

function planCheck(planned: WorkoutSession, act: ActivitySummary, classification: WorkoutClassification | null, analysis: ReturnType<typeof analyzeRun>): { icon: string; text: string; color: string }[] {
  const checks: { icon: string; text: string; color: string }[] = []
  const sessionName = planned.session.toLowerCase()
  const plannedKm = typeof planned.distanzKm === 'number' ? planned.distanzKm : parseFloat(String(planned.distanzKm))

  if (!isNaN(plannedKm) && plannedKm > 0) {
    const pct = act.distanceKm / plannedKm
    if (pct >= 0.90)       checks.push({ icon: '✅', text: `Distanz: ${act.distanceKm} km (geplant ${plannedKm} km)`, color: '#4CAF50' })
    else if (pct >= 0.75)  checks.push({ icon: '🟡', text: `Distanz: ${act.distanceKm} km — etwas kürzer als geplant ${plannedKm} km`, color: '#FFC107' })
    else                   checks.push({ icon: '⚠️', text: `Distanz: nur ${act.distanceKm} km von ${plannedKm} km`, color: '#e53935' })
  }

  const strideMatch = planned.session.match(/(\d+)[×x]/)
  if (strideMatch && classification) {
    const targetN = parseInt(strideMatch[1])
    const actualN = classification.strides.length
    if (actualN >= targetN)          checks.push({ icon: '✅', text: `Strides: ${actualN} erkannt (${targetN} geplant)`, color: '#4CAF50' })
    else if (actualN >= targetN - 1) checks.push({ icon: '🟡', text: `Strides: ${actualN} erkannt (${targetN} geplant — fast vollständig)`, color: '#FFC107' })
    else                             checks.push({ icon: '⚠️', text: `Strides: nur ${actualN} erkannt (${targetN} geplant)`, color: '#e53935' })
  } else if (strideMatch && !classification) {
    const targetN = parseInt(strideMatch[1])
    checks.push({ icon: '📈', text: `${targetN} Strides geplant — Pace-Verlauf laden um zu prüfen`, color: '#FF9800' })
  }

  if ((sessionName.includes('marathon-pace') || sessionName.includes('m-pace') || sessionName.includes('tempo')) && !sessionName.includes('stride')) {
    if (analysis.zoneCode === 'M' || analysis.zoneCode === 'T') {
      checks.push({ icon: '✅', text: `Tempo korrekt — Pace im ${analysis.zoneName}-Bereich`, color: '#4CAF50' })
    } else if (analysis.zoneCode === 'E') {
      checks.push({ icon: '🟡', text: `Durchschnitt Easy — Tempo-Abschnitt evtl. kürzer als geplant`, color: '#FFC107' })
    }
  }

  return checks
}

// T-196/D-047: a test-run activity has no target pace — an execution verdict there is
// meaningless (D-040), so it is suppressed entirely and replaced by the Desktop-formatted
// test result. Extracted as a pure function (independent of DOM/hooks) so the branching +
// text composition is directly unit-testable without mounting the component.
export type TestRunResult = { vdot: number; reliable: boolean; text: string }
export type ExecutionSlot =
  | { kind: 'testRun'; text: string }
  | { kind: 'execution'; label: string; detail: string; color: string }
  | null

export function executionSlot(
  classification: WorkoutClassification | null,
  testRuns: Record<string, TestRunResult> | undefined,
  act: ActivitySummary,
  vdot: number,
  streams: ActivityStreams | null,
): ExecutionSlot {
  if (!classification) return null
  const testRun = testRuns?.[String(act.id)]
  if (testRun) return { kind: 'testRun', text: testRun.text }
  const exq = executionBadgeParts(sessionExecutionQuality(classification, vdot, act.distanceKm, streams))
  if (!exq) return null
  // T-193/D-040: bei n_reps==1 sind Fade/CV Formel-Artefakte (keine Messwerte) — nicht
  // als irreführende "0%" zeigen, Einstufung dann erkennbar nur auf die Pace-Treffer stützen.
  const detail = exq.showFadeCv
    ? `Zeit im Ziel ${exq.timeInTargetPct}% · Fade ${exq.repFadePct}% · CV ${exq.splitCvPct}%`
    : `Zeit im Ziel ${exq.timeInTargetPct}% (Einzelmessung — Fade/CV nicht ermittelbar)`
  return { kind: 'execution', label: exq.label, detail, color: exq.color }
}

function WorkoutBadge({ classification }: { classification: WorkoutClassification }) {
  const { workoutType, strides, intervalBlocks, tempoBlocks } = classification

  if (workoutType === 'easy') return null

  const badgeConfig: Record<Exclude<WorkoutClassification['workoutType'], 'easy'>, { label: string; color: string }> = {
    strides:   { label: `⚡ ${strides.length} Strides`,                           color: '#FF9800' },
    intervals: { label: `🔄 ${intervalBlocks.length} Intervall-Block${intervalBlocks.length !== 1 ? 'e' : ''}`, color: '#e53935' },
    tempo:     { label: `🔥 ${Math.round(tempoBlocks.reduce((s, t) => s + t.durationSec, 0) / 60)} min Tempo`, color: '#3b82f6' },
    mixed:     { label: '🔀 Mixed Workout',                                        color: '#9C27B0' },
  }

  const cfg = badgeConfig[workoutType]

  return (
    <div style={{ background: `${cfg.color}18`, border: `1px solid ${cfg.color}44`, borderRadius: '6px', padding: '8px 10px', fontSize: '12px' }}>
      <div style={{ fontWeight: 700, color: cfg.color, marginBottom: strides.length > 0 || intervalBlocks.length > 0 || tempoBlocks.length > 0 ? '6px' : '0' }}>
        {cfg.label}
      </div>

      {strides.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
          {strides.map((s, i) => {
            const peakPaceSec = s.peakSpeedMs > 0 ? Math.round(1000 / s.peakSpeedMs) : 0
            return (
              <div key={i} style={{ display: 'flex', gap: '8px', fontSize: '11px', color: 'var(--text-2)', alignItems: 'center' }}>
                <span style={{ color: '#FF9800', fontWeight: 700, minWidth: '18px' }}>#{i + 1}</span>
                <span>{s.durationSec} s</span>
                {peakPaceSec > 0 && <span style={{ color: 'var(--text-1)' }}>⚡ {fmt(peakPaceSec)} /km</span>}
              </div>
            )
          })}
        </div>
      )}

      {intervalBlocks.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
          {intervalBlocks.map((b, i) => {
            const durMin = Math.floor(b.durationSec / 60)
            const durSec = b.durationSec % 60
            const durLabel = durMin > 0
              ? `${durMin}:${String(durSec).padStart(2, '0')} min`
              : `${durSec} s`
            return (
              <div key={i} style={{ display: 'flex', gap: '8px', fontSize: '11px', color: 'var(--text-2)', alignItems: 'center' }}>
                <span style={{ color: '#e53935', fontWeight: 700, minWidth: '18px' }}>#{i + 1}</span>
                <span>{durLabel}</span>
                <span style={{ color: 'var(--text-1)', fontWeight: 600 }}>{fmt(b.avgPaceSec)} /km</span>
                {b.avgHr && <span>♡ {b.avgHr}</span>}
              </div>
            )
          })}
        </div>
      )}

      {tempoBlocks.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
          {tempoBlocks.map((t, i) => (
            <div key={i} style={{ display: 'flex', gap: '8px', fontSize: '11px', color: 'var(--text-2)', alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ color: '#3b82f6', fontWeight: 700, minWidth: '18px' }}>#{i + 1}</span>
              <span>{Math.round(t.durationSec / 60)} min</span>
              <span style={{ color: 'var(--text-1)', fontWeight: 600 }}>{fmt(t.avgPaceSec)} /km</span>
              {t.paceDeviation !== 0 && (
                <span style={{ color: Math.abs(t.paceDeviation) > 5 ? '#FFC107' : 'var(--text-2)' }}>
                  Drift: {t.paceDeviation > 0 ? '+' : ''}{t.paceDeviation}%
                </span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

interface RunDetailProps {
  analysis: ReturnType<typeof analyzeRun>
  act: ActivitySummary
  phase: string
  plannedSession: WorkoutSession | null
  deviation: PlanDeviation | null
  vdot: number
  onNoteSaved: () => void
  // T-156: Desktop→PWA synced notes (plan.notes), for display merge via resolveNote
  syncedNotes?: Record<string, SyncedNote>
  // T-196/D-047: Desktop-resolved test-run results (sync.json `testRuns`), read-only.
  testRuns?: Record<string, TestRunResult>
}

export default function RunDetail({
  analysis,
  act,
  phase,
  plannedSession,
  deviation,
  vdot,
  onNoteSaved,
  syncedNotes,
  testRuns,
}: RunDetailProps) {
  const [classification, setClassification] = useState<WorkoutClassification | null>(null)
  const [streams,        setStreams]        = useState<ActivityStreams | null>(null)
  const [loadingStream,  setLoadingStream]  = useState(false)
  const [streamErr,      setStreamErr]      = useState<string | null>(null)
  const [lapData,        setLapData]        = useState<WorkoutLapAnalysis | null>(null)
  const [loadingLaps,    setLoadingLaps]    = useState(false)
  const [lapErr,         setLapErr]         = useState<string | null>(null)

  // T-156: merge local localStorage note with synced Desktop note via resolveNote.
  // Local wins when its savedAt >= synced.saved_at (freshest write wins).
  const syncedNote = syncedNotes?.[String(act.id)] ?? null
  const effectiveNote                  = resolveNote(loadNote(act.id), syncedNote)
  const [noteText,   setNoteText]     = useState<string>(effectiveNote?.text ?? '')
  const [noteRating, setNoteRating]   = useState<number>(effectiveNote?.rating ?? 0)
  const [noteSaved,  setNoteSaved]    = useState<ActivityNote | null>(effectiveNote)
  // T-170: saveNote() can fail on quota-exhaustion — surfaced instead of a false success.
  const [noteSaveError, setNoteSaveError] = useState<string | null>(null)

  // T-156: enqueue note mutation in pending list + best-effort push to GitHub.
  // localStorage write (optimistic) happens first; push errors are silent — mutation
  // stays in the pending list for the next flush (App.tsx startup or Settings sync).
  // T-170: appendPendingNoteMutation can fail to persist the queue (quota). If so, the
  // mutation is added to the in-memory payload directly so this immediate push attempt still
  // carries it — the queue write failing must not silently drop the mutation from this flush.
  async function enqueueMutationAndPush(mutation: ReturnType<typeof buildSaveNoteMutation> | ReturnType<typeof buildDeleteNoteMutation>) {
    const queued = appendPendingNoteMutation(mutation)
    try {
      const fresh = await fetchSync(true)
      const allPending = queued ? loadPendingNoteMutations() : [...loadPendingNoteMutations(), mutation]
      // rebuildFn: append ALL local pending mutations to the fresh remote queue, deduped by ts.
      // (T-151 pattern: on 409-retry, re-apply own mutations against the freshly fetched state.)
      const buildPayload = (base: SyncData): SyncData => {
        const existingTs = new Set((base.noteMutations ?? []).map(m => m.ts))
        const toAdd = allPending.filter(m => !existingTs.has(m.ts))
        return { ...base, noteMutations: [...(base.noteMutations ?? []), ...toAdd] }
      }
      await pushSync(buildPayload(fresh?.data ?? {}), fresh?.sha, buildPayload)
    } catch {
      // Offline or conflict — mutation stays in pending list for next flush (if it was queued;
      // if queuing itself failed above, it is lost until the user re-saves — the App-level
      // STORAGE_WARNING_KEY banner already fired via safeSetItem).
    }
  }

  async function handleSaveNote() {
    if (!noteText.trim() && noteRating === 0) return
    const ok = saveNote(act.id, noteText.trim(), noteRating)
    if (!ok) {
      // T-170: Kern des Tickets — Rückgabewert auswerten statt Erfolg vortäuschen.
      setNoteSaveError('Notiz konnte nicht gespeichert werden — Speicher voll.')
      return
    }
    setNoteSaveError(null)
    const saved = loadNote(act.id)!
    setNoteSaved(saved)
    onNoteSaved()
    await enqueueMutationAndPush(buildSaveNoteMutation(act.id, noteText.trim(), noteRating))
  }

  async function handleDeleteNote() {
    deleteNote(act.id)
    setNoteText('')
    setNoteRating(0)
    setNoteSaved(null)
    onNoteSaved()
    await enqueueMutationAndPush(buildDeleteNoteMutation(act.id))
  }

  async function loadLaps(vdotVal: number) {
    setLoadingLaps(true); setLapErr(null)
    try {
      const laps = await fetchActivityLaps(act.id)
      if (!laps || laps.length === 0) { setLapErr('Keine Lap-Daten verfügbar — bitte Lap-Taste auf der Uhr nutzen.'); return }
      const result = analyzeWorkoutLaps(laps, vdotVal)
      if (!result) setLapErr('Zu wenige Laps für Intervallauswertung.')
      else         setLapData(result)
    } catch { setLapErr('Fehler beim Laden der Lap-Daten.') }
    finally   { setLoadingLaps(false) }
  }

  async function loadStreams() {
    setLoadingStream(true); setStreamErr(null)
    try {
      const fetchedStreams = await fetchActivityStreams(act.id)
      if (fetchedStreams === 'rate_limited') {
        setStreamErr('Strava-Rate-Limit erreicht — bitte in ein paar Minuten erneut versuchen.')
      } else if (!fetchedStreams || fetchedStreams.velocity_smooth.length === 0) {
        setStreamErr('Keine Stream-Daten verfügbar.')
      } else {
        setStreams(fetchedStreams)
        setClassification(classifyWorkoutStructure(
          fetchedStreams.time,
          fetchedStreams.velocity_smooth,
          fetchedStreams.heartrate,
          vdot,
        ))
      }
    } catch { setStreamErr('Fehler beim Laden der Stream-Daten.') }
    finally { setLoadingStream(false) }
  }

  const durationMin = act.durationSec > 0 ? Math.round(act.durationSec / 60) : null
  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '8px' }}>
        <div>
          <div style={{ fontSize: '14px', fontWeight: 700 }}>{analysis.verdict}</div>
          <div style={{ fontSize: '12px', color: 'var(--text-2)', marginTop: '3px' }}>{analysis.note}</div>
        </div>
        <div style={{
          fontSize: '11px', padding: '3px 8px', borderRadius: '12px',
          background: `${analysis.zoneColor}22`, color: analysis.zoneColor, whiteSpace: 'nowrap', flexShrink: 0,
        }}>
          {analysis.zoneName}
        </div>
      </div>

      {analysis.tempNote && (
        <div style={{ fontSize: '11px', color: '#FF9800', marginTop: '4px', lineHeight: 1.4 }}>
          {analysis.tempNote}
        </div>
      )}

      {deviation && deviation.badge !== 'frei' && (
        <div style={{
          background: `${deviation.badgeColor}12`,
          border: `1px solid ${deviation.badgeColor}33`,
          borderRadius: '6px',
          padding: '7px 10px',
          fontSize: '12px',
          marginTop: '6px',
        }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', rowGap: '2px', columnGap: '10px' }}>
            <span style={{ color: 'var(--text-2)' }}>Geplant:</span>
            <span style={{ fontWeight: 600 }}>{deviation.plannedLabel}</span>
            <span style={{ color: 'var(--text-2)' }}>Trainiert:</span>
            <span style={{ fontWeight: 600 }}>{deviation.actualType} — {deviation.actualKm} km</span>
            {deviation.kmDelta !== 0 && (
              <>
                <span style={{ color: 'var(--text-2)' }}>Abweichung:</span>
                <span style={{ fontWeight: 600, color: deviation.badgeColor }}>
                  {deviation.kmDelta > 0 ? '+' : ''}{deviation.kmDelta} km
                </span>
              </>
            )}
          </div>
          <div style={{ marginTop: '5px', fontSize: '11px', color: 'var(--text-2)', fontStyle: 'italic', lineHeight: 1.4 }}>
            Coach: &ldquo;{deviation.coachComment}&rdquo;
          </div>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '6px', marginTop: '6px' }}>
        <div style={{ background: 'var(--surface2)', borderRadius: '6px', padding: '6px 8px' }}>
          <div style={{ fontSize: '10px', color: 'var(--text-2)', marginBottom: '2px' }}>
            Ø Pace{act.tempC !== undefined ? ` · ${Math.round(act.tempC)}°C` : ''}
          </div>
          <div style={{ fontSize: '13px', fontWeight: 700 }}>{act.paceFmt} /km</div>
          <div style={{ fontSize: '10px', color: 'var(--text-2)' }}>
            {analysis.adjPaceSec
              ? `≈ ${Math.floor(analysis.adjPaceSec / 60)}:${String(Math.round(analysis.adjPaceSec % 60)).padStart(2, '0')} bereinigt`
              : `Abw. E-Mitte: ${analysis.devStr}`}
          </div>
        </div>
        <div style={{ background: 'var(--surface2)', borderRadius: '6px', padding: '6px 8px' }}>
          <div style={{ fontSize: '10px', color: 'var(--text-2)', marginBottom: '2px' }}>Ø Herzfrequenz</div>
          <div style={{ fontSize: '13px', fontWeight: 700 }}>{act.avgHr ? `${Math.round(act.avgHr)} bpm` : '—'}</div>
          <div style={{ fontSize: '10px', color: analysis.hrZone ? (ZONE_COLORS[analysis.hrZone] ?? 'var(--text-2)') : 'var(--text-2)' }}>
            {analysis.hrZone ? ZONE_LABELS_SHORT[analysis.hrZone] ?? analysis.hrZone : '—'}
          </div>
        </div>
        <div style={{ background: 'var(--surface2)', borderRadius: '6px', padding: '6px 8px' }}>
          <div style={{ fontSize: '10px', color: 'var(--text-2)', marginBottom: '2px' }}>HF-Max</div>
          <div style={{ fontSize: '13px', fontWeight: 700 }}>{act.maxHr ? `${Math.round(act.maxHr)} bpm` : '—'}</div>
          <div style={{ fontSize: '10px', color: analysis.maxHrZone ? (ZONE_COLORS[analysis.maxHrZone] ?? 'var(--text-2)') : 'var(--text-2)' }}>
            {analysis.maxHrZone ? `${ZONE_LABELS_SHORT[analysis.maxHrZone] ?? analysis.maxHrZone} · ${analysis.maxHrPct}% HFR` : '—'}
          </div>
        </div>
      </div>

      {!classification && (
        <button
          style={{ fontSize: '11px', padding: '10px 14px', minHeight: '44px', borderRadius: '8px', border: '1px solid var(--border)', background: 'transparent', color: 'var(--text-2)', cursor: 'pointer', alignSelf: 'flex-start', display: 'flex', alignItems: 'center' }}
          onClick={loadStreams}
          disabled={loadingStream}
        >
          {loadingStream ? '⏳ Lädt…' : '📈 Workout analysieren'}
        </button>
      )}
      {streamErr && <div style={{ color: '#e53935', fontSize: '11px' }}>{streamErr}</div>}

      {classification && <WorkoutBadge classification={classification} />}

      {(() => {
        const slot = executionSlot(classification, testRuns, act, vdot, streams)
        if (!slot) return null
        if (slot.kind === 'testRun') {
          return (
            <div style={{ marginTop: 8, fontSize: 13, color: '#3498DB', fontWeight: 600 }}>
              {'🏁'} Testlauf — {slot.text}
            </div>
          )
        }
        return (
          <div style={{ marginTop: 8, fontSize: 13, color: slot.color, fontWeight: 600 }}>
            {'🎯'} {slot.label} — {slot.detail}
          </div>
        )
      })()}

      {streams && (() => {
        const dq = dataQualityScore(streams)
        return (
          <div style={{ marginTop: 4, fontSize: 11, color: 'var(--text-2)' }}>
            {'📶'} Datenqualität: <span style={{ color: dq.color }}>{dq.reliability}</span> ({Math.round(dq.score)}/100)
            {dq.flags.length ? ' — ' + dq.flags.join('; ') : ''}
          </div>
        )
      })()}

      {(act.workoutType ?? 0) > 1 && (
        <div style={{ background: '#FFC10722', border: '1px solid #FFC10744', borderRadius: '6px', padding: '8px 10px', fontSize: '12px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: lapData ? '8px' : '0' }}>
            <span style={{ fontWeight: 700, color: '#FFC107' }}>🏋️ Intervallauswertung</span>
            {!lapData && (
              <button
                style={{ fontSize: '11px', padding: '10px 12px', minHeight: '44px', borderRadius: '8px', border: '1px solid #FFC107', background: 'transparent', color: '#FFC107', cursor: 'pointer', display: 'flex', alignItems: 'center' }}
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
                <div style={{ color: 'var(--text-2)', fontSize: '11px' }}>
                  ℹ️ Nur automatische 1km-Splits erkannt — für Intervallauswertung bitte Lap-Taste auf der Uhr drücken.
                </div>
              ) : (
                <>
                  <div style={{ color: 'var(--text-2)', marginBottom: '6px', lineHeight: 1.5 }}>
                    {lapData.wuNote} · {lapData.cdNote}<br />{lapData.rvNote}
                  </div>
                  {lapData.nIntervals > 0 && (
                    <div style={{ borderTop: '1px solid #FFC10733', paddingTop: '6px' }}>
                      <div style={{ fontSize: '10px', color: 'var(--text-2)', marginBottom: '4px', fontWeight: 600 }}>
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
                      <div style={{ fontSize: '10px', color: 'var(--text-2)', marginBottom: '4px', fontWeight: 600 }}>ALLE LAPS</div>
                      {lapData.laps.map((lp, i) => {
                        const roleColor: Record<string, string> = { warmup: '#42A5F5', interval: '#e53935', recovery: '#4CAF50', cooldown: '#42A5F5', easy: 'var(--text-2)' }
                        return (
                          <div key={i} style={{ display: 'flex', gap: '8px', fontSize: '11px', color: 'var(--text-2)', alignItems: 'center', lineHeight: 1.7 }}>
                            <span style={{ color: roleColor[lp.role] ?? 'var(--text-2)', minWidth: '18px', fontWeight: 600 }}>#{lp.idx}</span>
                            <span style={{ color: roleColor[lp.role], fontSize: '10px', minWidth: '56px' }}>{lp.role}</span>
                            <span style={{ color: 'var(--text-1)', fontWeight: lp.role === 'interval' ? 700 : 400 }}>{lp.paceFmt}</span>
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

      {plannedSession && (() => {
        const checks = planCheck(plannedSession, act, classification, analysis)
        if (checks.length === 0) return null
        return (
          <div style={{ background: 'var(--surface2)', borderRadius: '6px', padding: '8px 10px', fontSize: '12px' }}>
            <div style={{ fontWeight: 700, marginBottom: '4px', fontSize: '11px', color: 'var(--text-2)' }}>
              PLAN-CHECK · {plannedSession.session}
            </div>
            {checks.map((c, i) => (
              <div key={i} style={{ color: c.color, lineHeight: 1.6 }}>{c.icon} {c.text}</div>
            ))}
          </div>
        )
      })()}

      <div style={{ fontSize: '11px', color: 'var(--text-2)', display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
        <span>Phase: {phase}</span>
        {act.distanceKm > 0 && <span>{act.distanceKm} km</span>}
        {durationMin && <span>{durationMin} min</span>}
        {act.elevationM > 0 && <span>↑ {act.elevationM} m</span>}
      </div>

      {analysis.hrNote && !analysis.strideDetected && (
        <div style={{ fontSize: '12px', color: 'var(--text-2)', fontStyle: 'italic' }}>
          💬 {analysis.hrNote}
        </div>
      )}

      <div style={{ background: 'var(--surface2)', borderRadius: '6px', padding: '10px' }}>
        <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-2)', marginBottom: '8px', letterSpacing: '0.04em' }}>
          📝 NOTIZ & BEFINDEN
        </div>
        <div style={{ display: 'flex', gap: '6px', marginBottom: '8px' }}>
          {[1, 2, 3, 4, 5].map(star => (
            <button
              key={star}
              onClick={() => setNoteRating(prev => prev === star ? 0 : star)}
              style={{
                fontSize: '20px',
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
                padding: '0',
                lineHeight: 1,
                opacity: star <= noteRating ? 1 : 0.25,
              }}
              aria-label={`Befinden: ${star} von 5`}
            >
              ⭐
            </button>
          ))}
        </div>
        <textarea
          value={noteText}
          onChange={e => setNoteText(e.target.value)}
          placeholder="Wie war das Training? Besonderheiten, Müdigkeit, Stimmung…"
          rows={3}
          style={{
            width: '100%',
            fontSize: '13px',
            padding: '8px',
            borderRadius: '6px',
            border: '1px solid var(--border)',
            background: 'var(--surface1)',
            color: 'var(--text-1)',
            resize: 'vertical',
            boxSizing: 'border-box',
          }}
        />
        <div style={{ display: 'flex', gap: '8px', marginTop: '8px', alignItems: 'center' }}>
          <button
            onClick={handleSaveNote}
            disabled={!noteText.trim() && noteRating === 0}
            style={{
              fontSize: '12px',
              padding: '5px 14px',
              borderRadius: '8px',
              border: 'none',
              background: 'var(--accent)',
              color: '#fff',
              cursor: (!noteText.trim() && noteRating === 0) ? 'not-allowed' : 'pointer',
              opacity: (!noteText.trim() && noteRating === 0) ? 0.5 : 1,
            }}
          >
            Speichern
          </button>
          {noteSaved && (
            <button
              onClick={handleDeleteNote}
              style={{
                fontSize: '12px',
                padding: '5px 14px',
                borderRadius: '8px',
                border: '1px solid var(--border)',
                background: 'transparent',
                color: 'var(--text-2)',
                cursor: 'pointer',
              }}
            >
              Löschen
            </button>
          )}
          {noteSaved && (
            <span style={{ fontSize: '11px', color: '#4CAF50', marginLeft: '4px' }}>
              ✓ Gespeichert {new Date(noteSaved.savedAt).toLocaleDateString('de-AT', { day: '2-digit', month: 'short' })}
            </span>
          )}
        </div>
        {noteSaveError && (
          <div style={{ fontSize: '11px', color: '#e53935', marginTop: '6px' }}>
            ⚠️ {noteSaveError}
          </div>
        )}
      </div>
    </>
  )
}
