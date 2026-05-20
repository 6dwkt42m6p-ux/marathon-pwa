// Pfitzinger-style periodized plan generator — ported from coach.py
import { trainingPaces, formatPace } from './vdot'

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

function mondayOf(d: Date): Date {
  const day = d.getDay()
  const diff = day === 0 ? -6 : 1 - day
  return addDays(d, diff)
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
  return weekWorkout(currentRow.phase, currentRow.plannedKm, vdot, runsPerWeek, raceType)
}

export function weekWorkout(phase: string, plannedKm: number, vdot: number, _runsPerWeek: number, raceType: 'hm' | 'marathon' = 'marathon'): WorkoutSession {
  const paces = trainingPaces(vdot)
  const eHi  = formatPace(paces.E_high)
  const eLo  = formatPace(paces.E_low)
  const tp   = formatPace(paces.T)
  const ip   = formatPace(paces.I)
  const rp   = formatPace(paces.R)

  const basePhase = phase.split(' ')[0]

  const longKm   = raceType === 'marathon'
    ? Math.max(Math.min(Math.round(plannedKm * 0.38), 35), 14)
    : Math.max(Math.min(Math.round(plannedKm * 0.34), 26), 12)
  const qualityKm = Math.max(Math.round(plannedKm * 0.16), 6)
  const easyKm   = Math.max(Math.round(plannedKm * 0.12), 8)

  const s = (session: string, typ: string, km: string | number, vorgabe: string, struktur: string, dauer: string, hinweis: string, tag = '—'): WorkoutSession =>
    ({ session, typ, distanzKm: km, vorgabe, struktur, dauerMin: dauer, hinweis, wochentag: tag })

  // Return the most important session for the week (Long run priority)
  if (basePhase === 'Basis') {
    return s('Langer DL (easy)', 'Ausdauer',
      longKm,
      `${eHi} – ${eLo} /km (Z2)`,
      `${longKm} km locker @ ${eHi}–${eLo} /km. Gespräch möglich. Keine Pace-Vorgabe erzwingen.`,
      `${Math.round(longKm * 5.5)}–${Math.round(longKm * 6.5)} min`,
      'Aerobe Basis aufbauen. HF Z2 hat absoluten Vorrang.',
      'So')
  }
  if (basePhase === 'Aufbau') {
    return s('Schwellenlauf (T)', 'Qualität ⭐',
      qualityKm,
      `2 km @ ${eHi} einlaufen → 3×10 min @ ${tp} /km (T-Pace)`,
      `2 km Einlaufen @ ${eHi} → 3×10 min @ ${tp} /km (T-Pace, Z4), Pause 90 Sek. Easy → 1 km Auslaufen`,
      `${Math.round(qualityKm * 4.8)}–${Math.round(qualityKm * 5.2)} min`,
      'T-Pace: kontrolliert schwer — nicht durchbeißen. Vollständige Pausen einhalten.',
      'Di')
  }
  if (basePhase === 'Peak') {
    return s('Intervalle (1000m)', 'Qualität ⭐⭐',
      qualityKm,
      `5×1000m @ ${ip} /km (I-Pace)`,
      `2 km Einlaufen @ ${eHi} → 5×1000m @ ${ip} /km (I-Pace, Z5), Pause: 400m Easy-Jogging → 1 km Auslaufen`,
      `${Math.round(qualityKm * 4.5)}–${Math.round(qualityKm * 5)} min`,
      'I-Pace: 95–100% VO2max. Nach 5 Intervallen stop — Qualität über Quantität.',
      'Di')
  }
  if (basePhase === 'Tapering') {
    return s('Easy + Strides', 'Easy',
      easyKm,
      `${eHi} /km + 6×100m Strides @ ${rp}`,
      `${easyKm} km locker @ ${eHi} /km → 6×100m Strides @ ${rp} /km, Pause: 45 Sek. → 1 km Auslaufen`,
      `${Math.round(easyKm * 5.5)}–${Math.round(easyKm * 6)} min`,
      'Strides halten Beinfrequenz frisch. Nicht sprinten — kontrolliertes Beschleunigen.',
      'Mi')
  }
  if (basePhase === 'HM-Tapering') {
    return s('Easy + 4×1 km I-Pace', 'Schärfung',
      qualityKm,
      `4×1 km @ ${ip} + 6×Strides`,
      `2 km Einlaufen @ ${eHi} → 4×1 km @ ${ip} /km, Pause: 400m Easy → 6×Strides → 1 km Auslaufen`,
      `45–55 min`,
      'Letzte Qualitätseinheit vor dem Rennen. Kontrolliert — Körper ist schon fit.',
      'Di')
  }
  if (basePhase === 'HM-Erholung') {
    return s('Regenerations-DL', 'Regeneration',
      easyKm,
      `${eHi}+ /km (Z1)`,
      `${easyKm} km sehr locker @ ${eHi}+ /km. Kein Pace-Druck.`,
      `${Math.round(easyKm * 6.5)}–${Math.round(easyKm * 7.5)} min`,
      'Erholung nach dem Rennen. Muskulatur braucht 10–14 Tage für vollständige Regeneration.',
      'Mo')
  }
  // Default / Halbmarathon race week
  return s('Easy-DL', 'Easy',
    easyKm,
    `${eHi} /km (Z1–Z2)`,
    `${easyKm} km sehr locker @ ${eHi}+ /km`,
    `${Math.round(easyKm * 6)}–${Math.round(easyKm * 7)} min`,
    'Leichte Einheit zur Aktivierung.',
    'Mo')
}
