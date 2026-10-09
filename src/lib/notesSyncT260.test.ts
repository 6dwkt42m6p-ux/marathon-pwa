// T-260 P-04: Notiz-Mutationen dürfen nicht ewig hängen und keine neueren Stände überschreiben.
// Szenarien: (a) Notiz ohne Sterne (Desktop klemmt rating auf [1,5]), (b) A→B vor Desktop-Lauf,
// (c) Offline-Reihenfolge, (d) Desktop-Edit nach angewandter PWA-Mutation.
// Der Desktop wird hier als Simulator von notes.apply_pending_note_mutations nachgebaut
// (Queue-Reihenfolge, Overwrite, rating-Clamp, text.strip, saved_at = Anwendezeitpunkt).

import { describe, it, expect, beforeEach } from 'vitest'
import {
  appendPendingNoteMutation,
  loadPendingNoteMutations,
  compactNoteMutations,
  mergeNoteMutationQueue,
  markNoteMutationsPushed,
  reconcilePendingNoteMutations,
  resolvePendingNoteMutation,
  type NoteMutation,
  type SyncedNote,
} from './notesSync'

const save = (id: number, text: string, rating: number, ts: string): NoteMutation =>
  ({ type: 'save', activity_id: id, text, rating, ts })

// Desktop-Simulator: wendet die Remote-Queue in Listenreihenfolge an und leert sie.
function desktopApply(queue: NoteMutation[], notes: Record<string, SyncedNote>, now: string) {
  const out = { ...notes }
  for (const m of queue) {
    const k = String(m.activity_id)
    if (m.type === 'save') {
      out[k] = { text: (m.text ?? '').trim(), rating: Math.max(1, Math.min(5, m.rating ?? 0)), saved_at: now }
    } else delete out[k]
  }
  return { noteMutations: [] as NoteMutation[], notes: out }
}

describe('T-260 P-04 (a) Notiz ohne Sterne', () => {
  beforeEach(() => localStorage.clear())

  it('rating 0 gilt nach Desktop-Clamp auf 1 als applied (kein Dauer-Pending)', () => {
    const m = save(42, 'Lockerer Lauf', 0, '2026-10-08T10:00:00.000Z')
    const sync = desktopApply([m], {}, '2026-10-08T11:00:00.000Z')
    expect(sync.notes['42'].rating).toBe(1)
    expect(resolvePendingNoteMutation(m, sync)).toBe('applied')
  })

  it('reconcile entfernt die rating-0-Mutation aus der lokalen Queue', () => {
    const m = save(42, 'Lockerer Lauf', 0, '2026-10-08T10:00:00.000Z')
    appendPendingNoteMutation(m)
    const sync = desktopApply([m], {}, '2026-10-08T11:00:00.000Z')
    expect(reconcilePendingNoteMutations(sync)).toEqual([])
    expect(loadPendingNoteMutations()).toEqual([])
  })

  it('Text über 500 Zeichen (Desktop-Export kürzt) gilt ebenfalls als applied', () => {
    const long = 'x'.repeat(600)
    const m = save(9, long, 3, '2026-10-08T10:00:00.000Z')
    const sync = { noteMutations: [], notes: { '9': { text: long.slice(0, 500), rating: 3, saved_at: '2026-10-08T11:00:00.000Z' } } }
    expect(resolvePendingNoteMutation(m, sync)).toBe('applied')
  })
})

describe('T-260 P-04 (b) A→B vor Desktop-Lauf', () => {
  beforeEach(() => localStorage.clear())

  it('lokale Queue hält pro activity_id nur die jüngste Mutation', () => {
    appendPendingNoteMutation(save(1, 'A', 3, '2026-10-08T10:00:00.000Z'))
    appendPendingNoteMutation(save(2, 'X', 2, '2026-10-08T10:00:30.000Z'))
    appendPendingNoteMutation(save(1, 'B', 4, '2026-10-08T10:01:00.000Z'))
    const q = loadPendingNoteMutations()
    expect(q.map(m => m.text)).toEqual(['X', 'B'])
  })

  it('compactNoteMutations behält je id die jüngste ts, unabhängig von der Listenreihenfolge', () => {
    const out = compactNoteMutations([
      save(1, 'B', 4, '2026-10-08T10:01:00.000Z'),
      save(1, 'A', 3, '2026-10-08T10:00:00.000Z'),
    ])
    expect(out.map(m => m.text)).toEqual(['B'])
  })

  it('Remote-Queue [A] + lokal B → Payload enthält nur B; Desktop endet bei B, nie bei A', () => {
    const A = save(1, 'A', 3, '2026-10-08T10:00:00.000Z')
    const B = save(1, 'B', 4, '2026-10-08T10:01:00.000Z')
    appendPendingNoteMutation(A)
    appendPendingNoteMutation(B)
    const queue = mergeNoteMutationQueue([A], loadPendingNoteMutations())
    expect(queue.map(m => m.text)).toEqual(['B'])

    let sync = desktopApply(queue, {}, '2026-10-08T12:00:00.000Z')
    expect(sync.notes['1'].text).toBe('B')
    // App-Start: Reconcile + Re-Push der Reste — darf A nicht wieder einspielen
    const remaining = reconcilePendingNoteMutations(sync)
    expect(remaining).toEqual([])
    sync = desktopApply(mergeNoteMutationQueue(sync.noteMutations, remaining), sync.notes, '2026-10-08T13:00:00.000Z')
    expect(sync.notes['1'].text).toBe('B')
  })

  it('Altbestand: lokale Queue [A,B] von vor T-260 → Reconcile kompaktiert, A wird nie re-pusht', () => {
    const A = save(1, 'A', 3, '2026-10-08T10:00:00.000Z')
    const B = save(1, 'B', 4, '2026-10-08T10:01:00.000Z')
    localStorage.setItem('pending_note_mutations', JSON.stringify([A, B]))
    // Desktop hatte beide in Reihenfolge angewandt → B
    const sync = desktopApply([A, B], {}, '2026-10-08T12:00:00.000Z')
    expect(reconcilePendingNoteMutations(sync)).toEqual([])
    expect(loadPendingNoteMutations()).toEqual([])
  })

  it('mergeNoteMutationQueue entfernt das lokal-only Feld pushed aus dem Payload', () => {
    const B = { ...save(1, 'B', 4, '2026-10-08T10:01:00.000Z'), pushed: true }
    const q = mergeNoteMutationQueue([], [B])
    expect('pushed' in q[0]).toBe(false)
  })
})

describe('T-260 P-04 (c) Offline-Reihenfolge', () => {
  beforeEach(() => localStorage.clear())

  it('A gepusht, B offline gespeichert, Desktop wendet A NACH B.ts an → B bleibt pending und gewinnt', () => {
    const A = save(1, 'A', 3, '2026-10-08T10:00:00.000Z')
    appendPendingNoteMutation(A)
    // A ist in der Remote-Queue gesehen worden → als gepusht markiert
    reconcilePendingNoteMutations({ noteMutations: [A], notes: {} })
    expect(loadPendingNoteMutations()[0].pushed).toBe(true)

    // offline: B gespeichert, Push schlägt fehl
    const B = save(1, 'B', 4, '2026-10-08T10:05:00.000Z')
    appendPendingNoteMutation(B)

    // Desktop läuft später (saved_at > B.ts) und wendet die Remote-Queue [A] an
    let sync = desktopApply([A], {}, '2026-10-08T12:00:00.000Z')
    expect(sync.notes['1'].text).toBe('A')

    // App-Start: B wurde nie gepusht → pending, nicht als applied verworfen
    const remaining = reconcilePendingNoteMutations(sync)
    expect(remaining.map(m => m.text)).toEqual(['B'])

    sync = desktopApply(mergeNoteMutationQueue(sync.noteMutations, remaining), sync.notes, '2026-10-08T13:00:00.000Z')
    expect(sync.notes['1'].text).toBe('B')
    expect(reconcilePendingNoteMutations(sync)).toEqual([])
  })
})

describe('T-260 P-04 (d) Desktop-Edit nach angewandter PWA-Mutation', () => {
  beforeEach(() => localStorage.clear())

  it('gepushte, vom Desktop konsumierte Mutation überschreibt einen späteren Desktop-Edit nicht', () => {
    const B = save(1, 'B', 4, '2026-10-08T10:00:00.000Z')
    appendPendingNoteMutation(B)
    expect(markNoteMutationsPushed([B.ts])).toBe(true)
    // Desktop wendet B an, User editiert danach am Desktop zu C
    const sync = {
      noteMutations: [],
      notes: { '1': { text: 'C', rating: 5, saved_at: '2026-10-08T12:30:00.000Z' } },
    }
    expect(reconcilePendingNoteMutations(sync)).toEqual([])
  })

  it('gepushte Mutation, aber Remote-Note älter als ts (Queue verloren) → pending (Re-Push)', () => {
    const B = save(1, 'B', 4, '2026-10-08T10:00:00.000Z')
    appendPendingNoteMutation(B)
    markNoteMutationsPushed([B.ts])
    const sync = {
      noteMutations: [],
      notes: { '1': { text: 'alt', rating: 2, saved_at: '2026-10-07T09:00:00.000Z' } },
    }
    expect(reconcilePendingNoteMutations(sync).map(m => m.ts)).toEqual([B.ts])
  })
})

// ── T-260 Fix-Loop 1 (Review-Proben S1/S2/S3) ────────────────────────────────

describe('T-260 Fix-Loop 1 — Delete-Reihenfolgen + Textnormalisierung', () => {
  beforeEach(() => localStorage.clear())

  it('Bug 1: Save A gepusht (noch in Remote-Queue) + Delete offline → Delete bleibt pending, Payload = [D], Notiz bleibt gelöscht', () => {
    const A = save(1, 'A', 3, '2026-10-08T10:00:00.000Z')
    appendPendingNoteMutation(A)
    markNoteMutationsPushed([A.ts])
    const D: NoteMutation = { type: 'delete', activity_id: 1, ts: '2026-10-08T10:05:00.000Z' }
    appendPendingNoteMutation(D)

    const sync0 = { noteMutations: [A], notes: {} as Record<string, SyncedNote> }
    const remaining = reconcilePendingNoteMutations(sync0)
    expect(remaining.map(m => m.ts)).toEqual([D.ts])
    const payload = mergeNoteMutationQueue(sync0.noteMutations, remaining)
    expect(payload.map(m => m.type)).toEqual(['delete'])

    const sync1 = desktopApply(payload, sync0.notes, '2026-10-08T12:00:00.000Z')
    expect('1' in sync1.notes).toBe(false)
    expect(reconcilePendingNoteMutations(sync1)).toEqual([])
  })

  it('Bug 2: gepushte Save-Mutation konsumiert, danach am Desktop gelöscht → applied, kein Re-Push', () => {
    const B = save(1, 'B', 4, '2026-10-08T10:00:00.000Z')
    appendPendingNoteMutation(B)
    markNoteMutationsPushed([B.ts])
    expect(reconcilePendingNoteMutations({ noteMutations: [], notes: {} })).toEqual([])
  })

  it('Bug 2 Gegenprobe: NIE gepushte Save-Mutation und Key fehlt → pending (Offline-Neuanlage)', () => {
    const B = save(1, 'B', 4, '2026-10-08T10:00:00.000Z')
    appendPendingNoteMutation(B)
    expect(reconcilePendingNoteMutations({ noteMutations: [], notes: {} }).map(m => m.ts)).toEqual([B.ts])
  })

  it('Zwei Geräte: neuere Mutation derselben Aktivität in der Remote-Queue verdrängt die eigene (kein Re-Push von A über B)', () => {
    const A = save(1, 'A', 3, '2026-10-08T10:00:00.000Z')   // Gerät 1, nie gepusht
    appendPendingNoteMutation(A)
    const B = save(1, 'B', 4, '2026-10-08T10:05:00.000Z')   // Gerät 2, bereits in Remote-Queue
    expect(reconcilePendingNoteMutations({ noteMutations: [B], notes: {} })).toEqual([])
  })

  it('S3: Leerzeichen genau an Position 500 — Inhalt matcht wie Desktop (strip → [:500])', () => {
    const text = 'a'.repeat(499) + ' ' + 'b'.repeat(10)
    const m = save(9, text, 3, '2026-10-08T10:00:00.000Z')
    const exported = text.trim().slice(0, 500)  // Python: text.strip()[:500] — endet auf ' '
    expect(exported.endsWith(' ')).toBe(true)
    const sync = { noteMutations: [], notes: { '9': { text: exported, rating: 3, saved_at: '2026-10-08T11:00:00.000Z' } } }
    expect(resolvePendingNoteMutation(m, sync)).toBe('applied')
  })

  it('Python-[:500] zählt Codepoints, nicht UTF-16-Einheiten (Emoji)', () => {
    const text = '😀'.repeat(600)
    const m = save(9, text, 3, '2026-10-08T10:00:00.000Z')
    const exported = Array.from(text).slice(0, 500).join('')
    const sync = { noteMutations: [], notes: { '9': { text: exported, rating: 3, saved_at: '2026-10-08T11:00:00.000Z' } } }
    expect(resolvePendingNoteMutation(m, sync)).toBe('applied')
  })
})
