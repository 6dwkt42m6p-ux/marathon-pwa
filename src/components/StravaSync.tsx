import { useState, useEffect } from 'react'
import {
  isAuthenticated, getAuthUrl, exchangeCode, clearTokens,
  syncActivities, getCachedActivities, parseRuns, loadTokens,
  type RunSummary,
} from '../lib/strava'
import { vdotFromRace } from '../lib/vdot'

interface Props {
  onVdotUpdate?: (vdot: number) => void
}

export default function StravaSync({ onVdotUpdate }: Props) {
  const [authed, setAuthed]       = useState(isAuthenticated())
  const [syncing, setSyncing]     = useState(false)
  const [runs, setRuns]           = useState<RunSummary[]>([])
  const [error, setError]         = useState<string | null>(null)
  const [lastSync, setLastSync]   = useState<string | null>(null)
  const [bestVdot, setBestVdot]   = useState<{ vdot: number; name: string; distKm: number; pace: string } | null>(null)
  const [online, setOnline]       = useState(navigator.onLine)

  useEffect(() => {
    const up = () => setOnline(true)
    const dn = () => setOnline(false)
    window.addEventListener('online', up)
    window.addEventListener('offline', dn)
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', dn) }
  }, [])

  // Handle OAuth redirect — exchange code, then auto-sync activities
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const code = params.get('code')
    if (code && !authed) {
      exchangeCode(code)
        .then(async () => {
          setAuthed(true)
          window.history.replaceState({}, '', window.location.pathname)
          // Auto-sync on first login so data appears immediately
          setSyncing(true)
          try {
            const acts = await syncActivities(52)
            const parsed = parseRuns(acts)
            setRuns(parsed)
            computeBestVdot(parsed)
            setLastSync(new Date().toLocaleTimeString('de-AT'))
          } catch (e) {
            setError(String(e))
          } finally {
            setSyncing(false)
          }
        })
        .catch(e => setError(String(e)))
    }
  }, [authed])

  // Load cached runs on mount
  useEffect(() => {
    const cached = getCachedActivities()
    if (cached.length) {
      const parsed = parseRuns(cached)
      setRuns(parsed)
      computeBestVdot(parsed)
    }
  }, [])

  function computeBestVdot(runList: RunSummary[]) {
    const now = new Date()
    const cutoff = new Date(now.getTime() - 12 * 7 * 24 * 3600 * 1000)
    let best: typeof bestVdot = null
    for (const r of runList) {
      if (r.distanceKm < 3 || r.date < cutoff || r.durationSec <= 0) continue
      try {
        const v = vdotFromRace(r.distanceKm * 1000, r.durationSec)
        if (v > 20 && v < 85 && (!best || v > best.vdot)) {
          best = { vdot: Math.round(v * 10) / 10, name: r.name, distKm: r.distanceKm, pace: r.paceFmt }
        }
      } catch {}
    }
    setBestVdot(best)
    if (best && onVdotUpdate) onVdotUpdate(best.vdot)
  }

  async function handleSync() {
    if (!online) { setError('Kein Internet — Sync nicht möglich.'); return }
    setSyncing(true)
    setError(null)
    try {
      const acts = await syncActivities(52)
      const parsed = parseRuns(acts)
      setRuns(parsed)
      computeBestVdot(parsed)
      setLastSync(new Date().toLocaleTimeString('de-AT'))
    } catch (e) {
      setError(String(e))
    } finally {
      setSyncing(false)
    }
  }

  function handleLogout() {
    clearTokens()
    setAuthed(false)
    setRuns([])
    setBestVdot(null)
  }

  const tokens = loadTokens()
  const athleteName = tokens?.athlete ? `${tokens.athlete.firstname} ${tokens.athlete.lastname}` : null

  return (
    <div className="tab-content">
      {/* Connection status */}
      <div className={`online-badge ${online ? 'online' : 'offline'}`}>
        <div className="online-dot" />
        {online ? 'Online' : 'Offline — Sync nicht möglich'}
      </div>

      {!authed ? (
        <div className="strava-connect">
          <div className="strava-logo">🟠</div>
          <h3>Strava verbinden</h3>
          <p>Verbinde dein Strava-Konto um Aktivitäten zu synchronisieren und deinen VDOT automatisch zu berechnen.</p>
          <p className="strava-note">
            Nur im WLAN oder mit Mobilfunk möglich. Nach erstem Sync sind alle Daten offline verfügbar.
          </p>
          <button
            className="btn-strava"
            onClick={() => { window.location.href = getAuthUrl() }}
            disabled={!online}
          >
            Mit Strava verbinden
          </button>
        </div>
      ) : (
        <div>
          <div className="strava-header">
            <div>
              <span className="strava-icon">🟠</span>
              <span className="strava-connected">Strava verbunden</span>
              {athleteName && <span className="strava-name"> · {athleteName}</span>}
            </div>
            <button className="btn-small btn-danger" onClick={handleLogout}>Trennen</button>
          </div>

          {bestVdot && (
            <div className="vdot-card">
              <div className="vdot-card-header">
                <span className="vdot-icon">📊</span>
                <span>Bester VDOT (12 Wochen)</span>
              </div>
              <div className="vdot-big">{bestVdot.vdot}</div>
              <div className="vdot-source">
                {bestVdot.name} · {bestVdot.distKm} km · {bestVdot.pace} /km
              </div>
              {onVdotUpdate && (
                <button className="btn-small btn-primary" onClick={() => onVdotUpdate(bestVdot.vdot)}>
                  Als VDOT übernehmen
                </button>
              )}
            </div>
          )}

          <div className="sync-row">
            <button
              className="btn-primary"
              onClick={handleSync}
              disabled={syncing || !online}
            >
              {syncing ? '⏳ Synchronisiere…' : '🔄 Aktivitäten sync'}
            </button>
            {lastSync && <span className="last-sync">Zuletzt: {lastSync}</span>}
          </div>

          {error && <div className="error-box">{error}</div>}

          {/* Recent runs */}
          {runs.length > 0 && (
            <div>
              <div className="section-title">Letzte Läufe ({runs.length} gesamt)</div>
              <div className="runs-list">
                {runs.slice(0, 20).map(r => (
                  <div key={r.id} className="run-item">
                    <div className="run-date">
                      {r.date.toLocaleDateString('de-AT', { day: '2-digit', month: 'short' })}
                    </div>
                    <div className="run-info">
                      <span className="run-name">{r.name}</span>
                      <span className="run-stats">
                        {r.distanceKm} km · {r.paceFmt} /km
                        {r.avgHr ? ` · ♡ ${Math.round(r.avgHr)}` : ''}
                      </span>
                    </div>
                    <div className="run-km">{r.distanceKm}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
