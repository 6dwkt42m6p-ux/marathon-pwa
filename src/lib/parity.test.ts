// T-171 — Parity-Gate, PWA-Seite.
//
// streams.py (Desktop) und die Ports hier sind handgepflegte Zwillinge derselben
// Algorithmen. Nichts erzwang bisher Gleichlauf, und sie sind nachweislich gedriftet:
// T-165 (MERGE_GAP_S), T-177 (rampStr formatierte 0 als "0.0"), T-186 (computeBestVdot
// rechnete unnormalisiert — 1,6 VDOT-Punkte Unterschied). JEDE dieser Divergenzen wurde
// von einem Menschen gefunden, keine von einem Test.
//
// Dieser Test liest DIESELBEN Golden-Fixtures wie tests/test_parity_fixtures.py auf der
// Desktop-Seite (Kopie in tests/fixtures/parity/, per sha256-MANIFEST gekoppelt) und
// vergleicht die Ausgabe der TS-Ports gegen die Referenzwerte aus Python.
//
// Fixtures gehören dem Desktop-Repo. Neu erzeugen NUR dort:
//   python3 tests/parity_generate.py && python3 tests/parity_sync.py
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

import { classifyWorkoutStructure, detectStrides, type ActivityStreams } from './strava'
import { sessionExecutionQuality, dataQualityScore } from './analytics'
import { durabilitySignals } from './durability'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE_DIR = resolve(HERE, '../../tests/fixtures/parity')

const FLOAT_TOL = 1e-6

// ---------------------------------------------------------------------------
// Bekannte, BEWUSST akzeptierte Divergenzen.
//
// Jeder Eintrag ist eine Schuld, kein Freibrief: Er dokumentiert, dass die beiden Ports
// an dieser Stelle NICHT gleich sind, samt Grund. Die Liste darf nur schrumpfen. Ein
// neuer Eintrag gehört in ein Ticket, nicht stillschweigend hierher.
// ---------------------------------------------------------------------------
// Alle Eintraege sind reine SCHEMA-Unterschiede: ein Zusatzfeld auf einer Seite, das die
// andere gar nicht kennt. Kein einziger davon ist ein WERT-Unterschied auf einem
// gemeinsamen Feld — solche wurden beim ersten Lauf dieses Gates gefunden und sofort
// behoben (pace_deviation-Rundung, 0-statt-null bei leeren Strides).
const KNOWN_DIVERGENCES: Record<string, string> = {
  'classify_workout_structure.tempo_blocks[].zone':
    'Nur Python: `zone` aus _pace_zone(). Die PWA zeigt die Zone am Tempoblock nicht an.',
  'classify_workout_structure.interval_blocks[].zone':
    'Nur Python: dito fuer Intervallbloecke.',
  'classify_workout_structure.strides[].avg_speed_ms':
    'Nur Python: Durchschnittsgeschwindigkeit je Stride. Die PWA fuehrt am ' +
    'Workout-Stride nur peak_speed_ms (im Ticket T-171 explizit als bekannte Divergenz ' +
    'benannt).',
  'detect_strides.strides[].n':
    'Nur Python: 1-basierter Laufindex. In TS ergibt er sich aus der Array-Position.',
  'detect_strides.strides[].end_sec':
    'Nur PWA: Endzeitpunkt. Python fuehrt start_sec + duration_sec, end_sec ist daraus ' +
    'ableitbar — kein Informationsunterschied.',
  'detect_strides.threshold_ms':
    'Nur PWA: die verwendete Erkennungsschwelle. Python gibt sie nicht heraus. ' +
    'Diagnosewert, fliesst in keine Kennzahl ein.',
}

function isKnown(path: string): boolean {
  const generic = path.replace(/\[\d+\]/g, '[]')
  return Object.prototype.hasOwnProperty.call(KNOWN_DIVERGENCES, generic)
}

/** camelCase -> snake_case, damit beide Seiten dieselben Schluessel vergleichen. */
function toSnake(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
}

function normalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalise)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue        // optionale TS-Felder != fehlende Python-Keys
      out[toSnake(k)] = normalise(v)
    }
    return out
  }
  return value
}

/** Strukturvergleich mit Float-Toleranz; liefert lesbare Pfade zu jeder Abweichung. */
function compare(actual: unknown, expected: unknown, path = ''): string[] {
  if (isKnown(path)) return []
  const diffs: string[] = []

  if (expected !== null && typeof expected === 'object' && !Array.isArray(expected)) {
    if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) {
      return [`${path}: erwartet object, erhalten ${actual === null ? 'null' : typeof actual}`]
    }
    const e = expected as Record<string, unknown>
    const a = actual as Record<string, unknown>
    for (const key of [...new Set([...Object.keys(e), ...Object.keys(a)])].sort()) {
      const p = `${path}.${key}`
      if (isKnown(p)) continue
      if (!(key in e)) diffs.push(`${p}: NUR in der PWA vorhanden (${JSON.stringify(a[key])})`)
      else if (!(key in a)) diffs.push(`${p}: FEHLT in der PWA (Python: ${JSON.stringify(e[key])})`)
      else diffs.push(...compare(a[key], e[key], p))
    }
    return diffs
  }

  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return [`${path}: erwartet array, erhalten ${typeof actual}`]
    if (actual.length !== expected.length) {
      return [`${path}: Laenge ${actual.length} != Python ${expected.length}`]
    }
    expected.forEach((e, i) => diffs.push(...compare(actual[i], e, `${path}[${i}]`)))
    return diffs
  }

  if (typeof expected === 'number' && typeof actual === 'number') {
    if (Math.abs(actual - expected) > FLOAT_TOL) {
      diffs.push(`${path}: ${actual} != Python ${expected}`)
    }
    return diffs
  }

  if (actual !== expected) {
    diffs.push(`${path}: ${JSON.stringify(actual)} != Python ${JSON.stringify(expected)}`)
  }
  return diffs
}

interface Fixture {
  name: string
  description: string
  input: {
    streams: ActivityStreams & { heartrate: number[] }
    vdot: number
    avg_pace_sec: number
    distance_km: number
  }
  expected: Record<string, unknown>
}

const files = readdirSync(FIXTURE_DIR)
  .filter((f: string) => f.endsWith('.json') && f !== 'MANIFEST.json').sort()
const manifest = JSON.parse(readFileSync(resolve(FIXTURE_DIR, 'MANIFEST.json'), 'utf-8')).fixtures as Record<string, string>

describe('T-171 Parity-Gate: Fixtures', () => {
  it('findet Fixtures (sonst waere das Gate dekorativ)', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  it('Fixtures stimmen mit dem MANIFEST ueberein (Kopplung zum Desktop-Repo)', () => {
    for (const f of files) {
      const blob = readFileSync(resolve(FIXTURE_DIR, f), 'utf-8')
      const digest = createHash('sha256').update(blob).digest('hex')
      expect(manifest[f], `${f} fehlt im MANIFEST`).toBeDefined()
      expect(digest, `${f} weicht vom MANIFEST ab — Fixture von Hand editiert? ` +
        `Neu erzeugen im Desktop-Repo: python3 tests/parity_generate.py && python3 tests/parity_sync.py`,
      ).toBe(manifest[f])
    }
  })
})

describe('T-171 Parity-Gate: TS-Ports gegen Python-Referenz', () => {
  for (const file of files) {
    const fx = JSON.parse(readFileSync(resolve(FIXTURE_DIR, file), 'utf-8')) as Fixture
    const { streams, vdot, avg_pace_sec, distance_km } = fx.input

    it(`${fx.name}: classifyWorkoutStructure`, () => {
      const cls = classifyWorkoutStructure(
        streams.time as number[], streams.velocity_smooth as number[],
        streams.heartrate.length ? streams.heartrate : undefined, vdot,
      )
      const diffs = compare(normalise(cls), fx.expected.classify_workout_structure,
                            'classify_workout_structure')
      expect(diffs, diffs.join('\n  ')).toEqual([])
    })

    it(`${fx.name}: detectStrides`, () => {
      const diffs = compare(normalise(detectStrides(streams, avg_pace_sec, vdot)),
                            fx.expected.detect_strides, 'detect_strides')
      expect(diffs, diffs.join('\n  ')).toEqual([])
    })

    it(`${fx.name}: dataQualityScore`, () => {
      const diffs = compare(normalise(dataQualityScore(streams)),
                            fx.expected.data_quality_score, 'data_quality_score')
      expect(diffs, diffs.join('\n  ')).toEqual([])
    })

    it(`${fx.name}: durabilitySignals`, () => {
      const diffs = compare(normalise(durabilitySignals(streams, distance_km)),
                            fx.expected.durability_signals, 'durability_signals')
      expect(diffs, diffs.join('\n  ')).toEqual([])
    })

    it(`${fx.name}: sessionExecutionQuality`, () => {
      const cls = classifyWorkoutStructure(
        streams.time as number[], streams.velocity_smooth as number[],
        streams.heartrate.length ? streams.heartrate : undefined, vdot,
      )
      const diffs = compare(normalise(sessionExecutionQuality(cls, vdot, distance_km, streams)),
                            fx.expected.session_execution_quality, 'session_execution_quality')
      expect(diffs, diffs.join('\n  ')).toEqual([])
    })
  }
})
