const OWNER = '6dwkt42m6p-ux'
const REPO   = 'marathon-pwa'
const PATH   = 'data/sync.json'
const API    = 'https://api.github.com'

// T-024: Plan serialized by Streamlit — PWA renders verbatim, never recomputes
export interface SyncedPlanSession {
  tag:      string   // "Mo", "Di", etc.
  typ:      string   // "Regeneration", "Qualität ⭐", etc.
  km:       number | null  // null for cross-training / rest
  vorgabe:  string
  struktur: string
  dauer:    string
  hinweis:  string
}

export interface SyncedPlanWeek {
  week_nr:    number
  week_start: string   // ISO date "YYYY-MM-DD"
  phase:      string
  planned_km: number
  is_current: boolean
  sessions:   SyncedPlanSession[]
}

export interface SyncedPlanPaces {
  E_low:  string   // "m:ss"
  E_high: string
  M:      string
  T:      string
  I:      string
  R:      string
}

export interface SyncedPlan {
  schemaVersion: number
  generatedAt:   string   // ISO datetime UTC
  generatedBy:   'streamlit'
  vdot:          number
  paces:         SyncedPlanPaces
  inputHash:     string
  weeks:         SyncedPlanWeek[]
  ftp?:          number | null   // T-125: FTP from Desktop coach_profile; null when not set
  threshold?:    import('./strava').SyncedThreshold | null   // T-138: threshold for rTSS/hrTSS
}

export interface SyncData {
  settings?:              Record<string, unknown>
  weekOverrides?:         Record<string, Record<string, string>>
  plan?:                  SyncedPlan    // T-024: set by Streamlit, read by PWA
  planRecomputeRequested?: boolean      // T-024: set by PWA when inputs change
  lastModified?:          string
  lastDevice?:            'pwa' | 'streamlit'
}

const TOKEN_KEY = 'github_sync_token'

export function getToken()          { return localStorage.getItem(TOKEN_KEY) ?? '' }
export function setToken(t: string) { localStorage.setItem(TOKEN_KEY, t) }
export function clearToken()        { localStorage.removeItem(TOKEN_KEY) }
export function hasToken()          { return !!localStorage.getItem(TOKEN_KEY) }

function headers() {
  return {
    'Authorization': `Bearer ${getToken()}`,
    'Accept': 'application/vnd.github.v3+json',
    'Content-Type': 'application/json',
  }
}

// Module-level cache for fetchSync — deduplicates parallel calls and avoids
// redundant GitHub API requests on tab switches within the TTL window.
const FETCH_TTL_MS = 60_000  // 60 s
let _fetchCache: { result: { data: SyncData; sha: string } | null; ts: number } | null = null
let _fetchInFlight: Promise<{ data: SyncData; sha: string } | null> | null = null

async function _doFetchSync(): Promise<{ data: SyncData; sha: string } | null> {
  const res = await fetch(`${API}/repos/${OWNER}/${REPO}/contents/${PATH}`, { headers: headers() })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`GitHub ${res.status}`)
  const j = await res.json()
  const data: SyncData = JSON.parse(atob(j.content.replace(/\n/g, '')))
  return { data, sha: j.sha }
}

export async function fetchSync(force = false): Promise<{ data: SyncData; sha: string } | null> {
  if (!hasToken()) return null

  // Bypass cache for explicit refresh actions (e.g. Settings sync button)
  if (!force) {
    if (_fetchCache && Date.now() - _fetchCache.ts < FETCH_TTL_MS) {
      return _fetchCache.result
    }
    // Share in-flight promise so concurrent callers get the same request
    if (_fetchInFlight) return _fetchInFlight
  }

  _fetchInFlight = _doFetchSync().then(result => {
    _fetchCache = { result, ts: Date.now() }
    _fetchInFlight = null
    return result
  }).catch(err => {
    _fetchInFlight = null
    throw err
  })

  return _fetchInFlight
}

export async function pushSync(data: SyncData, sha?: string, _retried = false): Promise<void> {
  if (!hasToken()) return
  const payload: SyncData = { ...data, lastModified: new Date().toISOString(), lastDevice: 'pwa' }
  const content = btoa(unescape(encodeURIComponent(JSON.stringify(payload, null, 2))))
  const body: Record<string, unknown> = {
    message: `sync: PWA update ${new Date().toLocaleString('de-AT')}`,
    content,
  }
  if (sha) body.sha = sha
  const res = await fetch(`${API}/repos/${OWNER}/${REPO}/contents/${PATH}`, {
    method: 'PUT', headers: headers(), body: JSON.stringify(body),
  })
  if (res.status === 409 && !_retried) {
    // Stale sha due to concurrent Streamlit write — fetch fresh sha and retry once.
    // If the refresh-fetch fails or returns null (no token / 404), throw a clear
    // error rather than silently proceeding with sha=undefined (last-write-wins
    // overwrite that could clobber a concurrent PWA write).
    const fresh = await fetchSync()
    if (!fresh) {
      throw new Error('Konflikt beim Speichern — frischer Stand nicht abrufbar. Bitte erneut versuchen.')
    }
    return pushSync(data, fresh.sha, true)
  }
  if (!res.ok) throw new Error(`GitHub push ${res.status}`)
}

// Load remote sync and merge into local state — returns merged data
export async function pullAndMerge(): Promise<{
  settings: Record<string, unknown> | null
  weekOverrides: Record<string, Record<string, string>>
  plan: SyncedPlan | null    // T-024: verbatim plan from Streamlit
  sha: string | null
}> {
  const result = await fetchSync()
  if (!result) return { settings: null, weekOverrides: {}, plan: null, sha: null }
  const { data, sha } = result
  const local = getLocalOverrides()
  // Merge week overrides: remote wins per week (last device wins)
  const merged = { ...local, ...(data.weekOverrides ?? {}) }
  return { settings: data.settings ?? null, weekOverrides: merged, plan: data.plan ?? null, sha }
}

// Read all local week overrides from localStorage
function getLocalOverrides(): Record<string, Record<string, string>> {
  const result: Record<string, Record<string, string>> = {}
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (key?.startsWith('week_override_')) {
      try {
        const weekKey = key.replace('week_override_', '')
        const raw = localStorage.getItem(key)!
        const arr: Array<{ originalDay: string; currentDay: string }> = JSON.parse(raw)
        const map: Record<string, string> = {}
        arr.forEach(a => { if (a.originalDay !== a.currentDay) map[a.originalDay] = a.currentDay })
        if (Object.keys(map).length > 0) result[weekKey] = map
      } catch { /* skip */ }
    }
  }
  return result
}
