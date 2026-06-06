// Pfitzinger-style periodized plan generator — ported from coach.py
// T-024: Local generation is kept as fallback only when no synced plan exists.
//        All active rendering uses the verbatim synced plan from Streamlit.
import { trainingPaces, formatPace } from './vdot'
import { mondayOf, DAY_TAGS, type ActivitySummary, type WorkoutClassification } from './strava'
import type { SyncedPlan, SyncedPlanWeek, SyncedPlanSession } from './githubSync'

// Re-export synced plan types for convenience in components
export type { SyncedPlan, SyncedPlanWeek, SyncedPlanSession }

// Return the current week from a synced plan (is_current === true)
export function syncedCurrentWeek(plan: SyncedPlan): SyncedPlanWeek | null {
  return plan.weeks.find(w => w.is_current) ?? null
}

// Return the session for today's weekday tag from a synced plan week
export function syncedTodaySession(week: SyncedPlanWeek): SyncedPlanSession | null {
  const todayTag = DAY_TAGS[new Date().getDay()]
  return week.sessions.find(s => s.tag === todayTag) ?? null
}

// True when the local settings diverge from what the synced plan was generated with.
// Uses the vdot stored in the plan as a lightweight staleness signal.
// Full staleness is only known via planRecomputeRequested flag from GitHub sync.
export function isPlanStale(
  plan: SyncedPlan,
  localVdot: number,
  localRaceDate1: string,
  localRaceDate2: string,
  syncSettings: Record<string, unknown> | null,
): boolean {
  // VDOT mismatch
  if (Math.abs(plan.vdot - localVdot) > 0.1) return true
  // Race date mismatch via sync.json settings (written by Streamlit)
  if (syncSettings) {
    const e1 = syncSettings['event1'] as { date?: string } | undefined
    const e2 = syncSettings['event2'] as { date?: string } | undefined
    if (e1?.date && e1.date !== localRaceDate1) return true
    if (e2?.date && e2.date !== localRaceDate2) return true
  }
  return false
}

export interface PlanRow {
  weekNr:      number
  weekStart:   Date
  phase:       string
  plannedKm:   number
  workouts:    string
  isCurrent:   boolean
  isHMWeek?:   boolean
}

export interface WorkoutSession {
  session:    string
  typ:        string
  distanzKm:  string | number
  vorgabe:    string
  struktur:   string
  dauerMin:   string
  hinweis:    string
  wochentag:  string
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d)
  r.setDate(r.getDate() + n)
  return r
}

function diffWeeks(a: Date, b: Date): number {
  return Math.floor((b.getTime() - a.getTime()) / (7 * 24 * 3600 * 1000))
}

export function generatePlan(
  raceDate: Date,
  currentWeeklyKm: number,
  runsPerWeek = 5,
  raceType: 'hm' | 'marathon' = 'marathon',
  preRaceDate?: Date,
): PlanRow[] {
  const today     = mondayOf(new Date())
  const totalWeeks = Math.max(diffWeeks(today, raceDate), 6)

  let peakKm: number
  let taper: number
  let peak: number
  let effectiveKm = currentWeeklyKm

  if (raceType === 'marathon') {
    if (preRaceDate) {
      const hmPeakEst = Math.max(Math.min(Math.round(currentWeeklyKm * 1.60), 95), 65)
      effectiveKm = Math.max(currentWeeklyKm, Math.round(hmPeakEst * 0.80))
    }
    peakKm = Math.max(Math.min(Math.round(effectiveKm * 1.65), 115), 80)
    taper = 3; peak = 3
  } else {
    peakKm = Math.max(Math.min(Math.round(currentWeeklyKm * 1.60), 95), 65)
    taper = 2; peak = 2
  }

  const quality  = totalWeeks - taper - peak
  const base     = Math.max(Math.floor(quality / 2), 3)
  const build    = Math.max(quality - base, 2)
  const startR   = currentWeeklyKm / peakKm

  const WORKOUTS: Record<string, string[]> = {
    'Basis':    ['Langer DL (easy)', 'Mittellanger DL', 'Easy + Steigerungen', 'Easy-DL', 'Easy-DL'],
    'Aufbau':   ['Langer DL', 'Schwellenlauf (T)', 'Mittellanger DL', 'Intervalle (400–800m)', 'Easy-DL'],
    'Peak':     ['Langer DL m. MP', 'Intervalle (1000–1200m)', 'Schwellenlauf (T)', 'Mittellanger DL', 'Easy-DL'],
    'Tapering': ['Easy-DL', 'Schärfung (T/I)', 'Easy + Strides', 'Easy-DL', '—'],
  }

  let hmWeekIdx: number | null = null
  if (preRaceDate) {
    const preRaceMon = mondayOf(preRaceDate)
    const idx = diffWeeks(today, preRaceMon)
    if (idx >= 0 && idx < totalWeeks) hmWeekIdx = idx
  }

  function pctAndPhase(w: number): [string, number] {
    if (w < base) {
      const endR = Math.max(0.80, startR)
      const progress = w / Math.max(base - 1, 1)
      const p = startR + progress * (endR - startR)
      if ((w + 1) % 4 === 0) return [`Basis (Entlastung)`, Math.max(p * 0.80, startR * 0.75)]
      return ['Basis', p]
    }
    if (w < base + build) {
      const bi = w - base
      const aufbauStart = Math.max(0.80, startR)
      const p = aufbauStart + 0.15 * (bi / Math.max(build - 1, 1))
      if ((w + 1) % 4 === 0) return [`Aufbau (Entlastung)`, Math.max(p * 0.80, startR * 0.75)]
      return ['Aufbau', p]
    }
    if (w < base + build + peak) {
      const pi = w - base - build
      const p = 0.95 + 0.05 * (pi / Math.max(peak - 1, 1))
      return ['Peak', p]
    }
    const ti = w - (base + build + peak)
    return ['Tapering', [0.65, 0.45, 0.25][Math.min(ti, 2)]]
  }

  const rows: PlanRow[] = []
  for (let i = 0; i < totalWeeks; i++) {
    const [phase, pct] = pctAndPhase(i)
    let plannedKm = Math.round(peakKm * pct * 10) / 10
    const basePhase = phase.split(' ')[0]
    const wList = (WORKOUTS[basePhase] || WORKOUTS['Basis']).slice(0, runsPerWeek)
    const weekStart = addDays(today, i * 7)
    let workouts = wList.filter(w => w !== '—').join(', ')
    let finalPhase = phase

    if (hmWeekIdx !== null) {
      const delta = i - hmWeekIdx
      if (delta === -3) { finalPhase = 'HM-Tapering'; plannedKm = Math.round(plannedKm * 0.70 * 10) / 10; workouts = 'Easy-DL + kurzer Schwellenlauf (T)' }
      else if (delta === -2) { finalPhase = 'HM-Tapering'; plannedKm = Math.round(plannedKm * 0.55 * 10) / 10; workouts = 'Easy-DL + 3×10 min T-Pace + Strides' }
      else if (delta === -1) { finalPhase = 'HM-Tapering'; plannedKm = Math.round(plannedKm * 0.35 * 10) / 10; workouts = 'Easy-DL + 4×1 km I-Pace + 6×Strides' }
      else if (delta === 0)  { finalPhase = 'Halbmarathon 🏁'; plannedKm = Math.round((21.1 + Math.max(Math.round(peakKm * 0.14), 8)) * 10) / 10; workouts = 'Easy-DL + Einlaufen + HALBMARATHON' }
      else if (delta === 1)  { finalPhase = 'HM-Erholung'; plannedKm = Math.round(peakKm * 0.42 * 10) / 10; workouts = 'Regeneration — sehr leichte Easy-DL' }
      else if (delta === 2)  { finalPhase = 'HM-Erholung'; plannedKm = Math.round(peakKm * 0.63 * 10) / 10; workouts = 'Lockerer Aufbau — Easy-DL + Strides' }
    }

    rows.push({
      weekNr:    i + 1,
      weekStart,
      phase:     finalPhase,
      plannedKm,
      workouts,
      isCurrent: weekStart.getTime() === today.getTime(),
      isHMWeek:  hmWeekIdx !== null && i === hmWeekIdx,
    })
  }

  rows.push({
    weekNr:    totalWeeks + 1,
    weekStart: addDays(today, totalWeeks * 7),
    phase:     'Renntag 🏁',
    plannedKm: Math.round(peakKm * 0.15 * 10) / 10,
    workouts:  'Einlaufen + RENNEN',
    isCurrent: false,
  })

  return rows
}

export function todayWorkout(plan: PlanRow[], vdot: number, runsPerWeek = 5, raceType: 'hm' | 'marathon' = 'marathon'): WorkoutSession | null {
  const currentRow = plan.find(r => r.isCurrent)
  if (!currentRow) return null
  const sessions = allWeekSessions(currentRow.phase, currentRow.plannedKm, vdot, runsPerWeek, raceType)
  const todayTag = DAY_TAGS[new Date().getDay()]
  return sessions.find(s => s.wochentag === todayTag) ?? sessions[0] ?? null
}

export function allWeekSessions(phase: string, plannedKm: number, vdot: number, runsPerWeek: number, raceType: 'hm' | 'marathon' = 'marathon'): WorkoutSession[] {
  const paces = trainingPaces(vdot)
  const eHi  = formatPace(paces.E_high)
  const eLo  = formatPace(paces.E_low)
  const mp   = formatPace(paces.M)
  const tp   = formatPace(paces.T)
  const ip   = formatPace(paces.I)
  const rp   = formatPace(paces.R)

  const basePhase = phase.split(' ')[0]

  const longKm    = raceType === 'marathon'
    ? Math.max(Math.min(Math.round(plannedKm * 0.38), 35), 14)
    : Math.max(Math.min(Math.round(plannedKm * 0.34), 26), 12)
  const mediumKm  = raceType === 'marathon'
    ? Math.max(Math.round(plannedKm * 0.22), 10)
    : Math.max(Math.round(plannedKm * 0.20), 8)
  const qualityKm = Math.max(Math.round(plannedKm * 0.16), 6)
  const easyKm    = Math.max(Math.round(plannedKm * 0.12), 8)

  const s = (session: string, typ: string, km: string | number, vorgabe: string, struktur: string, dauer: string, hinweis: string, tag: string): WorkoutSession =>
    ({ session, typ, distanzKm: km, vorgabe, struktur, dauerMin: dauer, hinweis, wochentag: tag })

  let sessions: WorkoutSession[] = []

  if (basePhase === 'Basis') {
    sessions = [
      s('Easy-DL', 'Regeneration', easyKm,
        `${eHi}+ /km (Z1–Z2)`,
        `${easyKm} km sehr locker @ ${eHi}+ /km. Kein Pace-Druck.`,
        `${Math.round(easyKm * 6)}–${Math.round(easyKm * 7)} min`,
        'HF Z1–Z2. Wenn Beine schwer: Rad oder Pause.', 'Mo'),
      s('Easy m. Steigerungen (8×100m)', 'Speed',  easyKm,
        `${eHi} /km + 8×100m @ ${rp} /km`,
        `${easyKm} km @ ${eHi} /km → 8×100m Strides @ ${rp} /km (Pause: 45 Sek.) → 1 km Auslaufen`,
        `${Math.round(easyKm * 5.5)}–${Math.round(easyKm * 6)} min`,
        'Strides aktivieren Fast-Twitch-Fasern ohne Erschöpfung. Saubere Form, kein Sprint.', 'Di'),
      s('Mittellanger DL', 'Ausdauer', mediumKm,
        `${eHi} /km (Z2)`,
        `${mediumKm} km gleichmäßig @ ${eHi} /km. Zweite Hälfte darf etwas flotter sein.`,
        `${Math.round(mediumKm * 5.5)}–${Math.round(mediumKm * 6.5)} min`,
        'Kein Zeitdruck. Gespräch möglich = richtige Intensität.', 'Mi'),
      s('Easy-DL', 'Regeneration', easyKm,
        `${eHi}+ /km (Z1–Z2)`,
        `${easyKm} km locker @ ${eHi}+ /km.`,
        `${Math.round(easyKm * 6)}–${Math.round(easyKm * 7)} min`,
        'Aktive Erholung nach dem Mittellangen DL.', 'Do'),
      s('Langer DL (easy)', 'Ausdauer', longKm,
        `${eHi} – ${eLo} /km (Z2)`,
        `${longKm} km locker @ ${eHi}–${eLo} /km. Erste Hälfte unten, zweite etwas flotter.`,
        `${Math.round(longKm * 5.5)}–${Math.round(longKm * 6.5)} min`,
        'Aerobe Basis aufbauen. HF Z2 hat absoluten Vorrang. Gespräch muss möglich bleiben.', 'So'),
    ]
  } else if (basePhase === 'Aufbau') {
    sessions = [
      s('Easy-DL', 'Regeneration', easyKm,
        `${eHi}+ /km (Z1–Z2)`,
        `${easyKm} km sehr locker @ ${eHi}+ /km.`,
        `${Math.round(easyKm * 6)}–${Math.round(easyKm * 7)} min`,
        'Lockerer Start in die Woche — Beine frisch halten für Dienstag.', 'Mo'),
      s('Schwellenlauf (T)', 'Qualität ⭐', qualityKm,
        `3×10 min @ ${tp} /km (T-Pace)`,
        `2 km Einlaufen @ ${eHi} → 3×10 min @ ${tp} /km (T-Pace, Z4), Pause 90 Sek. Easy → 1 km Auslaufen`,
        `${Math.round(qualityKm * 4.8)}–${Math.round(qualityKm * 5.2)} min`,
        'T-Pace: kontrolliert schwer. Nicht durchbeißen — Pause vollständig einhalten.', 'Di'),
      s('Mittellanger DL', 'Ausdauer', mediumKm,
        `${eHi} /km (Z2)`,
        `${mediumKm} km @ ${eHi} /km, letzte 3 km progressiv bis ${mp} /km.`,
        `${Math.round(mediumKm * 5.5)}–${Math.round(mediumKm * 6)} min`,
        'Progression trainiert den Übergang von Easy zu Marathon-Pace.', 'Mi'),
      s('Easy-DL', 'Regeneration', easyKm,
        `${eHi}+ /km (Z1)`,
        `${easyKm} km locker @ ${eHi}+ /km. Kein Druck.`,
        `${Math.round(easyKm * 6)}–${Math.round(easyKm * 7)} min`,
        'Erholung nach Schwellenlauf. Lieber zu langsam als zu schnell.', 'Do'),
      s('Intervalle (400–800m)', 'Qualität ⭐', qualityKm,
        `6×400m @ ${rp} oder 4×800m @ ${ip} /km`,
        `2 km Einlaufen @ ${eHi} → 6×400m @ ${rp} /km (Pause: 200m Easy) oder 4×800m @ ${ip} /km (Pause: 400m Easy) → 1 km Auslaufen`,
        `${Math.round(qualityKm * 4.5)}–${Math.round(qualityKm * 5)} min`,
        '400m-Option: neuromuskuläre Schärfe. 800m-Option: VO2max-Reiz. Beide sind richtig.', 'Fr'),
      s('Langer DL', 'Ausdauer', longKm,
        `${eHi} – ${eLo} /km (Z2)`,
        `${longKm} km locker @ ${eHi}–${eLo} /km.`,
        `${Math.round(longKm * 5.5)}–${Math.round(longKm * 6.5)} min`,
        'Wichtigste Einheit der Woche. HF Z2. Nicht zu schnell starten.', 'So'),
    ]
  } else if (basePhase === 'Peak') {
    sessions = [
      s('Easy-DL', 'Regeneration', easyKm,
        `${eHi}+ /km (Z1–Z2)`,
        `${easyKm} km locker @ ${eHi}+ /km.`,
        `${Math.round(easyKm * 6)}–${Math.round(easyKm * 7)} min`,
        'Aktive Erholung. Beine für Dienstag frisch halten.', 'Mo'),
      s('Intervalle (1000–1200m)', 'Qualität ⭐⭐', qualityKm,
        `5×1000m @ ${ip} /km (I-Pace)`,
        `2 km Einlaufen @ ${eHi} → 5×1000m @ ${ip} /km (I-Pace, Z5), Pause: 400m Easy-Jogging → 1 km Auslaufen`,
        `${Math.round(qualityKm * 4.5)}–${Math.round(qualityKm * 5)} min`,
        'I-Pace: 95–100% VO2max. 5 Intervalle — Qualität über Quantität. Abbrechkriterium: Pace bricht ein.', 'Di'),
      s('Mittellanger DL', 'Ausdauer', mediumKm,
        `${eHi} /km (Z2)`,
        `${mediumKm} km @ ${eHi} /km. Letzte 4 km @ ${mp} /km (Marathon-Pace).`,
        `${Math.round(mediumKm * 5.5)}–${Math.round(mediumKm * 6)} min`,
        'Marathon-Pace am Ende des DL = Renntempo bei Ermüdung. Sehr wertvoller Reiz.', 'Mi'),
      s('Easy-DL', 'Regeneration', easyKm,
        `${eHi}+ /km (Z1)`,
        `${easyKm} km sehr locker @ ${eHi}+ /km.`,
        `${Math.round(easyKm * 6)}–${Math.round(easyKm * 7)} min`,
        'Nach hartem Dienstag: vollständige Erholung. Nicht zu schnell.', 'Do'),
      s('Schwellenlauf (T)', 'Qualität ⭐', qualityKm,
        `4×8 min @ ${tp} /km (T-Pace)`,
        `2 km Einlaufen @ ${eHi} → 4×8 min @ ${tp} /km (T-Pace), Pause 60 Sek. → 1 km Auslaufen`,
        `${Math.round(qualityKm * 4.8)}–${Math.round(qualityKm * 5.2)} min`,
        'Zweite Qualitätseinheit der Woche. Weniger Volumen als Dienstag — Fokus auf Pace-Qualität.', 'Fr'),
      s('Langer DL m. MP', 'Ausdauer ⭐⭐', longKm,
        `${eHi} /km + letzte 8–10 km @ ${mp} /km`,
        `${Math.round(longKm * 0.65)} km @ ${eHi}–${eLo} /km → letzte ${Math.round(longKm * 0.35)} km @ ${mp} /km (Marathon-Pace, Z3)`,
        `${Math.round(longKm * 5.5)}–${Math.round(longKm * 6.5)} min`,
        'Herzstück der Peak-Phase. M-Pace-Abschnitt bei Ermüdung simuliert Renntempo in der zweiten Marathonhälfte.', 'So'),
    ]
  } else if (basePhase === 'Tapering') {
    sessions = [
      s('Easy-DL', 'Easy', easyKm,
        `${eHi} /km (Z1–Z2)`,
        `${easyKm} km locker @ ${eHi} /km.`,
        `${Math.round(easyKm * 6)}–${Math.round(easyKm * 7)} min`,
        'Tapering: Intensität runter, Frequenz bleibt. Körper tankt auf.', 'Mo'),
      s('Schärfung (T/I)', 'Qualität ⭐', qualityKm,
        `2×10 min @ ${tp} /km + 4×100m Strides`,
        `2 km Einlaufen → 2×10 min @ ${tp} /km (T-Pace), Pause 90 Sek. → 4×100m Strides @ ${rp} → 1 km Auslaufen`,
        `35–45 min`,
        'Letzte Qualitätseinheit. Hält die Laufökonomie scharf ohne neue Ermüdung zu erzeugen.', 'Di'),
      s('Easy + Strides', 'Easy', easyKm,
        `${eHi} /km + 6×100m Strides @ ${rp}`,
        `${easyKm} km locker @ ${eHi} /km → 6×100m Strides @ ${rp} /km (Pause: 45 Sek.) → 1 km Auslaufen`,
        `${Math.round(easyKm * 5.5)}–${Math.round(easyKm * 6)} min`,
        'Strides halten Beinfrequenz frisch ohne zu belasten.', 'Mi'),
      s('Easy-DL', 'Easy', easyKm,
        `${eHi}+ /km (Z1)`,
        `${easyKm} km sehr locker @ ${eHi}+ /km.`,
        `${Math.round(easyKm * 6)}–${Math.round(easyKm * 7)} min`,
        'Aktive Erholung. Kein Pace-Druck.', 'Do'),
      s('Einlaufen + Strides', 'Easy', Math.round(easyKm * 0.7),
        `${eHi} /km + 4×100m Strides`,
        `${Math.round(easyKm * 0.7)} km locker → 4×100m Strides → Auslaufen. Kurz und frisch.`,
        `20–30 min`,
        'Tag vor dem Rennen: kurz, locker, Beine aktivieren. Nicht mehr machen als das.', 'Sa'),
    ]
  } else if (basePhase === 'HM-Tapering') {
    sessions = [
      s('Easy-DL', 'Easy', easyKm,
        `${eHi} /km (Z1–Z2)`,
        `${easyKm} km locker @ ${eHi} /km.`,
        `${Math.round(easyKm * 6)}–${Math.round(easyKm * 7)} min`,
        'Letzte Taper-Woche. Körper ist fit — nur noch frisch halten.', 'Mo'),
      s('Easy + 4×1 km I-Pace', 'Schärfung', qualityKm,
        `4×1 km @ ${ip} /km + 6×Strides`,
        `2 km Einlaufen @ ${eHi} → 4×1 km @ ${ip} /km (Pause: 400m Easy) → 6×100m Strides → 1 km Auslaufen`,
        `45–55 min`,
        'Letzte Qualitätseinheit vor dem Rennen. Kontrolliert laufen — Körper braucht keinen neuen Reiz mehr.', 'Di'),
      s('Easy + Strides', 'Easy', easyKm,
        `${eHi} /km + 4×100m Strides`,
        `${easyKm} km locker → 4×100m Strides → Auslaufen.`,
        `30–40 min`,
        'Beine scharf halten ohne zu belasten.', 'Mi'),
      s('Einlaufen + Strides', 'Easy', Math.round(easyKm * 0.6),
        `${eHi} /km + 4×Strides`,
        `${Math.round(easyKm * 0.6)} km sehr locker → 4×100m Strides → fertig.`,
        `20–25 min`,
        'Tag vor dem Rennen: kurz, locker. Nicht mehr machen als das.', 'Sa'),
    ]
  } else if (basePhase === 'HM-Erholung') {
    sessions = [
      s('Regenerations-DL', 'Regeneration', easyKm,
        `${eHi}+ /km (Z1)`,
        `${easyKm} km sehr locker @ ${eHi}+ /km. Kein Druck.`,
        `${Math.round(easyKm * 6.5)}–${Math.round(easyKm * 7.5)} min`,
        'Erholung nach Halbmarathon. Muskulatur braucht 10–14 Tage. Nicht forcieren.', 'Mo'),
      s('Easy-DL', 'Easy', easyKm,
        `${eHi}+ /km (Z1–Z2)`,
        `${easyKm} km locker @ ${eHi}+ /km.`,
        `${Math.round(easyKm * 6)}–${Math.round(easyKm * 7)} min`,
        'Zweite leichte Einheit. Wenn Beine noch schwer: Rad oder Pause.', 'Mi'),
      s('Easy + Strides', 'Easy', easyKm,
        `${eHi} /km + 4×100m Strides`,
        `${easyKm} km @ ${eHi} /km → 4×100m Strides → Auslaufen.`,
        `${Math.round(easyKm * 5.5)}–${Math.round(easyKm * 6)} min`,
        'Erste leichte Intensität nach Rennen — nur wenn Beine sich gut anfühlen.', 'Fr'),
    ]
  } else {
    // Race week / default
    sessions = [
      s('Einlaufen', 'Easy', easyKm,
        `${eHi} /km (Z1–Z2)`,
        `${easyKm} km sehr locker @ ${eHi}+ /km.`,
        `${Math.round(easyKm * 6)}–${Math.round(easyKm * 7)} min`,
        'Letzte Einheit vor dem Rennen. Locker und kurz.', 'Mo'),
    ]
  }

  return sessions.slice(0, runsPerWeek)
}

// ── Plan-Abweichungserkennung (T-014) ────────────────────────────────────────

export interface PlanDeviation {
  plannedLabel: string       // e.g. "Ruhetag", "Easy-DL", "Intervalle (400–800m)"
  actualType:   string       // from WorkoutClassification.workoutType or zoneCode
  actualKm:     number
  kmDelta:      number       // actual − planned (0 when rest day planned)
  coachComment: string
  badge:        'plangemäß' | 'mehr' | 'weniger' | 'ruhetag' | 'frei'
  badgeColor:   string
}

// Maps WorkoutSession.typ to broad intensity categories for comparison
function sessionIntensityLevel(typ: string): 'easy' | 'quality' | 'long' {
  const t = typ.toLowerCase()
  if (t.includes('qualität') || t.includes('speed') || t.includes('schärfung')) return 'quality'
  if (t.includes('ausdauer')) return 'long'
  return 'easy'
}

function classificationIntensityLevel(wt: WorkoutClassification['workoutType']): 'easy' | 'quality' {
  return (wt === 'strides' || wt === 'intervals' || wt === 'tempo' || wt === 'mixed') ? 'quality' : 'easy'
}

export function assessDeviation(
  plannedSession: WorkoutSession | null,  // null = rest day
  actual: ActivitySummary,
  classification: WorkoutClassification | null,
  tsb: number,
): PlanDeviation {
  const actualKm    = actual.distanceKm
  const tsbContext  = tsb > -10 ? 'im grünen Bereich' : 'bereits im Minus'
  const actualLabel = classification
    ? classification.workoutType.charAt(0).toUpperCase() + classification.workoutType.slice(1)
    : actual.actType === 'run' ? 'Lauf' : actual.actType === 'ride' ? 'Radfahrt' : 'Wanderung'

  // No plan for this day
  if (!plannedSession) {
    return {
      plannedLabel: 'Kein Plantag',
      actualType:   actualLabel,
      actualKm,
      kmDelta:      0,
      coachComment: 'Kein Plantag — freies Training.',
      badge:        'frei',
      badgeColor:   '#9C27B0',
    }
  }

  const plannedLabel = plannedSession.session
  const plannedKm    = typeof plannedSession.distanzKm === 'number'
    ? plannedSession.distanzKm
    : parseFloat(String(plannedSession.distanzKm)) || 0

  const plannedIntensity = sessionIntensityLevel(plannedSession.typ)
  const actualIntensity  = classification ? classificationIntensityLevel(classification.workoutType) : 'easy'

  // Rest day (no planned session typ that indicates running) → we use null session for rest
  // At this point we have a planned session, so check if it's a quality mismatch
  const kmDelta   = plannedKm > 0 ? Math.round((actualKm - plannedKm) * 10) / 10 : actualKm
  const pct       = plannedKm > 0 ? actualKm / plannedKm : Infinity

  let coachComment: string
  let badge: PlanDeviation['badge']
  let badgeColor: string

  if (plannedIntensity === 'easy' && actualIntensity === 'quality') {
    // Easy or long planned but higher intensity done
    coachComment = 'Intensiver als geplant — stelle sicher dass der nächste Long Run trotzdem klappt.'
    badge = 'mehr'
    badgeColor = '#FF9800'
  } else if (pct > 1.20) {
    // >20% more km than planned
    coachComment = `Deutlich mehr Volumen als geplant — gönn dir in den nächsten 48h extra Erholung.`
    badge = 'mehr'
    badgeColor = '#FF9800'
  } else if (pct < 0.70) {
    // <70% of planned km (i.e. <-30%)
    coachComment = 'Weniger als geplant — kein Nachholen empfohlen, einfach weiter im Rhythmus.'
    badge = 'weniger'
    badgeColor = '#42A5F5'
  } else {
    // Typ + km within ±20%
    coachComment = 'Plangemäß trainiert. ✓'
    badge = 'plangemäß'
    badgeColor = '#4CAF50'
  }

  // TSB context appended for intensity-mismatch case
  if (badge === 'mehr' && plannedIntensity === 'easy' && actualIntensity === 'quality') {
    coachComment += ` TSB aktuell ${tsbContext}.`
  }

  return {
    plannedLabel,
    actualType: actualLabel,
    actualKm,
    kmDelta: Math.round(kmDelta * 10) / 10,
    coachComment,
    badge,
    badgeColor,
  }
}

// Returns true when the given date falls within a plan week (rest day is meaningful)
export function hasPlanRowForDate(plan: PlanRow[], date: Date): boolean {
  const monday = mondayOf(date)
  return plan.some(r => {
    const ws = new Date(r.weekStart)
    ws.setHours(0, 0, 0, 0)
    return ws.getTime() === monday.getTime()
  })
}

// assessDeviationForRestDay: used when the plan shows a rest day and the user trained anyway
export function assessDeviationForRestDay(
  actual: ActivitySummary,
  tsb: number,
): PlanDeviation {
  const tsbContext  = tsb > -10 ? 'im grünen Bereich' : 'bereits im Minus'
  const actualLabel = actual.actType === 'run' ? 'Lauf' : actual.actType === 'ride' ? 'Radfahrt' : 'Wanderung'
  return {
    plannedLabel: 'Ruhetag',
    actualType:   actualLabel,
    actualKm:     actual.distanceKm,
    kmDelta:      actual.distanceKm,
    coachComment: `Training statt Ruhetag — TSB aktuell ${tsbContext}, beobachte die Erholung.`,
    badge:        'ruhetag',
    badgeColor:   '#FFC107',
  }
}
