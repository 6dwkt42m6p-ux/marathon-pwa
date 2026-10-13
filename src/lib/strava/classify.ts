// Inhalt: Workout-Struktur-Klassifikation (v5) und Stride-Erkennung aus Streams.
// Zweck: Geschwindigkeits-Stream -> easy/strides/intervals/tempo/mixed + Bloecke mit Zone;
//   Strides mit Peak-Pace/Erholung. VDOT-Anker fuer die Easy-Baseline.
// Einstieg: classifyWorkoutStructure, detectStrides, WorkoutClassification,
//   IntervalBlock, TempoBlock, StrideAnalysis.
// Paritaet (T-171): handgepflegter Zwilling von streams.py (classify_workout_structure,
//   detect_strides). Golden-Fixtures tests/fixtures/parity/ via parity.test.ts — Python ist
//   Referenz; Schwellen/Branch-Reihenfolge nur zusammen mit streams.py aendern.
// Regeln: importiert ../vdot, ./types.
import { trainingPaces } from '../vdot'
import type { ActivityStreams } from './types'

// ── Workout Classification v5 ───────────────────────────────────────────────

/**
 * Derive stable easy-baseline speed (m/s) from VDOT anchor.
 * Returns null when anchor is implausible (stale VDOT or wrong profile).
 * Plausibility gate: activity median must lie within ±40 % of VDOT-easy speed.
 */
function _vdotAnchor(vdot: number | null | undefined, activityMedianMs: number): number | null {
  if (vdot == null || isNaN(vdot)) return null
  try {
    const p = trainingPaces(vdot)
    const eHighSec = p['E_high']
    if (!eHighSec || !isFinite(eHighSec) || eHighSec <= 0) return null
    const easySpeedMs = 1000 / eHighSec  // convert sec/km → m/s
    if (activityMedianMs > 0) {
      const ratio = activityMedianMs / easySpeedMs
      // Athlete's activity must sit in easy–tempo range (0.6× to 1.4× easy speed)
      if (ratio < 0.60 || ratio > 1.40) return null
    }
    return easySpeedMs
  } catch {
    return null
  }
}

export interface WorkoutStrideSegment {
  startSec:    number
  durationSec: number
  peakSpeedMs: number  // m/s
  // T-248: nur gesetzt, wenn ein Distanz-Stream mit passender Laenge uebergeben wurde
  // (sonst null) — spiegelt streams.py distance_m 1:1, deshalb kein optionales Feld.
  distanceM:   number | null
}

export interface IntervalBlock {
  startSec:   number
  durationSec: number
  avgPaceSec: number   // sec/km
  avgHr?:     number
  // T-248: dito WorkoutStrideSegment.distanceM
  distanceM:  number | null
  // T-193: aus _paceZone(avgMs, baseSpeed), fasst tatsaechliche Blockintensitaet. Optional
  // (nicht `?? "I"` erzwungen), damit handgebaute WorkoutClassification-Objekte ohne Streams
  // (z.B. Tests) weiter kompilieren -- sessionExecutionQuality faellt dann auf workoutType zurueck.
  zone?:      'I' | 'T' | 'M'
}

export interface TempoBlock {
  startSec:     number
  durationSec:  number
  avgPaceSec:   number   // sec/km
  paceDeviation: number  // drift %, end vs start
  // T-248: wie interval_blocks — Docstring in streams.py versprach avg_hr fuer Tempo-Bloecke
  // schon vorher, das Feld fehlte. Gleiches Optional-Muster wie IntervalBlock.avgHr.
  avgHr?:       number
  distanceM:    number | null
  zone?:        'I' | 'T' | 'M'   // T-193: dito
}

// T-193: Zone-Label relativ zur Easy-Baseline des Laufs (faithful port von streams._pace_zone).
// >=20% schneller als Baseline -> I, >=10% -> T, sonst M.
function _paceZone(avgMs: number, baseSpeed: number): 'I' | 'T' | 'M' {
  if (baseSpeed <= 0 || avgMs <= 0) return 'M'
  const ratio = avgMs / baseSpeed
  if (ratio >= 1.20) return 'I'
  if (ratio >= 1.10) return 'T'
  return 'M'
}

export interface WorkoutClassification {
  workoutType:    'easy' | 'strides' | 'intervals' | 'tempo' | 'mixed'
  strides:        WorkoutStrideSegment[]
  intervalBlocks: IntervalBlock[]
  tempoBlocks:    TempoBlock[]
}

export function classifyWorkoutStructure(
  timeStream: number[],
  velocityStream: number[],
  heartrateStream?: number[],
  vdot?: number | null,
  // T-248: letzte Position, Default undefined → bit-identisches Verhalten fuer alle
  // bestehenden Aufrufer (analog streams.py distance_stream=None).
  distanceStream?: number[] | null,
): WorkoutClassification {
  const empty: WorkoutClassification = { workoutType: 'easy', strides: [], intervalBlocks: [], tempoBlocks: [] }
  const n = velocityStream.length
  if (n < 10 || n !== timeStream.length) return empty
  const distOk = distanceStream != null && distanceStream.length === n

  // ── Step 1: ~25s rolling-window smoothing (time-based, matches streams.py) ──
  // Estimate sample rate from the time stream, then derive half-window in samples.
  const nForDt = Math.min(n - 1, 60)
  const rawDeltas: number[] = []
  for (let i = 0; i < nForDt; i++) {
    const d = timeStream[i + 1] - timeStream[i]
    if (d > 0) rawDeltas.push(d)
  }
  rawDeltas.sort((a, b) => a - b)
  const dtMedian = rawDeltas.length > 0 ? rawDeltas[Math.floor(rawDeltas.length / 2)] : 1.0
  // half-window ≈ 12 s on each side → total ~25 s
  const hw = Math.max(1, Math.round(12.0 / dtMedian))

  const smoothed: number[] = new Array(n)
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - hw)
    const hi = Math.min(n, i + hw + 1)
    let sum = 0; let cnt = 0
    for (let j = lo; j < hi; j++) { sum += velocityStream[j]; cnt++ }
    smoothed[i] = cnt > 0 ? sum / cnt : 0
  }

  // ── Step 2: Varianz-Gate — uniformly paced run needs no structure analysis ──
  const posS = smoothed.filter(s => s > 0)
  if (posS.length === 0) return empty
  const meanS = posS.reduce((a, b) => a + b, 0) / posS.length
  if (meanS <= 0) return empty
  const varS = posS.reduce((a, b) => a + (b - meanS) ** 2, 0) / posS.length
  const cv   = Math.sqrt(varS) / meanS
  if (cv < 0.05) return empty

  // ── Step 3: Easy-Baseline ────────────────────────────────────────────────────
  // Priority 1 (VDOT anchor): VDOT-derived E_high speed when plausible.
  // Priority 2 (self-reference): p30–p35 percentile of smoothed distribution
  // (avoids median being pulled up by work-dominant fast blocks — core v5 fix).
  const sortedPos = [...posS].sort((a, b) => a - b)
  const actMedianMs = sortedPos[Math.floor(sortedPos.length / 2)] ?? 0

  const anchoredBase = _vdotAnchor(vdot, actMedianMs)
  let baseSpeed: number
  if (anchoredBase !== null) {
    baseSpeed = anchoredBase
  } else {
    const p30idx = Math.max(0, Math.floor(sortedPos.length * 0.30) - 1)
    const p35idx = Math.max(0, Math.floor(sortedPos.length * 0.35) - 1)
    baseSpeed = (sortedPos[p30idx] + sortedPos[p35idx]) / 2
  }
  if (baseSpeed <= 0) return empty

  // Hysteresis: enter at +10%, exit at +5%
  const enterThr = baseSpeed * 1.10
  const exitThr  = baseSpeed * 1.05

  // ── Step 4: Hysteresis state machine to find elevated-pace blocks ───────────
  const rawBlocks: [number, number][] = []   // [startIdx, endIdx]
  let inBlock = false
  let blkStart = 0
  for (let i = 0; i < n; i++) {
    const s = smoothed[i]
    if (!inBlock) {
      if (s >= enterThr) { inBlock = true; blkStart = i }
    } else {
      if (s < exitThr) { inBlock = false; rawBlocks.push([blkStart, i - 1]) }
    }
  }
  if (inBlock) rawBlocks.push([blkStart, n - 1])
  if (rawBlocks.length === 0) return empty

  // ── Step 5: Gap-Merge (20s, nur GPS-/Mikro-Lücken) + Merge-Guard (≥45s) ────
  const MERGE_GAP_S = 20  // bridge only GPS/micro-gaps; real recovery jogs SEPARATE reps (T-165)
  const MERGE_MIN_S = 45

  const mergedBlocks: [number, number][] = [rawBlocks[0]]
  for (let k = 1; k < rawBlocks.length; k++) {
    const [s2, e2] = rawBlocks[k]
    const [s1, e1] = mergedBlocks[mergedBlocks.length - 1]
    const gapS    = timeStream[s2] - timeStream[e1]
    const durTail = timeStream[e1] - timeStream[s1]
    const durNext = timeStream[e2] - timeStream[s2]
    const blockWorthy = durTail >= MERGE_MIN_S || durNext >= MERGE_MIN_S
    if (gapS <= MERGE_GAP_S && blockWorthy) {
      mergedBlocks[mergedBlocks.length - 1] = [s1, e2]
    } else {
      mergedBlocks.push([s2, e2])
    }
  }

  // ── Step 6: Classify each merged block by duration ──────────────────────────
  const MIN_TEMPO_S    = 180   // ≥ 3 min → tempo
  const MIN_INTERVAL_S = 45   // ≥ 45 s  → interval
  const MIN_STRIDE_S   = 8    // ≥ 8 s   → stride candidate; shorter = GPS spike

  const hrUsable = (() => {
    if (!heartrateStream || heartrateStream.length !== n) return false
    const nValid = heartrateStream.filter(h => h > 0).length
    return nValid / n >= 0.40
  })()

  const strides:        WorkoutStrideSegment[] = []
  const intervalBlocks: IntervalBlock[]        = []
  const tempoBlocks:    TempoBlock[]           = []

  for (const [blkS, blkE] of mergedBlocks) {
    const segT  = timeStream[blkE] - timeStream[blkS]
    const segV  = smoothed.slice(blkS, blkE + 1)
    const avgMs = segV.length > 0 ? segV.reduce((a, b) => a + b, 0) / segV.length : 0
    const paceSec = avgMs > 0 ? Math.round(1000 / avgMs) : 0

    let avgHr: number | undefined
    if (hrUsable && heartrateStream) {
      const hrSeg = heartrateStream.slice(blkS, blkE + 1).filter(h => h > 0)
      // T-248: 1 Nachkommastelle wie Python round(seg_hr, 1) — bisher rundete Math.round()
      // auf ganze bpm; fuer tempoBlocks (neue Fixtures mit z.B. 182.7 bpm) faellt der
      // Float-Toleranzvergleich (1e-6) sonst durch. Betrifft auch intervalBlocks (latent,
      // keine bisherige Fixture mit non-empty interval_blocks deckte es auf).
      if (hrSeg.length > 0) avgHr = Math.round((hrSeg.reduce((a, b) => a + b, 0) / hrSeg.length) * 10) / 10
    }

    // T-248: distance_m — nur gesetzt, wenn distanceStream mit passender Laenge da ist,
    // sonst null (spiegelt streams.py dist_ok exakt).
    const segDistanceM = distOk ? Math.round(distanceStream![blkE] - distanceStream![blkS]) : null

    if (segT < MIN_STRIDE_S) continue  // GPS spike — skip

    if (segT < MIN_INTERVAL_S) {
      // Short peak → stride candidate
      const peakMs = Math.max(...segV)
      strides.push({
        startSec:    timeStream[blkS],
        durationSec: Math.round(segT),
        peakSpeedMs: Math.round(peakMs * 1000) / 1000,
        distanceM:   segDistanceM,
      })
    } else if (segT < MIN_TEMPO_S) {
      // 45s–179s → interval block
      if (paceSec > 0) {
        intervalBlocks.push({ startSec: timeStream[blkS], durationSec: Math.round(segT), avgPaceSec: paceSec, avgHr, zone: _paceZone(avgMs, baseSpeed), distanceM: segDistanceM })
      }
    } else {
      // ≥ 180s → tempo block (pace drift: intra-block, first vs second half)
      if (paceSec > 0) {
        const rawSeg = velocityStream.slice(blkS, blkE + 1)
        const half = Math.floor(rawSeg.length / 2)
        let paceDeviation = 0
        if (half > 0) {
          const firstHalf  = rawSeg.slice(0, half)
          const secondHalf = rawSeg.slice(half)
          const avgFirst  = firstHalf.reduce((a, b) => a + b, 0) / firstHalf.length
          const avgSecond = secondHalf.reduce((a, b) => a + b, 0) / secondHalf.length
          if (avgFirst > 0 && avgSecond > 0) {
            // T-171: streams.py rundet die beiden Haelften-Paces auf GANZE SEKUNDEN,
            // bevor es die Prozentdifferenz bildet. Ohne dieses Zwischenrunden lieferten
            // die Ports auf denselben Streams unterschiedliche Drift-Werte (gemessen an
            // 5×1000m: 3.3/-2.6/0.6 hier gegen 3.6/-2.7/0.4 dort). Python ist die
            // Referenz, also wird hier angeglichen — dass das Zwischenrunden bei ~259 s/km
            // rund 0.4 % Quantisierung einbaut und damit in derselben Groessenordnung wie
            // die gemeldete Drift liegt, ist ein eigener Befund (siehe T-171-Notiz), aber
            // eine Aenderung BEIDER Seiten und deshalb nicht Teil dieses Tickets.
            const pFirst  = Math.round(1000 / avgFirst)
            const pSecond = Math.round(1000 / avgSecond)
            paceDeviation = Math.round((pSecond - pFirst) / pFirst * 100 * 10) / 10
          }
        }
        tempoBlocks.push({ startSec: timeStream[blkS], durationSec: Math.round(segT), avgPaceSec: paceSec, paceDeviation, zone: _paceZone(avgMs, baseSpeed), avgHr, distanceM: segDistanceM })
      }
    }
  }

  // ── Determine workoutType from what was found ────────────────────────────────
  const hasStrides   = strides.length > 0
  const hasIntervals = intervalBlocks.length > 0
  const hasTempo     = tempoBlocks.length > 0
  const typeCount    = [hasStrides, hasIntervals, hasTempo].filter(Boolean).length

  let workoutType: WorkoutClassification['workoutType']
  if (typeCount === 0)       workoutType = 'easy'
  else if (typeCount > 1)    workoutType = 'mixed'
  else if (hasStrides)       workoutType = 'strides'
  else if (hasIntervals)     workoutType = 'intervals'
  else                       workoutType = 'tempo'

  return { workoutType, strides, intervalBlocks, tempoBlocks }
}

// ── Stride detection from velocity stream ────────────────────────────────────

export interface StrideSegment {
  startSec:   number
  endSec:     number
  durationSec: number
  distanceM:  number
  peakPaceSec: number   // fastest point, sec/km
  avgPaceSec:  number   // average over segment
  peakHr?:    number
}

export interface StrideAnalysis {
  strides:           StrideSegment[]
  strideCount:       number
  avgPeakPaceSec:    number | null   // T-171: null = keine Strides (wie streams.py)
  fastestPaceSec:    number | null   // T-171: dito
  thresholdMs:       number
  avgRecoverySec:    number | null   // avg recovery gap between strides
}

export function detectStrides(
  streams: ActivityStreams,
  avgPaceSec: number,
  vdot?: number | null,
): StrideAnalysis {
  const { time, velocity_smooth, heartrate } = streams
  const n = velocity_smooth.length
  if (n < 10) {
    return { strides: [], strideCount: 0, avgPeakPaceSec: null, fastestPaceSec: null, thresholdMs: 0, avgRecoverySec: null }
  }

  const avgSpeedMs = avgPaceSec > 0 ? 1000 / avgPaceSec : 0

  // Compute activity median for VDOT plausibility gate
  const posVel = velocity_smooth.filter(v => v > 0)
  const sortedVel = [...posVel].sort((a, b) => a - b)
  const actMedianMs = sortedVel.length > 0 ? sortedVel[Math.floor(sortedVel.length / 2)] : avgSpeedMs

  // VDOT anchor: use VDOT-derived E_high as reference when plausible.
  // This makes thresholds athlete-specific (absolute) instead of relative to
  // session average, which is elevated in work-dominant runs.
  const anchoredEasyMs = _vdotAnchor(vdot, actMedianMs)
  const refSpeedMs     = anchoredEasyMs ?? avgSpeedMs

  // Raised thresholds (v3): 1.25× ref for peak (was 1.15), 1.12× for trace boundary (was 1.08).
  // At typical Easy 5:30/km, 1.25× ≈ 4:24/km — clearly sprint territory, not GPS drift.
  const peakThreshold = refSpeedMs * 1.25
  const baselineMs    = refSpeedMs * 1.12

  const DWELL_MIN_S    = 3.0   // smoothed speed must stay ≥ peakThreshold for ≥3s contiguously
  const MIN_STRIDE_DUR = 10    // seconds (raised from 8)

  // 5-point moving average to reduce GPS noise
  const smoothed: number[] = new Array(n)
  for (let i = 0; i < n; i++) {
    const slice = velocity_smooth.slice(Math.max(0, i - 2), Math.min(n, i + 3))
    smoothed[i] = slice.reduce((s, x) => s + x, 0) / slice.length
  }

  // Step 1: Find strict local peaks ≥ peakThreshold (5-point local max)
  let peakIdxs: number[] = []
  for (let i = 2; i < n - 2; i++) {
    if (
      smoothed[i] >= peakThreshold &&
      smoothed[i] >= smoothed[i - 1] && smoothed[i] >= smoothed[i - 2] &&
      smoothed[i] >= smoothed[i + 1] && smoothed[i] >= smoothed[i + 2]
    ) {
      peakIdxs.push(i)
    }
  }

  // Step 1b: Dwell-Gate — smoothed speed must stay ≥ peakThreshold for ≥ DWELL_MIN_S seconds
  // contiguously around the peak. Eliminates single-sample GPS spikes.
  peakIdxs = peakIdxs.filter(peakI => {
    let lo = peakI; let hi = peakI
    while (lo > 0     && smoothed[lo - 1] >= peakThreshold) lo--
    while (hi < n - 1 && smoothed[hi + 1] >= peakThreshold) hi++
    const dwellS = hi > lo ? time[hi] - time[lo] : 0
    return dwellS >= DWELL_MIN_S
  })

  // Step 2: For each peak, trace back/forward to baseline crossing
  const strides: StrideSegment[] = []

  for (const peakIdx of peakIdxs) {
    // Enforce ≥15s recovery gap from previous stride
    if (strides.length > 0) {
      const recoverySec = time[peakIdx] - strides[strides.length - 1].endSec
      if (recoverySec < 15) continue
    }

    // Trace back to baseline
    let startIdx = peakIdx
    while (startIdx > 0 && smoothed[startIdx - 1] > baselineMs) startIdx--
    // Trace forward to baseline
    let endIdx = peakIdx
    while (endIdx < n - 1 && smoothed[endIdx + 1] > baselineMs) endIdx++

    const tStart = time[startIdx]
    const tEnd   = time[endIdx]
    const dur    = tEnd - tStart

    if (dur < MIN_STRIDE_DUR || dur > 60) continue

    const seg    = smoothed.slice(startIdx, endIdx + 1)
    // Parity (T-171): Python nimmt die geglaettete Geschwindigkeit AM erkannten Peak-Index
    // (streams.py `peak_ms = smoothed[peak]`), nicht das Maximum ueber das gesamte getracete
    // Fenster. Das Fenster laeuft bis zur Baseline-Kreuzung und kann ein spaeteres, hoeheres
    // lokales Maximum enthalten -- `Math.max(...seg)` lieferte dadurch systematisch eine zu
    // schnelle Peak-Pace (4-15 s/km) gegenueber der Referenz.
    const peakMs = smoothed[peakIdx]
    const avgMs  = seg.reduce((s, v) => s + v, 0) / seg.length
    const distM  = Math.round(avgMs * dur)
    if (distM < 30 || distM > 250) continue

    const hrSeg  = heartrate?.slice(startIdx, endIdx + 1)
    const peakHr = hrSeg && hrSeg.length > 0 ? Math.max(...hrSeg) : undefined

    strides.push({
      startSec:    tStart,
      endSec:      tEnd,
      durationSec: Math.round(dur),
      distanceM:   distM,
      peakPaceSec: peakMs > 0 ? Math.round(1000 / peakMs) : 0,
      avgPaceSec:  avgMs  > 0 ? Math.round(1000 / avgMs)  : 0,
      peakHr,
    })
  }

  // Recovery gap stats
  const recoveryGaps = strides.slice(1).map((s, i) => s.startSec - strides[i].endSec)
  const avgRecoverySec = recoveryGaps.length > 0
    ? Math.round(recoveryGaps.reduce((a, b) => a + b, 0) / recoveryGaps.length) : null

  // T-171: ohne Strides ist das KEINE Pace 0, sondern "nicht anwendbar" -> null (wie
  // streams.py). Die 0 war nicht bloss kosmetisch: aggregateStrideTrend nutzt
  // `sd.avgPeakPaceSec ?? <Fallback>`, und 0 ist nicht nullish — die 0 rutschte also
  // durch den Fallback hindurch und landete als 0:00/km im Strides-Trend.
  const avgPeakPaceSec = strides.length > 0
    ? Math.round(strides.reduce((s, st) => s + st.peakPaceSec, 0) / strides.length) : null
  const fastestPaceSec = strides.length > 0
    ? Math.min(...strides.map(st => st.peakPaceSec)) : null

  return { strides, strideCount: strides.length, avgPeakPaceSec, fastestPaceSec, thresholdMs: peakThreshold, avgRecoverySec }
}
