// Inhalt: Re-Export-Index der Strava-Schicht (T-275) — alle Importe `from './strava'` /
//   `from '../lib/strava'` bleiben gueltig; der Code liegt in src/lib/strava/*.ts.
// Karte: types (Datentypen) · cache (localStorage-Caches) · auth (OAuth/Tokens)
//   · api (Sync + Streams/Laps-Fetch) · parse (Parsing, Wochenstatistik, Datums-Helfer)
//   · trend (VDOT-/EF-Trend, T-194-Golden) · load (TSS, ATL/CTL) · bulk (Analyse-Bulk-Loader)
//   · classify (Workout-Struktur + Strides, Paritaets-Zwilling zu streams.py, T-171).
// Graph (zyklenfrei): types <- cache <- auth <- api <- bulk; types <- parse <- trend/load;
//   classify <- bulk. Einzige Fremdkante zurueck: durability.ts -> Index (T-173, s. bulk.ts).
// Regeln: hier nur explizite Re-Exports der oeffentlichen API (keine Logik, kein export *),
//   damit interne Helfer (_loadCachedStream, _fetchStreams429 …) nicht oeffentlich werden.
//   Neues oeffentliches Symbol -> im Fachmodul exportieren UND hier eintragen.
// T-170: STORAGE_WARNING_KEY/getStorageWarning/clearStorageWarning leben in storage.ts und
//   werden fuer bestehende Importe (App.tsx, strava.test.ts) hier weitergereicht.
export { STORAGE_WARNING_KEY, getStorageWarning, clearStorageWarning } from './storage'

export type { StravaTokens, StravaActivity, RunSummary, ActivitySummary, ActivityStreams } from './strava/types'

export {
  STREAM_CACHE_MAX, evictAllStreamLapsCaches, capStreamLapsCaches, saveCachedActivitiesExported,
  getCachedActivities, STREAM_CACHE_KEY, LAPS_CACHE_KEY,
} from './strava/cache'

export {
  REDIRECT_URI, STRAVA_REAUTH_KEY, getAuthUrl, parseOAuthCallback, loadTokens, saveTokens,
  clearTokens, isAuthenticated, getValidToken, exchangeCode,
} from './strava/auth'
export type { OAuthCallback } from './strava/auth'

export {
  StravaRateLimitError, STRAVA_LAST_SYNC_KEY, saveLastSyncTimestamp, loadLastSyncTimestamp,
  SYNC_MIN_INTERVAL_SEC, secsSinceLastSync, OVERLAP_DAYS, syncAnchorTs, syncActivities,
  fetchActivityStreams, fetchActivityLaps,
} from './strava/api'

export {
  isRunType, DAY_TAGS, parseStravaLocal, parseAllActivities, mondayOf, localISODate,
  computeWeeklyStats, thisWeekStatsBySport, computeWeeklyStatsBySport, thisWeekKm, parseRuns,
} from './strava/parse'
export type { WeekStats, SportWeekStats, SportWeeklyStats } from './strava/parse'

export {
  MIN_TREND_EFFORT_RUNS, vdotTrendFromActivities, bestVdotFromActivities, efficiencyFactorTrend,
} from './strava/trend'
export type {
  EasyHrTrend, VdotTrend, BestVdotResult, EfWeeklyPoint, EfficiencyFactorTrendResult,
} from './strava/trend'

export {
  bikeTss, runRtss, runHrtss, activityLoad, dailyLoadSeries, computeAtlCtl, ctlRising,
} from './strava/load'
export type { AtlCtlResult, SyncedThreshold } from './strava/load'

export { ANALYTICS_RESULT_KEY, ANALYTICS_ALGO_VERSION, loadAnalyticsStreams } from './strava/bulk'
export type { StrideDataEntry, BulkAnalyticsResult } from './strava/bulk'

export { classifyWorkoutStructure, detectStrides } from './strava/classify'
export type {
  WorkoutStrideSegment, IntervalBlock, TempoBlock, WorkoutClassification, StrideSegment,
  StrideAnalysis,
} from './strava/classify'
