// T-260 P-06: Remote-weekOverrides sind SSoT für alle Wochen, die lokal NICHT pending sind.
// Desktop "Tausche zurücksetzen" poppt die Woche, Einzel-Undo poppt den Tag — vorher blieb der
// lokale Tausch in der PWA dauerhaft als Overlay stehen (rein additiver Merge).
import { describe, it, expect, beforeEach } from 'vitest'
import {
  applyRemoteWeekOverrides,
  markWeekOverridePending,
  clearWeekOverridePending,
  isWeekOverridePending,
  pendingWeekOverrideMaps,
} from './storage'

const W1 = '2026-10-05'
const W2 = '2026-10-12'
const setLocal = (w: string, arr: Array<{ originalDay: string; currentDay: string }>) =>
  localStorage.setItem(`week_override_${w}`, JSON.stringify(arr))
const getLocal = (w: string) => {
  const raw = localStorage.getItem(`week_override_${w}`)
  return raw ? JSON.parse(raw) as Array<{ originalDay: string; currentDay: string }> : null
}

describe('applyRemoteWeekOverrides (T-260 P-06)', () => {
  beforeEach(() => localStorage.clear())

  it('Desktop-Reset (Woche fehlt remote) verwirft nicht-pendingen lokalen Tausch', () => {
    setLocal(W1, [{ originalDay: 'Di', currentDay: 'Mi' }, { originalDay: 'Do', currentDay: 'Do' }])
    applyRemoteWeekOverrides({})
    const local = getLocal(W1)
    expect(local === null || local.every(a => a.originalDay === a.currentDay)).toBe(true)
  })

  it('Einzel-Undo (Tag fehlt remote) setzt nur diesen Tag zurück', () => {
    setLocal(W1, [{ originalDay: 'Di', currentDay: 'Mi' }, { originalDay: 'Do', currentDay: 'So' }])
    applyRemoteWeekOverrides({ [W1]: { Do: 'So' } })
    const local = getLocal(W1)!
    expect(local.find(a => a.originalDay === 'Di')!.currentDay).toBe('Di')
    expect(local.find(a => a.originalDay === 'Do')!.currentDay).toBe('So')
  })

  it('lokal pending (noch nicht gesynct) bleibt trotz fehlender Remote-Woche stehen', () => {
    setLocal(W1, [{ originalDay: 'Di', currentDay: 'Mi' }])
    markWeekOverridePending(W1)
    applyRemoteWeekOverrides({})
    expect(getLocal(W1)![0].currentDay).toBe('Mi')
    expect(isWeekOverridePending(W1)).toBe(true)
  })

  it('pending-Marker wird gelöscht, sobald Remote genau den lokalen Stand trägt', () => {
    setLocal(W1, [{ originalDay: 'Di', currentDay: 'Mi' }, { originalDay: 'Do', currentDay: 'Do' }])
    markWeekOverridePending(W1)
    applyRemoteWeekOverrides({ [W1]: { Di: 'Mi' } })
    expect(isWeekOverridePending(W1)).toBe(false)
  })

  it('andere Wochen bleiben unberührt bzw. werden aus Remote übernommen', () => {
    setLocal(W1, [{ originalDay: 'Di', currentDay: 'Mi' }])
    markWeekOverridePending(W1)
    applyRemoteWeekOverrides({ [W2]: { Mo: 'Di' } })
    expect(getLocal(W1)![0].currentDay).toBe('Mi')
    expect(getLocal(W2)!.find(a => a.originalDay === 'Mo')!.currentDay).toBe('Di')
  })

  it('clearWeekOverridePending mit veraltetem Stempel lässt neueren Marker stehen', () => {
    const s1 = markWeekOverridePending(W1)
    // neuer Tausch während der erste Push noch läuft
    const s2 = markWeekOverridePending(W1, '2099-01-01T00:00:00.000Z')
    expect(s2).not.toBe(s1)
    clearWeekOverridePending(W1, s1)
    expect(isWeekOverridePending(W1)).toBe(true)
    clearWeekOverridePending(W1, s2)
    expect(isWeekOverridePending(W1)).toBe(false)
  })

  it('pendingWeekOverrideMaps liefert nur pending Wochen als Remote-Map (Swaps only)', () => {
    setLocal(W1, [{ originalDay: 'Di', currentDay: 'Mi' }, { originalDay: 'Do', currentDay: 'Do' }])
    setLocal(W2, [{ originalDay: 'Mo', currentDay: 'Di' }])
    markWeekOverridePending(W1)
    expect(pendingWeekOverrideMaps()).toEqual({ [W1]: { stamp: expect.any(String), map: { Di: 'Mi' } } })
  })
})
