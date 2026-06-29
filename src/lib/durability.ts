// T-142: PWA-Parität zum Desktop-Durability-Trend (T-141, SSoT streams.py/coach.py).
// HR-Decoupling + GAP-bereinigter Pace-Fade pro Longrun → Trend-Regression + Verdikt.
import { gapFactorForGrade } from './vdot'
import { localISODate } from './strava'
import type { ActivityStreams, RunSummary } from './strava'

export interface DurabilityRecord {
  driftPct:    number | null
  paceFadePct: number | null
  gapAdjusted: boolean
  durationS:   number
  distanceKm:  number | null
  date:        string | null   // ISO yyyy-mm-dd (lokal, T-079-konform)
}

export interface DurabilitySignalTrend {
  slopePerWeek: number
  direction:    '↑' | '→' | '↓'
  label:        string
  color:        string
  recentAvg:    number
  earlyAvg:     number
  series:       Array<[number, number]>  // (Tag seit erstem Longrun, Wert)
}

export interface DurabilityTrend {
  drift:       DurabilitySignalTrend | null
  fade:        DurabilitySignalTrend | null
  nLongruns:   number
  windowWeeks: number
}

const TOTBAND = 0.3
const MIN_DURATION_SEC = 1200

function mean(xs: number[]): number { return xs.reduce((a, b) => a + b, 0) / xs.length }

// ── Cardiac drift (Port von streams.cardiac_drift_pct) ───────────────────────
export function cardiacDriftPct(
  time: number[] | undefined, hr: number[] | undefined, velocity: number[] | undefined,
  minDurationSec = MIN_DURATION_SEC,
): number | null {
  if (!time || !hr || !velocity) return null
  const n = Math.min(time.length, hr.length, velocity.length)
  if (n < 2) return null
  const duration = time[n - 1] - time[0]
  if (duration < minDurationSec) return null
  const midTime = time[0] + duration / 2
  let split = Math.floor(n / 2)
  for (let i = 0; i < n; i++) { if (time[i] >= midTime) { split = i; break } }
  if (split < 1 || split >= n - 1) return null
  const meanHr1 = mean(hr.slice(0, split)), meanHr2 = mean(hr.slice(split, n))
  const meanV1 = mean(velocity.slice(0, split)), meanV2 = mean(velocity.slice(split, n))
  if (meanHr1 <= 0 || meanHr2 <= 0) return null
  const ef1 = meanV1 / meanHr1, ef2 = meanV2 / meanHr2
  if (ef1 === 0) return null
  return Math.round(((ef1 - ef2) / ef1 * 100) * 100) / 100
}

// ── Flach-äquivalente Pace einer Hälfte: rawPace / gapFactor ─────────────────
function halfEqPace(velHalf: number[], distHalf: number[], altHalf: number[]): number | null {
  if (!velHalf.length) return null
  const meanV = mean(velHalf)
  if (meanV <= 0) return null
  const rawPace = 1000 / meanV // s/km
  let gradePct = 0
  if (distHalf.length >= 2 && altHalf.length >= 2) {
    const dDelta = distHalf[distHalf.length - 1] - distHalf[0]
    const aDelta = altHalf[altHalf.length - 1] - altHalf[0]
    if (dDelta > 0 && Number.isFinite(aDelta)) gradePct = aDelta / dDelta * 100
  }
  const factor = Number.isFinite(gradePct) ? gapFactorForGrade(gradePct) : 1
  return rawPace / factor
}

// ── Per-Longrun Signal ───────────────────────────────────────────────────────
export function durabilitySignals(
  streams: ActivityStreams, distanceKm?: number, _tempC?: number,
  minDurationSec = MIN_DURATION_SEC,
): DurabilityRecord | null {
  if (!streams) return null
  const time = streams.time, vel = streams.velocity_smooth
  const hr = streams.heartrate, alt = streams.altitude, dist = streams.distance
  if (!time || !vel) return null
  const n = Math.min(time.length, vel.length)
  if (n < 2) return null
  const duration = time[n - 1] - time[0]
  if (duration < minDurationSec) return null
  const midTime = time[0] + duration / 2
  let split = Math.floor(n / 2)
  for (let i = 0; i < n; i++) { if (time[i] >= midTime) { split = i; break } }
  if (split < 1 || split >= n - 1) return null

  const slice = (seq?: number[]): [number[], number[]] =>
    !seq ? [[], []] : [seq.slice(0, split), seq.slice(split, n)]
  const [v1, v2] = slice(vel)
  const [d1, d2] = slice(dist)
  const [a1, a2] = slice(alt)

  const eq1 = halfEqPace(v1, d1, a1), eq2 = halfEqPace(v2, d2, a2)
  let paceFadePct: number | null = null
  if (eq1 && eq2 && eq1 > 0) paceFadePct = Math.round(((eq2 - eq1) / eq1 * 100) * 100) / 100

  const driftPct = cardiacDriftPct(time, hr, vel, minDurationSec)
  if (paceFadePct === null && driftPct === null) return null

  let distKm = distanceKm ?? null
  if (distKm === null && dist && dist.length >= 2) distKm = (dist[n - 1] - dist[0]) / 1000

  return {
    driftPct, paceFadePct,
    gapAdjusted: !!(alt && dist),
    durationS: duration,
    distanceKm: distKm !== null ? Math.round(distKm * 1000) / 1000 : null,
    date: null,
  }
}

// ── Trend (Port von coach.durability_trend) ──────────────────────────────────
function olsSlopePerWeek(points: Array<[number, number]>): number {
  if (points.length < 2) return 0
  const n = points.length
  const sx = points.reduce((a, p) => a + p[0], 0)
  const sy = points.reduce((a, p) => a + p[1], 0)
  const sxx = points.reduce((a, p) => a + p[0] * p[0], 0)
  const sxy = points.reduce((a, p) => a + p[0] * p[1], 0)
  const denom = n * sxx - sx * sx
  if (denom === 0) return 0
  return ((n * sxy - sx * sy) / denom) * 7
}

function signalVerdict(
  valuesByDay: Array<[number, number | null]>, kind: 'drift' | 'fade', minRuns: number,
): DurabilitySignalTrend | null {
  const pts = valuesByDay.filter(([, y]) => y !== null && Number.isFinite(y)) as Array<[number, number]>
  if (pts.length < minRuns) return null
  const slope = olsSlopePerWeek(pts)
  const sorted = [...pts].sort((a, b) => a[0] - b[0])
  const recent = sorted.slice(-3).map(p => p[1])
  const early = sorted.slice(0, Math.max(1, Math.floor(sorted.length / 2))).map(p => p[1])
  const recentAvg = Math.round(mean(recent) * 100) / 100
  const earlyAvg = Math.round(mean(early) * 100) / 100
  const labelKind = kind === 'drift' ? 'HR-Decoupling' : 'Pace-Fade'
  let direction: '↑' | '→' | '↓', color: string, label: string
  if (slope < -TOTBAND) {
    direction = '↓'; color = '#2ECC71'; label = `${labelKind} sinkt — Durability verbessert sich`
  } else if (slope > TOTBAND) {
    direction = '↑'; color = '#E74C3C'; label = `${labelKind} steigt — späte Haltbarkeit baut ab (Sub-3-Limiter)`
  } else {
    direction = '→'; color = '#F1C40F'; label = `${labelKind} stabil`
  }
  return {
    slopePerWeek: Math.round(slope * 1000) / 1000,
    direction, label, color, recentAvg, earlyAvg,
    series: sorted.map(([x, y]) => [Math.round(x * 10) / 10, y] as [number, number]),
  }
}

export function durabilityTrend(
  records: DurabilityRecord[], windowWeeks = 12, minRuns = 3,
): DurabilityTrend | null {
  if (!records || !records.length) return null
  const now = new Date()
  const cutoff = new Date(now); cutoff.setDate(cutoff.getDate() - windowWeeks * 7)

  const longruns: Array<{ day: Date; rec: DurabilityRecord }> = []
  for (const rec of records) {
    if (!rec.date) continue
    const day = new Date(rec.date + 'T00:00:00')
    if (isNaN(day.getTime()) || day < cutoff) continue
    const dur = Number(rec.durationS) || 0
    const dist = Number(rec.distanceKm) || 0
    if (dur >= 4500 || dist >= 18) longruns.push({ day, rec })
  }

  const nLongruns = longruns.length
  const firstDay = longruns.length ? new Date(Math.min(...longruns.map(l => l.day.getTime()))) : null
  const dayIdx = (d: Date) => firstDay ? (d.getTime() - firstDay.getTime()) / 86400000 : 0
  const series = (field: 'driftPct' | 'paceFadePct'): Array<[number, number | null]> =>
    longruns.map(l => [dayIdx(l.day), l.rec[field]] as [number, number | null])

  const drift = firstDay ? signalVerdict(series('driftPct'), 'drift', minRuns) : null
  const fade = firstDay ? signalVerdict(series('paceFadePct'), 'fade', minRuns) : null
  return { drift, fade, nLongruns, windowWeeks }
}

// ── localStorage-Store (eigener Cache, Desktop-Spiegel) ──────────────────────
export const DURABILITY_CACHE_KEY = (id: number): string => `_durability_${id}`

export function upsertDurability(id: number, rec: DurabilityRecord): void {
  try { localStorage.setItem(DURABILITY_CACHE_KEY(id), JSON.stringify(rec)) } catch { /* quota */ }
}

export function loadAllDurability(): DurabilityRecord[] {
  const out: DurabilityRecord[] = []
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key || !key.startsWith('_durability_')) continue
      try {
        const parsed = JSON.parse(localStorage.getItem(key) || '')
        if (parsed && typeof parsed === 'object') out.push(parsed as DurabilityRecord)
      } catch { /* skip corrupt */ }
    }
  } catch { /* localStorage unavailable */ }
  return out
}

// Helper für die Bulk-Loader-Verdrahtung (Task 3): Record aus einem Run + Streams bauen.
export function durabilityRecordForRun(run: RunSummary, streams: ActivityStreams): DurabilityRecord | null {
  const rec = durabilitySignals(streams, run.distanceKm, run.tempC)
  if (!rec) return null
  rec.date = localISODate(run.date)
  rec.distanceKm = run.distanceKm
  return rec
}
