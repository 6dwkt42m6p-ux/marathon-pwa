// T-297 Fix-Loop 1 Punkt 4: Verletzungspause, die nicht gesendet wurde (kein Token / Token während des
// Fetch entfernt → pushInjuryMutation liefert false) → sichtbare Meldung, KEIN „Wartet auf Desktop“-Overlay.
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import Settings from './Settings'
import type { AppSettings } from '../lib/storage'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true

vi.mock('../lib/githubSync', async () => {
  const actual = await vi.importActual<typeof import('../lib/githubSync')>('../lib/githubSync')
  return { ...actual, hasToken: vi.fn(() => true), fetchSync: vi.fn(async () => null) }
})
vi.mock('../lib/syncActions', () => ({
  pushInjuryMutation: vi.fn(), pushSettings: vi.fn(), flushPendingSync: vi.fn(),
}))

import { pushInjuryMutation } from '../lib/syncActions'

const SETTINGS: AppSettings = {
  vdot: 50, maxHr: 190, restHr: 45, currentWeeklyKm: 60, runsPerWeek: 5,
  raceType1: 'marathon', raceDate1: '2027-04-18', raceType2: 'hm', raceDate2: '2026-11-01',
  preRaceEnabled: true, experience: 'fortgeschritten', name: 'P',
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
  vi.clearAllMocks()
})

async function clickStartBreak() {
  await act(async () => { root.render(<Settings settings={SETTINGS} onUpdate={() => {}} />) })
  const btn = Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes('Pause eintragen'))!
  expect(btn.disabled).toBe(false)
  await act(async () => { btn.click(); await Promise.resolve() })
}

describe('Settings Verletzungspause — Token-Policy (T-297 FL1)', () => {
  it('nicht gesendet (false) → Fehlermeldung, kein Overlay', async () => {
    ;(pushInjuryMutation as unknown as Mock).mockResolvedValue(false)
    await clickStartBreak()
    expect(container.textContent).toContain('Kein GitHub-Token — Eingabe nicht gesendet')
    expect(container.textContent).not.toContain('Wartet auf Desktop-Sync')
  })

  it('gesendet (true) → Overlay, keine Fehlermeldung', async () => {
    ;(pushInjuryMutation as unknown as Mock).mockResolvedValue(true)
    await clickStartBreak()
    expect(container.textContent).toContain('Wartet auf Desktop-Sync')
    expect(container.textContent).not.toContain('Kein GitHub-Token')
  })
})
