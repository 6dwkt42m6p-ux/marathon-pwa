// Jack Daniels VDOT methodology — ported from coach.py

export const ZONES = {
  E_low:  0.62,
  E_high: 0.74,
  M:      0.81,
  T:      0.88,
  I:      0.95,
  R:      1.05,
} as const

export type ZoneKey = keyof typeof ZONES

function vo2AtVelocity(v: number): number {
  return -4.60 + 0.182258 * v + 0.000104 * v * v
}

function velocityAtVo2(vo2: number): number {
  const a = 0.000104
  const b = 0.182258
  const c = vo2 + 4.60
  if (c <= 0) return 0
  const disc = b * b + 4 * a * c
  return (-b + Math.sqrt(disc)) / (2 * a)
}

function pctVo2max(tMin: number): number {
  return (
    0.8 +
    0.1894393 * Math.exp(-0.012778 * tMin) +
    0.2989558 * Math.exp(-0.1932605 * tMin)
  )
}

export function vdotFromRace(distanceM: number, timeSec: number): number {
  const tMin = timeSec / 60
  const v    = distanceM / tMin
  const vo2  = vo2AtVelocity(v)
  const pct  = pctVo2max(tMin)
  return vo2 / pct
}

export function trainingPaces(vdot: number): Record<ZoneKey, number> {
  const result = {} as Record<ZoneKey, number>
  for (const [zone, pct] of Object.entries(ZONES) as [ZoneKey, number][]) {
    const vo2 = vdot * pct
    const v   = velocityAtVo2(vo2)
    result[zone] = v > 0 ? (1000 / v) * 60 : NaN
  }
  return result
}

export function formatPace(secPerKm: number): string {
  if (!isFinite(secPerKm) || isNaN(secPerKm)) return '—'
  const total = Math.round(secPerKm)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

export function parsePaceToSec(paceStr: string): number | null {
  const match = paceStr.match(/^(\d+):(\d{2})$/)
  if (!match) return null
  return parseInt(match[1]) * 60 + parseInt(match[2])
}

export interface PaceTable {
  E_low:  string
  E_high: string
  M:      string
  T:      string
  I:      string
  R:      string
  I_400m:  string
  I_600m:  string
  I_800m:  string
  I_1000m: string
  I_1200m: string
}

export function buildPaceTable(vdot: number): PaceTable {
  const p = trainingPaces(vdot)
  const iSec = p.I
  return {
    E_low:   formatPace(p.E_low),
    E_high:  formatPace(p.E_high),
    M:       formatPace(p.M),
    T:       formatPace(p.T),
    I:       formatPace(p.I),
    R:       formatPace(p.R),
    I_400m:  formatPace(iSec * 0.40),
    I_600m:  formatPace(iSec * 0.60),
    I_800m:  formatPace(iSec * 0.80),
    I_1000m: formatPace(iSec),
    I_1200m: formatPace(iSec * 1.20),
  }
}

export function classifyRun(paceSec: number, vdot: number): { code: string; name: string; color: string } {
  const p = trainingPaces(vdot)
  if (paceSec < p.I * 1.02)        return { code: 'I/R', name: 'Intervall / Rep',   color: '#e53935' }
  if (paceSec < p.T * 1.02)        return { code: 'T',   name: 'Schwelle (T)',       color: '#FF9800' }
  if (paceSec < p.E_high * 0.99)   return { code: 'M',   name: 'Marathon-Pace (M)', color: '#FFC107' }
  if (paceSec < p.E_low * 1.06)    return { code: 'E',   name: 'Easy (E)',           color: '#4CAF50' }
  return { code: 'Z1', name: 'Regeneration (Z1)', color: '#42A5F5' }
}

export function feasibilityCheck(currentVdot: number, targetVdot: number, weeks: number) {
  const delta = targetVdot - currentVdot
  if (delta <= 0) return { rating: 'Bereits erreicht', emoji: '✅', color: '#28a745', delta, message: `Aktueller VDOT ${currentVdot.toFixed(1)} reicht bereits!` }
  const rate = delta / weeks
  if (rate < 0.12) return { rating: 'Realistisch',        emoji: '🟢', color: '#28a745', delta, message: `+${delta.toFixed(1)} VDOT in ${weeks} Wochen. Mit regelmäßigem Training gut erreichbar.` }
  if (rate < 0.20) return { rating: 'Ambitioniert',       emoji: '🟡', color: '#e6a817', delta, message: `+${delta.toFixed(1)} VDOT in ${weeks} Wochen. Machbar mit konsequentem Training.` }
  if (rate < 0.30) return { rating: 'Sehr ambitioniert',  emoji: '🟠', color: '#fd7e14', delta, message: `+${delta.toFixed(1)} VDOT in ${weeks} Wochen. Setzt verletzungsfreies Toptraining voraus.` }
  return { rating: 'Unrealistisch', emoji: '🔴', color: '#dc3545', delta, message: `+${delta.toFixed(1)} VDOT in ${weeks} Wochen. Physiologisch kaum erreichbar.` }
}

export const RACE_TARGETS: Record<string, { label: string; distM: number; targetSec: number }[]> = {
  hm: [
    { label: 'Sub 1:30', distM: 21097, targetSec: 89 * 60 + 59 },
    { label: 'Sub 1:35', distM: 21097, targetSec: 94 * 60 + 59 },
    { label: 'Sub 1:40', distM: 21097, targetSec: 99 * 60 + 59 },
  ],
  marathon: [
    { label: 'Sub 3:00', distM: 42195, targetSec: 179 * 60 + 59 },
    { label: 'Sub 3:15', distM: 42195, targetSec: 194 * 60 + 59 },
    { label: 'Sub 3:30', distM: 42195, targetSec: 209 * 60 + 59 },
  ],
}
