// T-292: pyRound muss Pythons round(x, n) bit-gleich treffen (Erwartungswerte aus CPython erzeugt).
import { describe, it, expect } from 'vitest'
import { pyRound } from './pyRound'

const CASES: [number, number, number][] = [[0.03125, 4, 0.0312], [0.01875, 4, 0.0187], [2.675, 2, 2.67], [0.5, 0, 0.0], [1.5, 0, 2.0], [2.5, 0, 2.0], [-2.5, 0, -2.0], [0.0313, 4, 0.0313], [1.05, 1, 1.1], [1.15, 1, 1.1], [1.25, 1, 1.2], [-1.25, 1, -1.2], [399.5, 0, 400.0], [123.45, 1, 123.5], [0.123456789, 4, 0.1235], [9.995, 2, 9.99], [5e-05, 4, 0.0001], [270.04999999, 1, 270.0]]

describe('T-292 pyRound == Python round()', () => {
  for (const [x, n, exp] of CASES) it(`round(${x}, ${n}) = ${exp}`, () => expect(pyRound(x, n)).toBe(exp))
})
