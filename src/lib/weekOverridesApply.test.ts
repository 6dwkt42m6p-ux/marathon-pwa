// P-11: Startup-Merge der Remote-weekOverrides darf an einer korrupten Woche nicht abbrechen.
import { describe, it, expect, beforeEach } from 'vitest'
import { applyRemoteWeekOverrides } from './storage'

describe('applyRemoteWeekOverrides (P-11)', () => {
  beforeEach(() => localStorage.clear())

  it('korruptes week_override_* blockiert andere Wochen nicht', () => {
    localStorage.setItem('week_override_2026-10-05', '{kaputt')
    expect(() => applyRemoteWeekOverrides({
      '2026-10-05': { Mo: 'Di' },
      '2026-10-12': { Mi: 'Do' },
    })).not.toThrow()
    const ok = JSON.parse(localStorage.getItem('week_override_2026-10-12')!)
    expect(ok.find((x: { originalDay: string }) => x.originalDay === 'Mi').currentDay).toBe('Do')
    // korrupte Woche wird aus Remote neu aufgebaut
    const bad = JSON.parse(localStorage.getItem('week_override_2026-10-05')!)
    expect(bad.find((x: { originalDay: string }) => x.originalDay === 'Mo').currentDay).toBe('Di')
  })

  it('Quota-Fehler beim Schreiben wirft nicht', () => {
    const orig = Storage.prototype.setItem
    Storage.prototype.setItem = () => { throw new DOMException('quota', 'QuotaExceededError') }
    try {
      expect(() => applyRemoteWeekOverrides({ '2026-10-05': { Mo: 'Di' } })).not.toThrow()
    } finally { Storage.prototype.setItem = orig }
  })
})
