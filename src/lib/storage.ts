// Persistent user settings via localStorage

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

export function saveSettings(s: AppSettings): void {
  localStorage.setItem(KEY, JSON.stringify(s))
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

export function saveNote(activityId: number, text: string, rating: number): void {
  const note: ActivityNote = { text, rating, savedAt: new Date().toISOString() }
  localStorage.setItem(`note_${activityId}`, JSON.stringify(note))
}

export function deleteNote(activityId: number): void {
  localStorage.removeItem(`note_${activityId}`)
}
