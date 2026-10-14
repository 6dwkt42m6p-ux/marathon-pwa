// Inhalt: Python-kompatibles round() fuer Paritaet mit der Desktop-Referenz.
// Zweck: Python rundet half-to-even auf dem EXAKTEN Double-Wert (round(0.03125, 4) = 0.0312),
//   JS Math.round(x*1e4)/1e4 rundet half-up auf einem bereits verfaelschten Produkt.
// Einstieg: pyRound, pyRoundHalfEven, npRound (pandas/numpy-Series-Rundung).
// Regeln: Leaf-Modul ohne Importe (importGraph-Gate, T-287).

/** Python `round(x)` (ndigits=0): half-to-even auf Ganzzahl. Hintergrund: T-247 / T-292 */
export function pyRoundHalfEven(x: number): number {
  const floor = Math.floor(x)
  const diff = x - floor
  if (diff < 0.5) return floor
  if (diff > 0.5) return floor + 1
  return floor % 2 === 0 ? floor : floor + 1
}

/** Python `round(x, ndigits)`: korrekt gerundet auf dem exakten Dezimalwert des Doubles,
 * Gleichstand (nur bei exakt darstellbarem ...5) half-to-even. toFixed(100) liefert die
 * exakte Dezimalentwicklung fuer alle praxisrelevanten Betraege (|x| >= ~1e-48).
 * Hintergrund: T-292 */
export function pyRound(x: number, ndigits = 0): number {
  if (!Number.isFinite(x)) return x
  if (ndigits <= 0) return pyRoundHalfEven(x)
  const s = Math.abs(x).toFixed(100)
  const cut = s.indexOf('.') + 1 + ndigits
  const kept = s.slice(0, cut).replace('.', '')
  const rest = s.slice(cut)
  let up: boolean
  if (rest[0] > '5') up = true
  else if (rest[0] < '5') up = false
  else if (/[1-9]/.test(rest.slice(1))) up = true
  else up = Number(kept[kept.length - 1]) % 2 === 1
  const digits = (BigInt(kept) + (up ? 1n : 0n)).toString().padStart(ndigits + 1, '0')
  const v = Number(`${digits.slice(0, -ndigits)}.${digits.slice(-ndigits)}`)
  return x < 0 ? -v : v
}

/** pandas/numpy `.round(n)`: rint(x * 10**n) / 10**n (half-to-even auf dem SKALIERTEN Produkt,
 * anders als Python-round auf Skalaren). Fuer Series-Rundungen der Referenz. Hintergrund: T-292 */
export function npRound(x: number, ndigits = 0): number {
  if (!Number.isFinite(x)) return x
  const f = 10 ** ndigits
  return pyRoundHalfEven(x * f) / f
}
