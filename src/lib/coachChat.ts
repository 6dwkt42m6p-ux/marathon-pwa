// Coach Chat — worker proxy call and localStorage history

import type { AppSettings } from './storage'
import { safeSetItem } from './storage'
import type { StravaActivity } from './strava'
import { trainingPaces, formatPace } from './vdot'

// localStorage key for persisted chat history
export const COACH_HISTORY_KEY = 'coach_chat_history'

export interface ChatMessage {
  role: 'user' | 'assistant'
  content: string
}

// Keep only the last N messages in history to bound localStorage size
const HISTORY_LIMIT = 10

export function loadChatHistory(): ChatMessage[] {
  try {
    const raw = localStorage.getItem(COACH_HISTORY_KEY)
    if (!raw) return []
    return JSON.parse(raw) as ChatMessage[]
  } catch {
    return []
  }
}

// T-170: safeSetItem never throws and sets STORAGE_WARNING_KEY on unhealable quota failure —
// minimum bucket per ticket (Chat history is not critical enough for dedicated UI; the
// App-level storage banner from T-163 already signals the user).
export function saveChatHistory(messages: ChatMessage[]): void {
  // Persist only the last HISTORY_LIMIT messages
  const trimmed = messages.slice(-HISTORY_LIMIT)
  safeSetItem(COACH_HISTORY_KEY, JSON.stringify(trimmed))
}

export function clearChatHistory(): void {
  try {
    localStorage.removeItem(COACH_HISTORY_KEY)
  } catch {}
}

// --- System prompt derived from Streamlit coach context ----------------------
// No wörtlicher system prompt in coach.py (Streamlit uses rule-based comments, no LLM).
// Prompt constructed from the project's coaching philosophy and data schema.

export function buildSystemPrompt(settings: AppSettings, recentActivities: StravaActivity[]): string {
  const rawPaces = trainingPaces(settings.vdot)

  const hmDate  = new Date(settings.raceDate1)
  const marDate = new Date(settings.raceDate2)
  const now     = new Date()
  const hmWeeks  = Math.max(0, Math.floor((hmDate.getTime()  - now.getTime()) / (7 * 24 * 3600 * 1000)))
  const marWeeks = Math.max(0, Math.floor((marDate.getTime() - now.getTime()) / (7 * 24 * 3600 * 1000)))

  const actSummary = recentActivities.slice(0, 5).map(a => {
    const km = (a.distance / 1000).toFixed(1)
    const pace = a.distance > 0
      ? Math.round(a.moving_time / (a.distance / 1000))
      : 0
    const paceStr = pace > 0 ? `${Math.floor(pace / 60)}:${String(pace % 60).padStart(2, '0')}/km` : '—'
    const hr = a.average_heartrate ? ` HF ${Math.round(a.average_heartrate)} bpm` : ''
    const date = new Date(a.start_date_local).toLocaleDateString('de-AT', { day: '2-digit', month: '2-digit' })
    return `  - ${date}: ${a.name} | ${km} km @ ${paceStr}${hr}`
  }).join('\n')

  return `Du bist ein erfahrener Laufcoach (Trainingsplan-System Marathon Coach). \
Du coachst einen Ausdauerläufer auf dem Weg zu zwei Wettkämpfen.

Athleten-Profil:
- VDOT: ${settings.vdot.toFixed(1)}
- Erfahrung: ${settings.experience}
- Wöchentliche Basis: ${settings.currentWeeklyKm} km, ${settings.runsPerWeek} Einheiten/Woche
- Max-HF: ${settings.maxHr} bpm, Ruhe-HF: ${settings.restHr} bpm
- Ziel 1: ${settings.raceType1 === 'hm' ? 'Halbmarathon' : 'Marathon'} am ${settings.raceDate1} (in ${hmWeeks} Wochen)
- Ziel 2: ${settings.raceType2 === 'marathon' ? 'Marathon' : 'Halbmarathon'} am ${settings.raceDate2} (in ${marWeeks} Wochen)

Aktuelle Trainingspaces (Jack Daniels):
- Easy: ${formatPace(rawPaces.E_low)} – ${formatPace(rawPaces.E_high)} /km
- Marathon-Pace (M): ${formatPace(rawPaces.M)} /km
- Schwelle (T): ${formatPace(rawPaces.T)} /km
- Intervall (I): ${formatPace(rawPaces.I)} /km
- Repetition (R): ${formatPace(rawPaces.R)} /km

Letzte 5 Aktivitäten (Strava):
${actSummary || '  (keine Aktivitäten vorhanden)'}

Coaching-Philosophie (Jack Daniels 80/20-Prinzip):
- 80% Easy-Tempo, 20% Qualitätsarbeit (Schwelle, Intervall, MP-Läufe)
- Für Marathon-Spezifik: progressive MP-Segmente in Longrun, Durability wichtiger als VO2max-Spitze
- Stagnations-Signal: steigende Easy-HF bei gleicher Pace = Überbelastung

Antworte auf Deutsch, präzise und praxisorientiert. Gib konkrete Empfehlungen mit Pace-Angaben. \
Frag nach mehr Kontext wenn nötig, bevor du eine Einheit detailliert planst. \
Keine Überschwenglichkeit — direkte Coach-Sprache.`
}

// --- Worker proxy call -------------------------------------------------------

export async function sendChatMessage(
  messages: ChatMessage[],
  systemPrompt: string,
): Promise<string> {
  const proxyBase = import.meta.env.VITE_STRAVA_TOKEN_PROXY
  if (!proxyBase) throw new Error('VITE_STRAVA_TOKEN_PROXY not configured')

  const r = await fetch(`${proxyBase}/claude`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      system: systemPrompt,
      messages,
    }),
  })

  if (!r.ok) {
    const err: Record<string, unknown> = await r.json().catch(() => ({}))
    throw new Error(err['error'] as string ?? `HTTP ${r.status}`)
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const data: any = await r.json()
  // Anthropic Messages API response shape: { content: [{ type: 'text', text: '...' }] }
  const text: string | undefined = data?.content?.[0]?.text
  if (!text) throw new Error('Leere Antwort vom Coach')
  return text
}
