// T-196/D-047: a test-run activity must never show an execution verdict — a time trial has no
// target pace, so "sauber"/"verfehlt" is meaningless there (D-040). Weg B (sync.json `testRuns`,
// Desktop-resolved, display-ready `text`) is rendered instead. Tested against the pure
// `executionSlot` helper (no RTL in this repo — vitest.config.ts only globs `*.test.ts`, and
// the badge decision has no DOM dependency worth mounting the component for).

import { describe, it, expect } from 'vitest'
import { executionSlot, type TestRunResult } from './RunDetail'
import type { WorkoutClassification, ActivitySummary } from '../lib/strava'

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
