// Inhalt: localStorage-Caches fuer Strava-Daten (Aktivitaetsliste, Streams, Laps).
// Zweck: Lesen/Schreiben/Kappen der Caches; Quota-Fallback ueber storage.ts.
// Einstieg: getCachedActivities, saveCachedActivitiesExported, capStreamLapsCaches,
//   evictAllStreamLapsCaches, STREAM_CACHE_KEY/LAPS_CACHE_KEY.
// Abschnitte: Konstanten · Aktivitaetsliste (load/save/evict/cap) · Stream-/Laps-Cache.
// Seiteneffekt beim Laden: registerEvictCallback(evictAllStreamLapsCaches) (T-170).
// Intern (fuer api/bulk/auth, nicht im Index): ACTS_KEY, loadCachedActivities,
//   saveCachedActivities, _loadCachedStream/_cacheStream/_loadCachedLaps/_cacheLaps.
// Regeln: importiert nur storage.ts + ./types; kennt weder auth noch api (zyklenfrei).
// T-170: STORAGE_WARNING_KEY/clearStorageWarning leben kanonisch in storage.ts; storage.ts
// importiert nie strava/* (siehe registerEvictCallback) — einseitige Kante, zyklenfrei.
import { STORAGE_WARNING_KEY, clearStorageWarning, registerEvictCallback } from '../storage'
import type { StravaActivity, ActivityStreams } from './types'

export const ACTS_KEY           = 'strava_activities'
// T-163: cap on how many activities' stream/laps caches to keep (oldest beyond cap are evicted).
// iOS localStorage ~5 MB; each stream can be 20–100 KB → 40 activities ≈ safe upper bound.
export const STREAM_CACHE_MAX = 40

export function loadCachedActivities(): StravaActivity[] {
  try {
    const raw = localStorage.getItem(ACTS_KEY)
    return raw ? JSON.parse(raw) : []
  } catch { return [] }
}

// T-163: remove all _strava_stream_* and _strava_laps_* keys from localStorage.
// Streams are always re-fetchable from Strava — safe to evict unconditionally.
export function evictAllStreamLapsCaches(): void {
  const keysToRemove: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i) || ''
    if (k.startsWith('_strava_stream_') || k.startsWith('_strava_laps_')) {
      keysToRemove.push(k)
    }
  }
  for (const k of keysToRemove) localStorage.removeItem(k)
}

// T-170: register this module's eviction function as the fallback safeSetItem() uses on quota
// errors — module-load side effect, see storage.ts registerEvictCallback doc comment.
registerEvictCallback(evictAllStreamLapsCaches)

// T-163: keep stream/laps caches only for the N most recent activities.
// Called after the bulk analytics fetch so the cache never grows unboundedly.
export function capStreamLapsCaches(maxActivities = STREAM_CACHE_MAX): void {
  // Load activity list to determine recency order
  let acts: StravaActivity[] = []
  try {
    const raw = localStorage.getItem(ACTS_KEY)
    acts = raw ? JSON.parse(raw) : []
  } catch { return }

  // Sort descending by start_date (UTC ISO string compare is safe for lexicographic sort)
  const sorted = [...acts].sort((a, b) =>
    String(b.start_date).localeCompare(String(a.start_date))
  )
  const keepIds = new Set(sorted.slice(0, maxActivities).map(a => String(a.id)))

  const keysToRemove: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i) || ''
    if (k.startsWith('_strava_stream_') || k.startsWith('_strava_laps_')) {
      const id = k.replace('_strava_stream_', '').replace('_strava_laps_', '')
      if (!keepIds.has(id)) keysToRemove.push(k)
    }
  }
  for (const k of keysToRemove) localStorage.removeItem(k)
}

// T-163: Prioritised save strategy:
//   1. Try writing the full activity list directly.
//   2. On quota error: evict ALL stream/laps caches, then retry the full list.
//   3. Only as last resort (still fails after eviction): trim to 500 and retry.
//   4. If all three fail: set STORAGE_WARNING_KEY and return false (never throw).
//   Returns true on success (any path), false only on total failure.
// Exported as saveCachedActivitiesExported for unit tests; internal callers use the private alias.
export function saveCachedActivitiesExported(acts: StravaActivity[]): boolean {
  const payload = JSON.stringify(acts)
  try {
    localStorage.setItem(ACTS_KEY, payload)
    clearStorageWarning()
    return true
  } catch {
    // First fallback: evict stream/laps caches (they are re-fetchable), then retry full list.
    evictAllStreamLapsCaches()
    try {
      localStorage.setItem(ACTS_KEY, payload)
      clearStorageWarning()
      return true
    } catch {
      // Last resort: trim and retry. Avoids total loss when storage is genuinely full.
      const trimmed = acts.slice(-500)
      try {
        localStorage.setItem(ACTS_KEY, JSON.stringify(trimmed))
        try { localStorage.setItem(STORAGE_WARNING_KEY, '1') } catch {}
        return false  // trimmed save counts as failure — caller shows warning
      } catch {
        try { localStorage.setItem(STORAGE_WARNING_KEY, '1') } catch {}
        return false
      }
    }
  }
}

// Internal alias used by syncActivities — keeps the rest of the file unchanged.
export function saveCachedActivities(acts: StravaActivity[]): void {
  saveCachedActivitiesExported(acts)
}

export function getCachedActivities(): StravaActivity[] {
  return loadCachedActivities()
}

// ── Activity Streams — persistent localStorage cache + 429-safe fetch ────────

// Cache key functions — exported so tests can pre-populate and verify cache behaviour.
// Streams and laps for a completed activity are immutable → no TTL needed.
export const STREAM_CACHE_KEY = (id: number): string => `_strava_stream_${id}`
export const LAPS_CACHE_KEY   = (id: number): string => `_strava_laps_${id}`

export function _loadCachedStream(id: number): ActivityStreams | null {
  try {
    const raw = localStorage.getItem(STREAM_CACHE_KEY(id))
    if (!raw) return null
    const parsed = JSON.parse(raw)
    // Accept both the raw Strava response shape (key→{data:[]}) and the already-parsed shape.
    if (Array.isArray(parsed.time)) return parsed as ActivityStreams
    return {
      time:            parsed.time?.data            ?? [],
      velocity_smooth: parsed.velocity_smooth?.data ?? [],
      heartrate:       parsed.heartrate?.data,
      altitude:        parsed.altitude?.data,
      distance:        parsed.distance?.data,
    }
  } catch { return null }
}

export function _cacheStream(id: number, streams: ActivityStreams): void {
  try { localStorage.setItem(STREAM_CACHE_KEY(id), JSON.stringify(streams)) } catch {}
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function _loadCachedLaps(id: number): any[] | null {
  try {
    const raw = localStorage.getItem(LAPS_CACHE_KEY(id))
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function _cacheLaps(id: number, laps: any[]): void {
  try { localStorage.setItem(LAPS_CACHE_KEY(id), JSON.stringify(laps)) } catch {}
}
