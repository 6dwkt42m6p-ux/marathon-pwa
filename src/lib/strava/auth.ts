// Inhalt: Strava-OAuth2 und Token-Verwaltung.
// Zweck: Login-URL mit state (CSRF), Callback-Pruefung, Token-Speicher, Refresh ueber den
//   Worker-Proxy (Secret nie im Bundle), Trennen inkl. Cache-Loeschung.
// Einstieg: getAuthUrl, parseOAuthCallback, exchangeCode, getValidToken, clearTokens,
//   isAuthenticated, loadTokens/saveTokens, REDIRECT_URI, STRAVA_REAUTH_KEY.
// Regeln: importiert storage.ts, ./cache, ./types; nie ./api oder ./bulk (zyklenfrei).
import { safeSetItem } from '../storage'
import { ACTS_KEY, evictAllStreamLapsCaches } from './cache'
import type { StravaTokens } from './types'

const CLIENT_ID     = import.meta.env.VITE_STRAVA_CLIENT_ID || ''
// Token exchange/refresh go through the server-side proxy — secret never enters the client bundle.
const TOKEN_PROXY   = import.meta.env.VITE_STRAVA_TOKEN_PROXY || ''
// Use env var if set explicitly, otherwise derive from current origin + Vite BASE_URL
// This works for both localhost dev and GitHub Pages (/marathon-pwa/) without any secrets config
export const REDIRECT_URI  = import.meta.env.VITE_STRAVA_REDIRECT_URI ||
  (window.location.origin + import.meta.env.BASE_URL)
const TOKEN_KEY          = 'strava_tokens'

const OAUTH_STATE_KEY = 'strava_oauth_state'
// T-259 P-08: gesetzt, wenn Strava den Refresh-Token ablehnt (widerrufen) — Settings zeigt "neu verbinden".
export const STRAVA_REAUTH_KEY = 'strava_reauth_needed'

function _newOAuthState(): string {
  try {
    const b = new Uint8Array(16)
    crypto.getRandomValues(b)
    return Array.from(b, x => x.toString(16).padStart(2, '0')).join('')
  } catch { return `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}` }
}

export function getAuthUrl(): string {
  // T-259 P-09: state gegen Login-CSRF. sessionStorage (tab-gebunden) + localStorage-Fallback,
  // falls iOS den Redirect in einem anderen Browsing-Kontext zurückbringt.
  const state = _newOAuthState()
  try { sessionStorage.setItem(OAUTH_STATE_KEY, state) } catch {}
  try { localStorage.setItem(OAUTH_STATE_KEY, state) } catch {}
  const params = new URLSearchParams({
    state,
    client_id:       CLIENT_ID,
    redirect_uri:    REDIRECT_URI,
    response_type:   'code',
    approval_prompt: 'auto',
    scope:           'read,activity:read_all',
  })
  return `https://www.strava.com/oauth/authorize?${params}`
}

export type OAuthCallback = { code: string } | { error: string }

// Wertet die Redirect-Query aus. null = kein OAuth-Callback. Verbraucht den gespeicherten state
// (Einmalnutzung). Fehlender/abweichender state -> Fehler statt Token-Exchange.
export function parseOAuthCallback(search: string): OAuthCallback | null {
  const params = new URLSearchParams(search)
  const code = params.get('code')
  const oauthErr = params.get('error')
  if (!code && !oauthErr) return null
  let expected: string | null = null
  try { expected = sessionStorage.getItem(OAUTH_STATE_KEY) } catch {}
  if (!expected) { try { expected = localStorage.getItem(OAUTH_STATE_KEY) } catch {} }
  try { sessionStorage.removeItem(OAUTH_STATE_KEY) } catch {}
  try { localStorage.removeItem(OAUTH_STATE_KEY) } catch {}
  if (oauthErr) return { error: `Strava-Autorisierung abgebrochen (${oauthErr}).` }
  if (!expected || params.get('state') !== expected)
    return { error: 'Login-Sitzung ungültig oder abgelaufen (state-Prüfung) — bitte erneut mit Strava verbinden.' }
  return { code: code as string }
}

export function loadTokens(): StravaTokens | null {
  try {
    const raw = localStorage.getItem(TOKEN_KEY)
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

// T-170: "schlimmster Fall" aus dem Ticket — ein stiller Quota-Fehler hier persistiert das
// OAuth-Token nicht, der User ist ausgeloggt ohne jedes Signal. Rückgabewert MUSS ausgewertet
// werden (siehe refreshTokens/exchangeCode unten).
export function saveTokens(t: StravaTokens): boolean {
  const ok = safeSetItem(TOKEN_KEY, JSON.stringify(t))
  if (ok) { try { localStorage.removeItem(STRAVA_REAUTH_KEY) } catch {} }
  return ok
}

// Trennen: Strava-Daten verlassen das Gerät (Strava-Agreement: Löschung bei Deauth) —
// Token, Aktivitätsliste, Stream/Laps-Caches und der Workbox-Cache 'strava-api'.
export function clearTokens(): void {
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(ACTS_KEY)
  localStorage.removeItem(STRAVA_REAUTH_KEY)
  evictAllStreamLapsCaches()
  if (typeof caches !== 'undefined' && caches) {
    try { void caches.delete('strava-api').catch(() => {}) } catch {}
  }
}
export function isAuthenticated(): boolean {
  return loadTokens() !== null
}

async function refreshTokens(refreshToken: string): Promise<StravaTokens> {
  if (!TOKEN_PROXY) throw new Error('VITE_STRAVA_TOKEN_PROXY not configured')
  const r = await fetch(`${TOKEN_PROXY}/strava/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // Worker appends client_id + client_secret server-side
    body: JSON.stringify({ refresh_token: refreshToken }),
  })
  if (!r.ok) {
    const err = new Error(`Token refresh failed: ${r.status}`) as Error & { status?: number }
    err.status = r.status
    throw err
  }
  const tokens = await r.json()
  if (!saveTokens(tokens)) {
    // getValidToken()'s caller already treats any refreshTokens() rejection as "not
    // authenticated" (existing behaviour) — the storage_quota marker lets a future caller
    // distinguish this from a real auth failure if needed, without changing today's fallback.
    throw new Error('storage_quota: Token-Refresh erfolgreich, aber Speicher voll — Token nicht gespeichert.')
  }
  return tokens
}

export async function getValidToken(): Promise<string | null> {
  let tokens = loadTokens()
  if (!tokens) return null
  if (tokens.expires_at < Date.now() / 1000 + 300) {
    const usedRefresh = tokens.refresh_token
    try { tokens = await refreshTokens(usedRefresh) }
    catch (e) {
      // T-259 P-08: nur 400/401 vom Refresh = Token widerrufen/ungültig -> löschen + Reconnect-Hinweis.
      // Netzfehler, 5xx, Quota: Tokens bleiben (sonst Zwangs-Logout bei kurzem Offline).
      const status = (e as { status?: number }).status
      // Race: hat ein paralleler Refresh bereits neue Tokens gespeichert, nicht löschen.
      if ((status === 400 || status === 401) && loadTokens()?.refresh_token === usedRefresh) {
        localStorage.removeItem(TOKEN_KEY)
        try { localStorage.setItem(STRAVA_REAUTH_KEY, '1') } catch {}
      }
      return null
    }
  }
  return tokens.access_token
}

export async function exchangeCode(code: string): Promise<StravaTokens> {
  if (!TOKEN_PROXY) throw new Error('VITE_STRAVA_TOKEN_PROXY not configured')
  const r = await fetch(`${TOKEN_PROXY}/strava/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // Worker appends client_id + client_secret server-side
    body: JSON.stringify({ code, redirect_uri: REDIRECT_URI }),
  })
  if (!r.ok) throw new Error(`Auth failed: ${r.status} ${await r.text()}`)
  const tokens = await r.json()
  if (!saveTokens(tokens)) {
    // Login succeeded server-side, but the token could not be persisted — without this throw
    // the caller would show "connected" while isAuthenticated() lies false on next read.
    // Settings.tsx's exchangeCode().catch() branch surfaces the "storage_quota" marker.
    throw new Error('storage_quota: Login erfolgreich, aber Speicher voll — Token konnte nicht gespeichert werden.')
  }
  return tokens
}
