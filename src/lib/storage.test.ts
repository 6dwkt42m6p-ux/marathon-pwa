// T-158(b): isUsingDefaultSettings — Erststart-Erkennung (pure localStorage check)
// Test-first: rot zuerst, grün nach Impl.
// T-170: safeSetItem + Rückgabewert-Härtung ungeschützter setItem-Aufrufe (Folgebefund zu T-163).

import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  isUsingDefaultSettings, saveSettings, loadSettings,
  safeSetItem, saveNote, loadNote, registerEvictCallback, STORAGE_WARNING_KEY,
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
