// T-283 — Twin-Registry + gespiegelte Goldens, PWA-Seite.
//
// tests/fixtures/parity/TWINS.json listet jeden handgepflegten Zwilling Python <-> TS samt
// Absicherung; twin_goldens.json traegt Eingaben + Erwartungswerte aus der Python-Referenz
// (Desktop: tests/parity_generate_twins.py, geprueft in tests/test_t283_twins.py). Beide
// Dateien gehoeren dem Desktop-Repo und sind per MANIFEST.json gekoppelt (parity.test.ts).
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { computeAtlCtl, runRtss, runHrtss, bikeTss, parseRuns, efficiencyFactorTrend, localISODate } from './strava'
import type { StravaActivity } from './strava'
import { racePredictor, formatPace } from './vdot'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '../..')
const FIXTURE_DIR = resolve(REPO, 'tests/fixtures/parity')
const load = (f: string) => JSON.parse(readFileSync(resolve(FIXTURE_DIR, f), 'utf-8'))

interface Twin { python: string | null; ts: string; guard: 'fixture' | 'golden' | 'none'; note: string }
const twins = load('TWINS.json') as { kind: string; twins: Twin[] }

describe('T-283 Twin-Registry', () => {
  it('hat die erwartete Form', () => {
    expect(twins.kind).toBe('twin_registry')
    expect(twins.twins.length).toBeGreaterThanOrEqual(30)
    for (const t of twins.twins) expect(['fixture', 'golden', 'none']).toContain(t.guard)
  })

  for (const t of twins.twins) {
    it(`${t.ts} wird exportiert`, () => {
      const [path, sym] = t.ts.split('#')
      const file = resolve(REPO, path)
      expect(existsSync(file), `${path} fehlt`).toBe(true)
      const re = new RegExp(`^export\\s+(?:async\\s+)?(?:function|const|let|class)\\s+${sym}\\b`, 'm')
      expect(re.test(readFileSync(file, 'utf-8')), `${sym} nicht exportiert in ${path}`).toBe(true)
    })
  }
})

// ---------------------------------------------------------------------------
// Neu gefundene Wert-Divergenzen (Fall-ID -> Grund + Ticket). Eintraege laufen als
// it.fails: wird der PWA-Port korrigiert, wird der Test rot und der Eintrag MUSS raus.
// Die Liste darf nur schrumpfen (wie KNOWN_DIVERGENCES in parity.test.ts).
// ---------------------------------------------------------------------------
// Alle Eintraege beim ersten Lauf von T-283 gefunden und an den Coordinator gemeldet
// (Ticket-Entscheidung offen, siehe memory/tickets/T-283_impl.md).
const GOLDEN_DIVERGENCES: Record<string, string> = {
  'atl_ctl/threshold_runs':
    'activityLoad rundet rTSS/hrTSS/Faktor-Last je Aktivitaet (Math.round), coach_load._daily_load ' +
    'nicht; dazu ist pace_sec_km in Python auf 0.1 s gerundet. ATL 20.4 statt 20.3.',
  'atl_ctl/walk_recovery':
    'PWA kennt classify_hike nicht (T-134): kurze Walks/Hikes ("spaziergang") zaehlen als Last, ' +
    'Desktop ueberspringt sie. ATL 5.8 statt 3.3.',
  'ef_trend/rising':
    'efSmooth = Median der bereits auf 4 Stellen gerundeten Wochenmediane; Python glaettet die ' +
    'ungerundeten Werte und rundet danach (Abweichung 1e-4 an 2er-Randfenstern).',
  'ef_trend/hilly_hot_stable': 'wie ef_trend/rising (efSmooth-Rundungsreihenfolge).',
  'ef_trend/falling': 'wie ef_trend/rising (efSmooth-Rundungsreihenfolge).',
  'ef_trend/no_hr': 'no_hr_data-Zweig: deltaPct 0 statt null (TS-Typ number).',
  'race_predictor/m_fatigued':
    'bandPct: Math.round(x*1e4)/1e4 rundet .5 auf, Python round(x, 4) half-to-even ' +
    '(0.03125 -> 0.0313 vs 0.0312). Betrifft jede ungerade Wochenzahl bis Rennen.',
  'race_predictor/5k_taper_fresh': 'wie race_predictor/m_fatigued (0.01875 -> 0.0188 vs 0.0187).',
}

const gold = load('twin_goldens.json')
const TOL = 1e-9

function diff(a: unknown, e: unknown, path = ''): string[] {
  if (e !== null && typeof e === 'object' && !Array.isArray(e)) {
    if (a === null || typeof a !== 'object') return [`${path}: ${JSON.stringify(a)} != Python object`]
    const ao = a as Record<string, unknown>, eo = e as Record<string, unknown>
    const keys = [...new Set([...Object.keys(ao), ...Object.keys(eo)])].sort()
    return keys.flatMap(k => !(k in eo) ? [`${path}.${k}: nur PWA`] : !(k in ao)
      ? [`${path}.${k}: fehlt in PWA (Python ${JSON.stringify(eo[k])})`] : diff(ao[k], eo[k], `${path}.${k}`))
  }
  if (Array.isArray(e)) {
    if (!Array.isArray(a) || a.length !== e.length) return [`${path}: ${JSON.stringify(a)} != Python ${JSON.stringify(e)}`]
    return e.flatMap((x, i) => diff(a[i], x, `${path}[${i}]`))
  }
  if (typeof e === 'number' && typeof a === 'number') return Math.abs(a - e) <= TOL ? [] : [`${path}: ${a} != Python ${e}`]
  return a === e ? [] : [`${path}: ${JSON.stringify(a)} != Python ${JSON.stringify(e)}`]
}

function goldenIt(id: string, actual: () => unknown, expected: unknown) {
  const run = () => { const d = diff(actual(), expected, id); expect(d, d.join('\n  ')).toEqual([]) }
  if (id in GOLDEN_DIVERGENCES) it.fails(`${id} (bekannte Divergenz: ${GOLDEN_DIVERGENCES[id]})`, run)
  else it(id, run)
}

/** days_ago -> start_date_local (lokales Datum 12:00, Strava-Z-Suffix) — wie materialize() in Python. */
function materialize(acts: Record<string, unknown>[]): StravaActivity[] {
  return acts.map(({ days_ago, ...rest }) => {
    const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - (days_ago as number))
    const s = `${localISODate(d)}T12:00:00Z`
    return { ...rest, start_date: s, start_date_local: s } as unknown as StravaActivity
  })
}

type Acts = Record<string, unknown>[]
type Thr = { lthr: number; threshold_pace_sec: number; rest_hr: number } | null

describe('T-283 Golden-Paritaet: rTSS / hrTSS / bikeTss', () => {
  const fns: Record<string, (...a: number[]) => number | null> = {
    run_rtss: (d, p, tp) => runRtss(d, p, tp),
    run_hrtss: (d, hr, lt, rh) => runHrtss(d, hr, lt, rh),
    bike_tss: (np, d, ftp) => bikeTss(np, d, ftp),
  }
  ;(gold.tss as { fn: string; args: number[]; expected: number | null }[]).forEach((c, i) =>
    goldenIt(`tss/${i}-${c.fn}(${c.args.join(',')})`, () => fns[c.fn](...c.args), c.expected))
})

describe('T-283 Golden-Paritaet: computeAtlCtl', () => {
  for (const c of gold.atl_ctl as { name: string; ftp: number | null; threshold: Thr; activities: Acts; expected: unknown }[]) {
    const thr = c.threshold ? { ...c.threshold, is_fallback: false, source: 'golden' } : undefined
    goldenIt(`atl_ctl/${c.name}`, () => computeAtlCtl(materialize(c.activities), c.ftp ?? undefined, thr), c.expected)
  }
})

describe('T-283 Golden-Paritaet: efficiencyFactorTrend', () => {
  for (const c of gold.ef_trend as { name: string; activities: Acts; expected: unknown }[]) {
    goldenIt(`ef_trend/${c.name}`, () => {
      const r = efficiencyFactorTrend(parseRuns(materialize(c.activities)), 190, 50, 8)
      if (r === null) return null
      return {
        early_ef: r.earlyEf, recent_ef: r.recentEf, delta_ef: r.deltaEf, delta_pct: r.deltaPct,
        direction: r.direction, label: r.label, color: r.color, no_hr_data: r.noHrData,
        weekly: r.weekly.map(w => ({ ef_median: w.efMedian, ef_smooth: w.efSmooth, run_count: w.runCount })),
      }
    }, c.expected)
  }
})

describe('T-283 Golden-Paritaet: racePredictor', () => {
  type O = { weeks_to_race?: number; tsb?: number; ctl_rising?: boolean; durability_factor?: number; pace_fade_recent?: number; low_data?: boolean }
  for (const c of gold.race_predictor as { name: string; vdot: number | null; dist: number; opts: O; expected: unknown }[]) {
    goldenIt(`race_predictor/${c.name}`, () => {
      const r = racePredictor(c.vdot, c.dist, {
        weeksToRace: c.opts.weeks_to_race, tsb: c.opts.tsb, ctlRising: c.opts.ctl_rising,
        durabilityFactor: c.opts.durability_factor, paceFadeRecent: c.opts.pace_fade_recent,
        lowData: c.opts.low_data,
      })
      return {
        predicted_sec: r.predictedSec, range_low_sec: r.rangeLowSec, range_high_sec: r.rangeHighSec,
        base_sec: r.baseSec, band_pct: r.bandPct, confidence: r.confidence, eff_vdot: r.effVdot,
        fitness_gain_vdot: r.fitnessGainVdot, durability_mult: r.durabilityMult,
        taper_mult: r.taperMult, notes: r.notes,
      }
    }, c.expected)
  }
})

describe('T-283 Golden-Paritaet: formatPace (.5 rundet half-to-even wie Python round)', () => {
  for (const c of gold.format_pace as { sec: number | null; expected: string }[]) {
    goldenIt(`format_pace/${c.sec}`, () => formatPace(c.sec ?? NaN), c.expected)
  }
})
