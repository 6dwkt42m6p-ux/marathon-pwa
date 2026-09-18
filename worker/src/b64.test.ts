import { describe, it, expect } from 'vitest'
import { b64ToUtf8 } from './b64'

// T-209: Roundtrip-Beleg für readMutationsFile — schreibt (btoa(unescape(encodeURIComponent(...))),
// identisch zu writeMutationsFile in index.ts) und liest mit b64ToUtf8 zurück. Muss byte-identisch
// sein, sonst wiederholt sich T-208 (Mojibake bei deutschem Freitext) im Worker.
describe('b64ToUtf8', () => {
  it('roundtrip mit Umlaut-Nutzlast bleibt byte-identisch', () => {
    const original = 'Qualität ⭐ – Läufe'
    const encoded = btoa(unescape(encodeURIComponent(original)))
    const decoded = b64ToUtf8(encoded)
    expect(decoded).toBe(original)
  })
})
