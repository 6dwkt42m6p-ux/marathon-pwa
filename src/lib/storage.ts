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
