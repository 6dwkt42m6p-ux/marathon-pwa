// Persistent user settings via localStorage

// ── T-170: quota-safe write helper ──────────────────────────────────────────
// Folgebefund zu T-163: T-163 haertete nur den Activity-Cache + Stream/Laps-Caches gegen
// QuotaExceededError. Alle uebrigen localStorage.setItem-Aufrufe warfen unbehandelt in den
// React-Handler (schlimmster Fall: strava.ts saveTokens() — stiller Logout).
//
// Dependency-Richtung (Zyklus-Vermeidung storage.ts <-> strava.ts): die Evict-Logik fuer
// re-fetchbare Stream-/Laps-Caches lebt in strava.ts (evictAllStreamLapsCaches, T-163), aber
// strava.ts braucht safeSetItem selbst (fuer saveTokens). Ein direkter Import in beide
// Richtungen waere ein Zyklus. Loesung: storage.ts bleibt die "neutrale" Basis (importiert aus
// KEINER anderen lib/-Datei), strava.ts registriert seine Evict-Funktion hier per Callback beim
// Modul-Load (registerEvictCallback(evictAllStreamLapsCaches)). storage.ts kennt strava.ts nie.
let _evictReFetchableCaches: (() => void) | null = null
export function registerEvictCallback(fn: () => void): void {
  _evictReFetchableCaches = fn
}

// T-163: flag key set when all eviction attempts still failed — App shows a storage warning
// banner. Kanonisch hier definiert (vorher dupliziert in strava.ts); strava.ts re-exportiert
// diese drei Symbole unveraendert, damit bestehende Importe (App.tsx, strava.test.ts) stabil
// bleiben.
export const STORAGE_WARNING_KEY = '_strava_storage_warning'

export function getStorageWarning(): string | null {
  try { return localStorage.getItem(STORAGE_WARNING_KEY) }
  catch { return null }
}

export function clearStorageWarning(): void {
  try { localStorage.removeItem(STORAGE_WARNING_KEY) }
  catch { /* iOS private mode */ }
}

// Ablauf: try setItem -> Quota-Fehler -> re-fetchbare Caches evicten (registrierter Callback,
// no-op falls keiner registriert) -> Retry -> erneuter Fehler -> STORAGE_WARNING_KEY setzen,
// false zurueckgeben. Wirft NIE — Aufrufer werten den Rueckgabewert aus statt Erfolg
// vorzutaeuschen (Kern von T-170).
export function safeSetItem(key: string, value: string): boolean {
  try {
    localStorage.setItem(key, value)
    return true
  } catch {
    try { _evictReFetchableCaches?.() } catch { /* eviction itself must never throw further */ }
    try {
      localStorage.setItem(key, value)
      return true
    } catch {
      try { localStorage.setItem(STORAGE_WARNING_KEY, '1') } catch { /* iOS private mode */ }
      return false
    }
  }
}

export interface AppSettings {
  vdot:          number
  maxHr:         number
  restHr:        number
  currentWeeklyKm: number
  runsPerWeek:   number
  raceType1:     'hm' | 'marathon'
  raceDate1:     string   // ISO date string
  raceType2:     'hm' | 'marathon'
  raceDate2:     string
  preRaceEnabled: boolean // HM before Marathon
  experience:    'einsteiger' | 'mittel' | 'fortgeschritten'
  name:          string
}

const DEFAULTS: AppSettings = {
  vdot:            47.9,
  maxHr:           190,
  restHr:          50,
  currentWeeklyKm: 50,
  runsPerWeek:     5,
  raceType1:       'hm',
  raceDate1:       '2026-10-11',
  raceType2:       'marathon',
  raceDate2:       '2027-04-25',
  preRaceEnabled:  true,
  experience:      'fortgeschritten',
  name:            '',
}

const KEY = 'coach_settings'

// T-182 Phase B: `preRaceEnabled` used to be an orphaned local toggle (saved, shown, never
// evaluated — B4 in T-182). It is now desktop-controlled: Streamlit writes it into the
// sync.json `settings` block (T-182 Phase A) whenever Event 1 (the prep race) is
// enabled/disabled. Resolution order: sync value wins when the block is present AND carries
// a boolean `preRaceEnabled` key; otherwise the local value applies unchanged — this keeps
// older sync.json snapshots (written before Phase A) from regressing the UI.
export function resolvePreRaceEnabled(
  localValue: boolean,
  syncSettings: Record<string, unknown> | null,
): boolean {
  if (syncSettings && typeof syncSettings['preRaceEnabled'] === 'boolean') {
    return syncSettings['preRaceEnabled']
  }
  return localValue
}

// T-182 Phase B review fix (Bug 1): `handleSave()` in Settings.tsx used to push the entire
// local `s` state as a full replacement for the sync `settings` block — a stale local
// preRaceEnabled could silently overwrite a fresh Desktop `false`. Desktop is the SSoT for
// preRaceEnabled (the checkbox is disabled/read-only in the UI); every OTHER settings key is
// still PWA-user-editable (raceDate1/raceDate2 render as enabled date pickers in Settings.tsx —
// only the preRaceEnabled checkbox is disabled) so those must come from the local edit, not get
// frozen to whatever the Desktop last wrote. Pure so the merge semantics are unit-testable
// without mounting Settings.tsx (this repo has no .tsx component tests — lib-level only).
export function mergeSettingsForPush(
  local: AppSettings,
  baseSettings: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  return {
    ...(baseSettings ?? {}),
    ...local,
    preRaceEnabled: resolvePreRaceEnabled(local.preRaceEnabled, baseSettings ?? null),
  }
}

// T-182 Phase B review fix (Bug 2): the App.tsx startup merge used to blindly spread
// `data.settings` (untyped JSON from sync.json) over the local AppSettings and cast the
// result — `raceDate1: null` (Event 1 disabled on the Desktop, T-182 Phase A) landed unchanged
// in the non-nullable `AppSettings.raceDate1: string` and got persisted to localStorage, which
// then fed `new Date(null)` = epoch in VdotPaces.tsx. Root-cause fix: strip null/undefined
// values from the remote object before merging, generically for ANY key — no AppSettings field
// is nullable by schema, so a `null` from the Desktop means "no opinion, keep the local value",
// never "erase it".
export function mergeRemoteSettings(
  local: AppSettings,
  remote: Record<string, unknown> | null | undefined,
): AppSettings {
  if (!remote) return local
  const cleaned = Object.fromEntries(
    Object.entries(remote).filter(([, v]) => v !== null && v !== undefined)
  )
  return { ...local, ...cleaned } as AppSettings
}

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return { ...DEFAULTS }
    return { ...DEFAULTS, ...JSON.parse(raw) }
  } catch {
    return { ...DEFAULTS }
  }
}

export function saveSettings(s: AppSettings): boolean {
  return safeSetItem(KEY, JSON.stringify(s))
}

export function updateSettings(partial: Partial<AppSettings>): AppSettings {
  const current = loadSettings()
  const next = { ...current, ...partial }
  saveSettings(next)
  return next
}

// T-158(b): True when the user has never saved custom settings (coach_settings absent).
// On a fresh install the app renders with DEFAULTS.vdot=47.9 — a personal value that
// suggests false precision. Call sites use this to show a "Standardwert" notice.
// Pure function: reads only localStorage, no side-effects.
export function isUsingDefaultSettings(): boolean {
  return localStorage.getItem(KEY) === null
}

// --- Training Notes ---

export interface ActivityNote {
  text: string
  rating: number  // 1–5
  savedAt: string // ISO timestamp
}

export function loadNote(activityId: number): ActivityNote | null {
  try {
    const raw = localStorage.getItem(`note_${activityId}`)
    if (!raw) return null
    return JSON.parse(raw) as ActivityNote
  } catch {
    return null
  }
}

// T-170: return value MUST be consumed by callers (RunDetail.tsx) — a `false` means the note
// was NOT persisted; showing a "gespeichert" confirmation regardless would silently lose data.
export function saveNote(activityId: number, text: string, rating: number): boolean {
  const note: ActivityNote = { text, rating, savedAt: new Date().toISOString() }
  return safeSetItem(`note_${activityId}`, JSON.stringify(note))
}

export function deleteNote(activityId: number): void {
  localStorage.removeItem(`note_${activityId}`)
}
