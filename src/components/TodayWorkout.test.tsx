// T-217 regression: a day-swap saved on the iPhone (localStorage `week_override_<wKey>` +
// pending `weekOverrides` push) must survive a reload. Before the fix, `assignments` was only
// initialized once at mount (`wKey` still 'noweek', fetchSync resolves later) — a real override
// was silently invisible after every app start/tab switch (no ↻ marker, no Reset button).
//
// Fall A/B/C below mirror the ticket's probe exactly. React 19 no longer ships `act` from
// 'react-dom/test-utils' as the primary entry point — imported from 'react' directly, per the
// framework's own guidance. This is the first .tsx component-mount test in this repo (all other
// component tests exercise pure exported helpers) — vitest `test.include` had to be widened to
// `src/**/*.test.{ts,tsx}` (vite.config.ts) for this file to even be picked up.
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import TodayWorkout from './TodayWorkout'
import { mondayOf, localISODate } from '../lib/strava'
import type { AppSettings } from '../lib/storage'
import type { SyncData, SyncedPlan, SyncedPlanSession } from '../lib/githubSync'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../lib/githubSync', async () => {
  const actual = await vi.importActual<typeof import('../lib/githubSync')>('../lib/githubSync')
  return {
    ...actual,
    hasToken: vi.fn(() => false),
    fetchSync: vi.fn(),
    pushSync: vi.fn(),
  }
})

import { fetchSync } from '../lib/githubSync'

const weekStart = localISODate(mondayOf(new Date()))

const baseSettings: AppSettings = {
  vdot: 47.9,
  maxHr: 190,
  restHr: 50,
  currentWeeklyKm: 50,
  runsPerWeek: 5,
  raceType1: 'hm',
  raceDate1: '2026-10-11',
  raceType2: 'marathon',
  raceDate2: '2027-04-25',
  preRaceEnabled: true,
  experience: 'fortgeschritten',
  name: '',
}

function buildPlan(sessions: SyncedPlanSession[]): SyncedPlan {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    generatedBy: 'streamlit',
    vdot: baseSettings.vdot,
    paces: { E_low: '6:00', E_high: '5:30', M: '4:40', T: '4:20', I: '4:00', R: '3:50' },
    inputHash: 'test-hash',
    weeks: [{
      week_nr: 1,
      week_start: weekStart,
      phase: 'Basis',
      planned_km: 40,
      is_current: true,
      sessions,
    }],
  }
}

function syncResult(plan: SyncedPlan, weekOverrides?: Record<string, Record<string, string>>): { data: SyncData; sha: string } {
  return { data: { plan, weekOverrides }, sha: 'sha-1' }
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  localStorage.clear()
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => { root.unmount() })
  container.remove()
  vi.restoreAllMocks()
})

async function mount() {
  await act(async () => {
    root.render(<TodayWorkout settings={baseSettings} />)
  })
  // Second flush: state updates from the resolved fetchSync() promise trigger the wKey/syncedPlan
  // effect (T-217 AC3), which itself schedules another render — give it a tick to settle.
  await act(async () => { await Promise.resolve() })
}

describe('TodayWorkout — T-217 day-swap persists across reload', () => {
  it('Fall A: override already applied by Desktop (tag shifted, original_tag set, weekOverrides has it) → marker + reset shown, session at Mi, not shifted a second time', async () => {
    localStorage.setItem(`week_override_${weekStart}`, JSON.stringify([{ originalDay: 'Di', currentDay: 'Mi' }]))
    const plan = buildPlan([
      { tag: 'Mi', typ: 'Easy', km: 8, vorgabe: 'locker', struktur: '8km locker', dauer: '45 min', hinweis: 'ruhig starten', original_tag: 'Di' },
    ])
    ;(fetchSync as unknown as Mock).mockResolvedValue(syncResult(plan, { [weekStart]: { Di: 'Mi' } }))

    await mount()

    const text = container.textContent ?? ''
    expect(text).toContain('↻ verschoben')
    expect(text).toContain('Zurücksetzen')

    const miRow = Array.from(container.querySelectorAll('.session-row')).find(row => row.textContent?.includes('Easy'))
    expect(miRow).toBeTruthy()
    const dayLabel = miRow!.querySelector('.session-day')?.textContent
    expect(dayLabel).toBe('Mi')
  })

  it('Fall B: pending local-only override (weekOverrides empty, Desktop has not rebuilt yet) → session shown at Mi, marker shown', async () => {
    localStorage.setItem(`week_override_${weekStart}`, JSON.stringify([{ originalDay: 'Di', currentDay: 'Mi' }]))
    const plan = buildPlan([
      { tag: 'Di', typ: 'Easy', km: 8, vorgabe: 'locker', struktur: '8km locker', dauer: '45 min', hinweis: 'ruhig starten', original_tag: 'Di' },
    ])
    ;(fetchSync as unknown as Mock).mockResolvedValue(syncResult(plan, {}))

    await mount()

    const text = container.textContent ?? ''
    expect(text).toContain('↻ verschoben')

    const miRow = Array.from(container.querySelectorAll('.session-row')).find(row => row.textContent?.includes('Easy'))
    expect(miRow).toBeTruthy()
    expect(miRow!.querySelector('.session-day')?.textContent).toBe('Mi')

    // Di must now show as a rest day — the session moved away from it.
    const diRow = Array.from(container.querySelectorAll('.session-row')).find(
      row => row.querySelector('.session-day')?.textContent === 'Di'
    )
    expect(diRow?.className).toContain('rest-day')
  })

  it('Fall C: old sync.json without original_tag, no overrides at all → no marker, no reset button', async () => {
    const plan = buildPlan([
      { tag: 'Di', typ: 'Easy', km: 8, vorgabe: 'locker', struktur: '8km locker', dauer: '45 min', hinweis: 'ruhig starten' },
    ])
    ;(fetchSync as unknown as Mock).mockResolvedValue(syncResult(plan, undefined))

    await mount()

    const text = container.textContent ?? ''
    expect(text).not.toContain('↻ verschoben')
    expect(text).not.toContain('Zurücksetzen')
  })
})
