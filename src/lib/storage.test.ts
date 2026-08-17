// T-158(b): isUsingDefaultSettings — Erststart-Erkennung (pure localStorage check)
// Test-first: rot zuerst, grün nach Impl.
// T-170: safeSetItem + Rückgabewert-Härtung ungeschützter setItem-Aufrufe (Folgebefund zu T-163).

import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  isUsingDefaultSettings, saveSettings, loadSettings,
  safeSetItem, saveNote, loadNote, registerEvictCallback, STORAGE_WARNING_KEY,
  resolvePreRaceEnabled, mergeSettingsForPush, mergeRemoteSettings,
} from './storage'

// jsdom environment provides localStorage

describe('isUsingDefaultSettings — T-158(b)', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('returns true when coach_settings is absent (fresh install)', () => {
    // localStorage is cleared in beforeEach → no key present
    expect(isUsingDefaultSettings()).toBe(true)
  })

  it('returns false after settings are saved (user has configured the app)', () => {
    const s = loadSettings()
    saveSettings(s)  // persists coach_settings
    expect(isUsingDefaultSettings()).toBe(false)
  })

  it('returns false even if saved vdot matches the default value (key presence counts)', () => {
    // DEFAULTS.vdot=47.9 — if user explicitly saves that value, it's still "configured"
    const s = { ...loadSettings(), vdot: 47.9 }
    saveSettings(s)
    expect(isUsingDefaultSettings()).toBe(false)
  })
})

// ── T-170: safeSetItem + hardened call sites ────────────────────────────────
// Gotcha (T-163): jsdom Storage.prototype.setItem-Spy ist zuverlässiger als das
// localStorage.setItem-Mock direkt — hier konsequent genutzt.

describe('safeSetItem — T-170', () => {
  beforeEach(() => { localStorage.clear(); registerEvictCallback(() => {}) })

  it('successful write → true, no warning flag', () => {
    const ok = safeSetItem('some_key', 'value')
    expect(ok).toBe(true)
    expect(localStorage.getItem('some_key')).toBe('value')
    expect(localStorage.getItem(STORAGE_WARNING_KEY)).toBeNull()
  })

  it('quota error, evict callback frees space → retry succeeds, true', () => {
    let attempt = 0
    let evictCalled = false
    const origSetItem = Storage.prototype.setItem.bind(localStorage)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === 'some_key') {
        attempt++
        if (attempt === 1) throw new DOMException('QuotaExceededError', 'QuotaExceededError')
      }
      origSetItem(key, value)
    })
    registerEvictCallback(() => { evictCalled = true })

    const ok = safeSetItem('some_key', 'value')
    vi.restoreAllMocks()

    expect(ok).toBe(true)
    expect(evictCalled).toBe(true)
    expect(localStorage.getItem('some_key')).toBe('value')
  })

  it('quota error persists after evict+retry → false, STORAGE_WARNING_KEY set, never throws', () => {
    const origSetItem = Storage.prototype.setItem.bind(localStorage)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === 'some_key') throw new DOMException('QuotaExceededError', 'QuotaExceededError')
      origSetItem(key, value)
    })
    registerEvictCallback(() => { /* nothing to evict, still full */ })

    let threw = false
    let ok = true
    try { ok = safeSetItem('some_key', 'value') } catch { threw = true }
    vi.restoreAllMocks()

    expect(threw).toBe(false)
    expect(ok).toBe(false)
    expect(localStorage.getItem(STORAGE_WARNING_KEY)).not.toBeNull()
  })
})

// T-170: echter Datenverlust-Pfad — Notiz speichern bei voller Quota, Aufrufer erfährt davon
// (Kern des Tickets: Rückgabewert auswerten statt Erfolg vortäuschen).
describe('saveNote — T-170 quota hardening', () => {
  beforeEach(() => { localStorage.clear(); registerEvictCallback(() => {}) })

  it('successful save → true, note persisted', () => {
    const ok = saveNote(42, 'Guter Lauf', 4)
    expect(ok).toBe(true)
    expect(loadNote(42)?.text).toBe('Guter Lauf')
  })

  it('quota exhausted (unhealable) → returns false, note NOT silently lost-looking — caller can detect failure', () => {
    const origSetItem = Storage.prototype.setItem.bind(localStorage)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === 'note_42') throw new DOMException('QuotaExceededError', 'QuotaExceededError')
      origSetItem(key, value)
    })
    registerEvictCallback(() => { /* nothing helps — storage genuinely full */ })

    let threw = false
    let ok = true
    try { ok = saveNote(42, 'Verlorene Notiz', 5) } catch { threw = true }
    vi.restoreAllMocks()

    expect(threw).toBe(false)
    expect(ok).toBe(false)
    // The note was NOT persisted — a caller that ignores the return value would show
    // a false "gespeichert" confirmation while the data never made it to storage.
    expect(loadNote(42)).toBeNull()
    expect(localStorage.getItem(STORAGE_WARNING_KEY)).not.toBeNull()
  })
})

// ── resolvePreRaceEnabled — T-182 Phase B ────────────────────────────────────
// preRaceEnabled used to be an orphaned toggle (saved + shown, never evaluated — B4 in T-182).
// It is now desktop-controlled via the sync `settings` block written by Streamlit (T-182 Phase
// A). These tests pin the resolution order: sync wins when present + boolean, local value is
// the fallback for older sync.json (no block yet) — must never regress.
describe('resolvePreRaceEnabled — T-182 Phase B', () => {
  it('no sync settings block (null) → local value applies', () => {
    expect(resolvePreRaceEnabled(true, null)).toBe(true)
    expect(resolvePreRaceEnabled(false, null)).toBe(false)
  })

  it('sync settings block present but preRaceEnabled key absent → local value applies', () => {
    expect(resolvePreRaceEnabled(true, {})).toBe(true)
    expect(resolvePreRaceEnabled(false, { raceDate1: '2026-10-11' })).toBe(false)
  })

  it('sync settings has preRaceEnabled=true → overrides local false', () => {
    expect(resolvePreRaceEnabled(false, { preRaceEnabled: true })).toBe(true)
  })

  it('sync settings has preRaceEnabled=false → overrides local true', () => {
    expect(resolvePreRaceEnabled(true, { preRaceEnabled: false })).toBe(false)
  })

  it('sync preRaceEnabled with wrong type (non-boolean) → ignored, local value applies', () => {
    // Defensive: sync.json is untyped JSON on the wire, a malformed value must not crash
    // or be silently coerced (e.g. a stringly-typed "false" is truthy in JS).
    expect(resolvePreRaceEnabled(true, { preRaceEnabled: 'false' as unknown })).toBe(true)
    expect(resolvePreRaceEnabled(false, { preRaceEnabled: null })).toBe(false)
  })
})

// ── mergeSettingsForPush — T-182 Phase B review fix (Bug 1) ─────────────────
// Settings.tsx: handleSave() used to push the entire local `s` state as a full replacement
// for the sync `settings` block. A stale local preRaceEnabled could silently overwrite a
// fresh Desktop `false` — violating the "PWA checkbox is read-only, Desktop is SSoT" design
// decision (User-Entscheidung #2). preRaceEnabled must always resolve from base.settings when
// present; every other key (e.g. raceDate1/raceDate2 — still user-editable date pickers in the
// PWA, NOT desktop-authoritative) must come from the local edit.
describe('mergeSettingsForPush — T-182 Phase B review fix (Bug 1)', () => {
  it('stale local preRaceEnabled=true does not overwrite fresh Desktop preRaceEnabled=false', () => {
    const local = { ...loadSettings(), preRaceEnabled: true }
    const base = { preRaceEnabled: false, raceDate1: null, raceDate2: '2027-04-25' }
    const merged = mergeSettingsForPush(local, base)
    expect(merged.preRaceEnabled).toBe(false)
  })

  it('stale local preRaceEnabled=false does not suppress a fresh Desktop preRaceEnabled=true', () => {
    const local = { ...loadSettings(), preRaceEnabled: false }
    const base = { preRaceEnabled: true }
    const merged = mergeSettingsForPush(local, base)
    expect(merged.preRaceEnabled).toBe(true)
  })

  it('no base.settings (older sync.json, no Phase A push yet) → local preRaceEnabled applies', () => {
    const local = { ...loadSettings(), preRaceEnabled: false }
    const merged = mergeSettingsForPush(local, null)
    expect(merged.preRaceEnabled).toBe(false)
  })

  it('other locally edited fields (raceDate1/raceDate2/vdot) come from the local edit, not base', () => {
    // raceDate1/raceDate2 remain PWA-user-editable date pickers (Settings.tsx renders them
    // enabled, unlike the disabled preRaceEnabled checkbox) — only preRaceEnabled is
    // desktop-authoritative per User-Entscheidung #2.
    const local = { ...loadSettings(), raceDate1: '2026-11-01', vdot: 50 }
    const base = { raceDate1: '2026-10-11', vdot: 47.9, preRaceEnabled: true }
    const merged = mergeSettingsForPush(local, base)
    expect(merged.raceDate1).toBe('2026-11-01')
    expect(merged.vdot).toBe(50)
  })
})

// ── mergeRemoteSettings — T-182 Phase B review fix (Bug 2) ──────────────────
// App.tsx startup merge used to blindly spread `data.settings` over local AppSettings and cast
// the result. `raceDate1: null` (Event 1 disabled on the Desktop, T-182 Phase A) landed
// unchanged in the non-nullable AppSettings.raceDate1 and got persisted — VdotPaces.tsx then
// computed `new Date(null)` = epoch, silently showing "0 Wochen bis Rennen".
describe('mergeRemoteSettings — T-182 Phase B review fix (Bug 2)', () => {
  it('remote raceDate1: null does not overwrite the local (non-nullable) raceDate1', () => {
    const local = { ...loadSettings(), raceDate1: '2026-10-11' }
    const merged = mergeRemoteSettings(local, { raceDate1: null, preRaceEnabled: false })
    expect(merged.raceDate1).toBe('2026-10-11')
  })

  it('raceDate1: null does not corrupt hmWeeks into an epoch-derived 0 (T-182 review repro)', () => {
    const local = { ...loadSettings(), raceDate1: '2026-10-11' }
    const merged = mergeRemoteSettings(local, { raceDate1: null })
    const weeksUntil = Math.floor((new Date(merged.raceDate1).getTime() - Date.now()) / (7 * 24 * 3600 * 1000))
    expect(weeksUntil).toBeGreaterThan(0)
  })

  it('remote non-null raceDate1 overrides the local value (normal Desktop-wins case)', () => {
    const local = { ...loadSettings(), raceDate1: '2026-10-11' }
    const merged = mergeRemoteSettings(local, { raceDate1: '2026-11-01' })
    expect(merged.raceDate1).toBe('2026-11-01')
  })

  it('remote preRaceEnabled: false (a real, non-null boolean) is applied, not stripped', () => {
    const local = { ...loadSettings(), preRaceEnabled: true }
    const merged = mergeRemoteSettings(local, { preRaceEnabled: false })
    expect(merged.preRaceEnabled).toBe(false)
  })

  it('no remote settings (null/undefined) → local settings unchanged', () => {
    const local = { ...loadSettings(), raceDate1: '2026-10-11' }
    expect(mergeRemoteSettings(local, null)).toEqual(local)
    expect(mergeRemoteSettings(local, undefined)).toEqual(local)
  })
})

describe('saveSettings — T-170 quota hardening', () => {
  beforeEach(() => { localStorage.clear(); registerEvictCallback(() => {}) })

  it('successful save → true', () => {
    expect(saveSettings(loadSettings())).toBe(true)
  })

  it('quota exhausted → false, settings not overwritten, no throw', () => {
    const origSetItem = Storage.prototype.setItem.bind(localStorage)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === 'coach_settings') throw new DOMException('QuotaExceededError', 'QuotaExceededError')
      origSetItem(key, value)
    })
    registerEvictCallback(() => {})

    let threw = false
    let ok = true
    try { ok = saveSettings({ ...loadSettings(), vdot: 60 }) } catch { threw = true }
    vi.restoreAllMocks()

    expect(threw).toBe(false)
    expect(ok).toBe(false)
  })
})
