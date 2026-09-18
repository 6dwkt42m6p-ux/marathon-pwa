// T-196/D-047: a test-run activity must never show an execution verdict — a time trial has no
// target pace, so "sauber"/"verfehlt" is meaningless there (D-040). Weg B (sync.json `testRuns`,
// Desktop-resolved, display-ready `text`) is rendered instead. Tested against the pure
// `executionSlot` helper (no RTL in this repo — vitest.config.ts only globs `*.test.ts`, and
// the badge decision has no DOM dependency worth mounting the component for).

import { describe, it, expect } from 'vitest'
import { executionSlot, planCheck, type TestRunResult } from './RunDetail'
import type { WorkoutClassification, ActivitySummary } from '../lib/strava'
import type { WorkoutSession } from '../lib/plan'
import { analyzeRun } from '../lib/vdot'

const cls = (extra: Partial<WorkoutClassification> = {}): WorkoutClassification => ({
  workoutType: 'intervals', strides: [], intervalBlocks: [], tempoBlocks: [], ...extra,
})

const act = (id: number, distanceKm = 8): ActivitySummary => ({
  id, name: 'Intervalle', date: new Date('2026-08-20'), distanceKm, durationSec: 2400,
  paceSec: 300, paceFmt: '5:00', elevationM: 0, actType: 'run', isTrail: false,
})

// Real interval blocks → sessionExecutionQuality/executionBadgeParts return non-null, so the
// "unmarked" test exercises the actual badge path, not a stub.
const intervalClassification = cls({
  intervalBlocks: Array(4).fill({ startSec: 0, durationSec: 180, avgPaceSec: 222, avgHr: 175 }),
})

describe('executionSlot (T-196)', () => {
  it('classification not yet loaded → null (no badge, no testlauf line) regardless of testRuns', () => {
    const testRuns: Record<string, TestRunResult> = { '42': { vdot: 49, reliable: true, text: 'VDOT 49.0' } }
    expect(executionSlot(null, testRuns, act(42), 50, null)).toBeNull()
  })

  it('(a) activity marked in testRuns → testRun slot with the given text, not an execution verdict', () => {
    const testRuns: Record<string, TestRunResult> = {
      '42': { vdot: 49.0, reliable: true, text: 'VDOT 49.0 · Segment 5.01 km in 4:03/km' },
    }
    const slot = executionSlot(intervalClassification, testRuns, act(42), 50, null)
    expect(slot).toEqual({ kind: 'testRun', text: 'VDOT 49.0 · Segment 5.01 km in 4:03/km' })
  })

  it('(b) activity NOT in testRuns → execution slot unchanged (badge path still fires)', () => {
    const testRuns: Record<string, TestRunResult> = { '999': { vdot: 49, reliable: true, text: 'other activity' } }
    const slot = executionSlot(intervalClassification, testRuns, act(42), 50, null)
    expect(slot).not.toBeNull()
    expect(slot?.kind).toBe('execution')
  })

  it('(c) testRuns undefined entirely (old sync.json snapshot) → no crash, execution slot unchanged', () => {
    const slot = executionSlot(intervalClassification, undefined, act(42), 50, null)
    expect(slot).not.toBeNull()
    expect(slot?.kind).toBe('execution')
  })

  it('(d) testRuns is an empty object → no crash, execution slot unchanged (same as (c))', () => {
    const slot = executionSlot(intervalClassification, {}, act(42), 50, null)
    expect(slot).not.toBeNull()
    expect(slot?.kind).toBe('execution')
  })

  it('activity id is matched as a string key (JSON object keys are always strings)', () => {
    const testRuns: Record<string, TestRunResult> = { '42': { vdot: 49, reliable: false, text: 'unsicher' } }
    const slot = executionSlot(intervalClassification, testRuns, act(42), 50, null)
    expect(slot).toEqual({ kind: 'testRun', text: 'unsicher' })
  })
})

// ── planCheck (T-221) ────────────────────────────────────────────────────────
// Real sessions verbatim from data/sync.json (T-221 finding: `syncedSessionToWorkout`,
// Analysis.tsx, always sets `session`/`typ` to Desktop's `typ` string — "Speed", "Qualität ⭐".
// The old planCheck regex/keyword-match fired against `.session`, so against a REAL synced
// session Strides/Tempo checks never triggered — only the distance check lived. vorgabe/struktur
// carry the actual workout text (rep counts, pace markers).
const speedDrillsSession = (): WorkoutSession => ({
  session: 'Speed', typ: 'Speed', distanzKm: 5.0,
  vorgabe: '5:04 /km + 8×100m @ 3:49 /km',
  struktur: '5 km @ 5:04 /km (Z2) → 8×100m Strides @ 3:49 /km (~22–28 Sek./Stück — kontrolliert beschleunigen, letzten 20m in Pace halten) — Pause: 45 Sek. locker gehen → 1 km @ 5:04+ /km auslaufen',
  dauerMin: '28–30 min', hinweis: 'Strides sind kein Sprint.', wochentag: 'Di',
})

const tempoSession = (): WorkoutSession => ({
  session: 'Qualität ⭐', typ: 'Qualität ⭐', distanzKm: 7.0,
  vorgabe: '2×10 min @ 4:24 /km (T-Pace, Z4)',
  struktur: '2 km @ 5:04 /km einlaufen (10–12 min) → 2×10 min @ 4:24 /km (Z4) — Pause: 90 Sek. Easy-Jogging → 1 km @ 5:04+ /km auslaufen',
  dauerMin: '34–36 min', hinweis: 'Pace muss kontrolliert gehalten werden.', wochentag: 'Do',
})

const ausdauerSession = (): WorkoutSession => ({
  session: 'Ausdauer', typ: 'Ausdauer', distanzKm: 16.0,
  vorgabe: '5:04 – 5:50 /km (Z2)',
  struktur: 'Durchgehend locker @ 5:04–5:50 /km (Z2). Erste Hälfte am unteren Ende, zweite Hälfte darf etwas flotter sein.',
  dauerMin: '88–104 min', hinweis: 'Gespräch möglich.', wochentag: 'So',
})

const runAct = (distanceKm: number): ActivitySummary => ({
  id: 1, name: 'Lauf', date: new Date('2026-08-20'), distanceKm, durationSec: distanceKm * 300,
  paceSec: 300, paceFmt: '5:00', elevationM: 0, actType: 'run', isTrail: false,
})

// VDOT 47.9, same as data/sync.json's plan.vdot — trainingPaces(47.9).T === 264s/km (4:24/km),
// matching the tempoSession() vorgabe exactly.
const tEffortAnalysis = () => analyzeRun(264, 7.0, undefined, undefined, 47.9, 190, 50, 'Basis', true, false)
const easyEffortAnalysis = () => analyzeRun(320, 5.0, undefined, undefined, 47.9, 190, 50, 'Basis', false, false)

describe('planCheck (T-221)', () => {
  it('Strides-Check fires for a real Speed-Drills session (8×100m in vorgabe/struktur) — a real synced session, not a session-name string the old regex could ever match', () => {
    const classification = cls({ workoutType: 'strides', strides: Array(8).fill({ startSec: 0, durationSec: 25, peakSpeedMs: 5.2 }) })
    const checks = planCheck(speedDrillsSession(), runAct(5.0), classification, easyEffortAnalysis())
    expect(checks.some(c => c.text.includes('Strides: 8 erkannt (8 geplant)'))).toBe(true)
  })

  it('Strides-Check: fewer strides detected than planned → warning tier, not silently absent', () => {
    const classification = cls({ workoutType: 'strides', strides: Array(3).fill({ startSec: 0, durationSec: 25, peakSpeedMs: 5.2 }) })
    const checks = planCheck(speedDrillsSession(), runAct(5.0), classification, easyEffortAnalysis())
    expect(checks.some(c => c.text.includes('Strides: nur 3 erkannt (8 geplant)'))).toBe(true)
  })

  it('Tempo-Check fires for a real "Qualität ⭐" session at T-Pace — typ carries the trigger, not a "tempo" substring in `.session`', () => {
    const checks = planCheck(tempoSession(), runAct(7.0), null, tEffortAnalysis())
    expect(checks.some(c => c.text.includes('Tempo korrekt'))).toBe(true)
  })

  it('Ausdauer session (no strides marker, no MP/T-Pace in vorgabe) → only the distance check fires', () => {
    const checks = planCheck(ausdauerSession(), runAct(16.0), null, easyEffortAnalysis())
    expect(checks.length).toBe(1)
    expect(checks[0].text).toContain('Distanz')
  })

  it('Distanz-Check still fires for all three session types (regression: new field reads must not break the pre-existing check)', () => {
    expect(planCheck(speedDrillsSession(), runAct(5.0), null, easyEffortAnalysis()).some(c => c.text.includes('Distanz'))).toBe(true)
    expect(planCheck(tempoSession(), runAct(7.0), null, tEffortAnalysis()).some(c => c.text.includes('Distanz'))).toBe(true)
    expect(planCheck(ausdauerSession(), runAct(16.0), null, easyEffortAnalysis()).some(c => c.text.includes('Distanz'))).toBe(true)
  })
})
