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
