// Inhalt: Bulk-Loader fuer Analyse-Streams/Laps mit persistierten Ergebnissen.
// Zweck: Streams aller Laeufe -> Strides (+ Durability-Cache), Laps der Qualitaetslaeufe
//   -> Work-Splits; sequentiell, Abbruch bei 429/AbortSignal, danach Cache-Kappung.
// Einstieg: loadAnalyticsStreams, ANALYTICS_RESULT_KEY, ANALYTICS_ALGO_VERSION,
//   StrideDataEntry, BulkAnalyticsResult.
// Regeln: importiert ./auth, ./cache, ./api, ./classify, ../vdot, ../durability, ../storage.
// T-173: durability.ts importiert localISODate ueber den Index src/lib/strava.ts — echter
// Modulzyklus, unkritisch, weil keine Seite die andere beim Laden aufruft (ESM live bindings).
import { analyzeWorkoutLaps } from '../vdot'
import { durabilityRecordForRun, upsertDurability } from '../durability'
import { safeSetItem } from '../storage'
import { getValidToken } from './auth'
import { ACTS_KEY, capStreamLapsCaches, _loadCachedStream, _loadCachedLaps } from './cache'
import { _fetchStreams429, _fetchLaps429, type FetchStreamResult, type FetchLapsResult } from './api'
import { detectStrides } from './classify'
import type { StravaActivity, RunSummary } from './types'

// ── Shape types for bulk-loader output ───────────────────────────────────────

export interface StrideDataEntry {
  strideCount:     number
  strides:         { peakPaceSec: number }[]
  avgPeakPaceSec?: number | null
}

// T-260 P-03: compact per-run bulk-loader result, persisted independently of the (capped, large)
// stream/laps caches — a run whose stream was evicted by capStreamLapsCaches is not re-fetched on
// every Analyse visit. `strides`/`splits`: undefined = not computed yet, null = computed, nothing
// found. `v` = VDOT at computation time; kept for older runs on purpose (historic entries keep the
// state of their time, cf. gotchas "Persistierungs-Pfade"); recomputed whenever the stream is
// still cached (free).
export const ANALYTICS_RESULT_KEY = (id: number): string => `_analytics_run_${id}`
// Bump when detectStrides/analyzeWorkoutLaps change semantics — older persisted entries then
// count as "not computed" and are refetched (Fix-Loop 1).
export const ANALYTICS_ALGO_VERSION = 1
const ANALYTICS_RESULT_PREFIX = '_analytics_run_'

interface PersistedRunAnalytics {
  a:        number   // ANALYTICS_ALGO_VERSION at computation time
  v:        number
  strides?: StrideDataEntry | null
  splits?:  number[] | null
}

function _loadRunAnalytics(id: number): PersistedRunAnalytics | null {
  try {
    const raw = localStorage.getItem(ANALYTICS_RESULT_KEY(id))
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || parsed.a !== ANALYTICS_ALGO_VERSION) return null
    return parsed as PersistedRunAnalytics
  } catch { return null }
}

function _saveRunAnalytics(id: number, patch: Partial<PersistedRunAnalytics> & { v: number }): void {
  const prev = _loadRunAnalytics(id) ?? {}   // version mismatch → start fresh (drops stale fields)
  const next = JSON.stringify({ ...prev, ...patch, a: ANALYTICS_ALGO_VERSION })
  try { if (localStorage.getItem(ANALYTICS_RESULT_KEY(id)) === next) return } catch { return }
  safeSetItem(ANALYTICS_RESULT_KEY(id), next)
}

// Drop persisted results of activities no longer in the cached activity list (bounded by it).
function _pruneRunAnalytics(): void {
  let ids: Set<string>
  try {
    const raw = localStorage.getItem(ACTS_KEY)
    const acts: StravaActivity[] = raw ? JSON.parse(raw) : []
    if (!Array.isArray(acts) || acts.length === 0) return
    ids = new Set(acts.map(a => String(a.id)))
  } catch { return }
  const toRemove: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i) || ''
    if (k.startsWith(ANALYTICS_RESULT_PREFIX) && !ids.has(k.slice(ANALYTICS_RESULT_PREFIX.length))) toRemove.push(k)
  }
  for (const k of toRemove) localStorage.removeItem(k)
}

export interface BulkAnalyticsResult {
  strideDataById: Record<string, StrideDataEntry>
  workSplits:     Record<string, number[]>
  partial:        boolean
  fetched:        number
  total:          number
}

/**
 * Bulk-loads streams (for stride detection) and laps (for VDOT adherence) for
 * the provided run sets. Fetches sequentially to avoid rate-limit storms.
 * On HTTP 429: stops immediately and returns a partial result with `partial:true`.
 * Cache-hits never trigger a fetch — the persistent localStorage cache means
 * each activity is only fetched once across sessions.
 *
 * @param allRuns        All runs (used for stream fetch + stride detection)
 * @param qualityRuns    Runs with workout_type==3 (used for lap fetch + work-splits)
 * @param vdot           Current VDOT (used by detectStrides + analyzeWorkoutLaps)
 */
export async function loadAnalyticsStreams(
  allRuns:      RunSummary[],
  qualityRuns:  RunSummary[],
  vdot:         number,
  signal?:      AbortSignal,  // T-260 P-03: effect cleanup aborts — no second parallel loop
): Promise<BulkAnalyticsResult> {
  const strideDataById: Record<string, StrideDataEntry> = {}
  const workSplits:     Record<string, number[]>        = {}
  let partial  = false
  let fetched  = 0
  const total  = allRuns.length + qualityRuns.length

  // T-259 P-07: Token erst bei Cache-Miss holen — Cache-Treffer funktionieren offline / mit
  // nicht erneuerbarem Token. Ein Miss ohne Token überspringt nur diesen Lauf.
  let token: string | null | undefined
  const getToken = async () => (token === undefined ? (token = await getValidToken()) : token)

  // ── Phase 1: streams for all runs → stride detection ─────────────────────
  for (const run of allRuns) {
    if (signal?.aborted) { partial = true; break }
    const cachedStream = _loadCachedStream(run.id)
    let result = cachedStream as FetchStreamResult
    if (!cachedStream) {
      // T-260 P-03: stream evicted by the cache cap but result already persisted → no request.
      const persisted = _loadRunAnalytics(run.id)
      if (persisted && persisted.strides !== undefined) {
        fetched++
        if (persisted.strides) strideDataById[String(run.id)] = persisted.strides
        continue
      }
      const t = await getToken()
      if (!t) continue
      result = await _fetchStreams429(run.id, t)
    }
    if (result === 'rate_limited') { partial = true; break }
    if (!result) continue
    fetched++

    // detectStrides kommt aus ./classify (T-275-Split; frueher dieselbe Datei).
    const analysis = detectStrides(result, run.paceSec, vdot)
    let strideEntry: StrideDataEntry | null = null
    if (analysis.strideCount > 0) {
      strideEntry = {
        strideCount:    analysis.strideCount,
        strides:        analysis.strides.map(s => ({ peakPaceSec: s.peakPaceSec })),
        avgPeakPaceSec: analysis.avgPeakPaceSec,
      }
      strideDataById[String(run.id)] = strideEntry
    }
    _saveRunAnalytics(run.id, { v: vdot, strides: strideEntry })

    // T-142: Durability-Cache aus denselben Streams befüllen (Longrun-Gate).
    if (run.durationSec >= 4500 || run.distanceKm >= 18) {
      const drec = durabilityRecordForRun(run, result)
      if (drec) upsertDurability(run.id, drec)
    }
  }

  // ── Phase 2: laps for quality sessions → work-splits ─────────────────────
  if (!partial) {
    for (const run of qualityRuns) {
      if (signal?.aborted) { partial = true; break }
      const cachedLaps = _loadCachedLaps(run.id)
      let laps = cachedLaps as FetchLapsResult
      if (!cachedLaps) {
        const persisted = _loadRunAnalytics(run.id)
        if (persisted && persisted.splits !== undefined) {
          fetched++
          if (persisted.splits) workSplits[String(run.id)] = persisted.splits
          continue
        }
        const t = await getToken()
        if (!t) continue
        laps = await _fetchLaps429(run.id, t)
      }
      if (laps === 'rate_limited') { partial = true; break }
      if (!laps) continue
      fetched++

      const lapAnalysis = analyzeWorkoutLaps(laps, vdot)
      let splitsEntry: number[] | null = null
      if (lapAnalysis) {
        // Extract pace of interval laps as work-splits (sec/km)
        const intervalSplits = lapAnalysis.laps
          .filter(l => l.role === 'interval' && l.paceSec > 0)
          .map(l => l.paceSec)
        if (intervalSplits.length > 0) {
          workSplits[String(run.id)] = intervalSplits
          splitsEntry = intervalSplits
        }
      }
      _saveRunAnalytics(run.id, { v: vdot, splits: splitsEntry })
    }
  }

  // T-163: cap stream/laps caches after bulk fetch to prevent iOS quota exhaustion.
  // Streams are always re-fetchable; capping here keeps storage within ~5 MB iOS limit.
  capStreamLapsCaches()
  _pruneRunAnalytics()

  return { strideDataById, workSplits, partial, fetched, total }
}
