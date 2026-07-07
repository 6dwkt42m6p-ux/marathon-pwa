// T-158(b): isUsingDefaultSettings — Erststart-Erkennung (pure localStorage check)
// Test-first: rot zuerst, grün nach Impl.

import { describe, it, expect, beforeEach } from 'vitest'
import { isUsingDefaultSettings, saveSettings, loadSettings } from './storage'

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
