import { useState, useEffect } from 'react'
import type { AppSettings } from '../lib/storage'
import { saveSettings } from '../lib/storage'
import { vdotFromRace, buildPaceTable } from '../lib/vdot'
import {
  isAuthenticated, getAuthUrl, exchangeCode, clearTokens,
  syncActivities, loadTokens, getCachedActivities, REDIRECT_URI,
} from '../lib/strava'
import { getToken, setToken, clearToken, hasToken, fetchSync, pushSync } from '../lib/githubSync'

interface Props {
  settings: AppSettings
  onUpdate: (s: AppSettings) => void
}

export default function Settings({ settings, onUpdate }: Props) {
  const [s, setS] = useState(settings)
  const [saved, setSaved] = useState(false)

  // GitHub Sync state
  const [ghToken,    setGhToken]   = useState(getToken())
  const [ghSyncing,  setGhSyncing] = useState(false)
  const [ghMsg,      setGhMsg]     = useState<string | null>(null)
  const [ghErr,      setGhErr]     = useState<string | null>(null)
  const [_ghSha,     setGhSha]     = useState<string | null>(null)

  async function handleGhSync() {
    setGhSyncing(true); setGhErr(null); setGhMsg(null)
    try {
      const result = await fetchSync()
      if (result) {
        setGhSha(result.sha)
        setGhMsg(`Synced — zuletzt geändert: ${result.data.lastDevice ?? '?'} ${result.data.lastModified ? new Date(result.data.lastModified).toLocaleString('de-AT') : ''}`)
      } else {
        setGhMsg('Noch keine Sync-Daten vorhanden.')
      }
    } catch (e) { setGhErr(String(e)) }
    finally { setGhSyncing(false) }
  }

  function handleSaveToken() {
    setToken(ghToken)
    setGhMsg('Token gespeichert.')
    setTimeout(() => setGhMsg(null), 2000)
  }

  function handleClearToken() {
    clearToken()
    setGhToken('')
    setGhMsg(null)
  }

  // Strava state
  const [authed,    setAuthed]   = useState(isAuthenticated())
  const [syncing,   setSyncing]  = useState(false)
  const [syncMsg,   setSyncMsg]  = useState<string | null>(null)
  const [stravaErr, setStravaErr] = useState<string | null>(null)

  // Handle OAuth redirect — exchange code, then auto-sync
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const code = params.get('code')
    if (code && !authed) {
      exchangeCode(code)
        .then(async () => {
          setAuthed(true)
          window.history.replaceState({}, '', window.location.pathname)
          setSyncing(true)
          try {
            await syncActivities(52)
            setSyncMsg('Aktivitäten synchronisiert ✓')
            setTimeout(() => setSyncMsg(null), 4000)
          } catch (e) {
            setStravaErr(`Sync fehlgeschlagen: ${String(e)}`)
          } finally {
            setSyncing(false)
          }
        })
        .catch(e => {
          const msg = String(e)
          if (msg.includes('401'))
            setStravaErr('Verbindung fehlgeschlagen — Client-Credentials ungültig. GitHub Secrets prüfen.')
          else if (msg.includes('400'))
            setStravaErr('Verbindung fehlgeschlagen — Redirect URI stimmt nicht überein.')
          else
            setStravaErr(`Verbindung fehlgeschlagen: ${msg}`)
        })
    }
  }, [authed])

  function handleStravaConnect() {
    window.location.href = getAuthUrl()
  }

  function handleStravaDisconnect() {
    clearTokens()
    setAuthed(false)
    setSyncMsg(null)
  }

  async function handleStravaSync() {
    setSyncing(true)
    setStravaErr(null)
    try {
      const acts = await syncActivities(52)
      setSyncMsg(`${acts.length} Aktivitäten synchronisiert`)
      setTimeout(() => setSyncMsg(null), 3000)
    } catch (e) {
      setStravaErr(String(e))
    } finally {
      setSyncing(false)
    }
  }

  const tokens     = loadTokens()
  const athleteName = tokens?.athlete ? `${tokens.athlete.firstname} ${tokens.athlete.lastname}` : null
  const tokenExpiry = tokens?.expires_at
    ? new Date(tokens.expires_at * 1000).toLocaleString('de-AT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    : null
  const cachedCount = getCachedActivities().length

  function update<K extends keyof AppSettings>(key: K, val: AppSettings[K]) {
    setS(prev => ({ ...prev, [key]: val }))
    setSaved(false)
  }

  async function handleSave() {
    saveSettings(s)
    onUpdate(s)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
    if (hasToken()) {
      try {
        const current = await fetchSync()
        await pushSync(
          { settings: s as unknown as Record<string, unknown>, weekOverrides: current?.data.weekOverrides },
          current?.sha
        )
        setGhSha(null)
      } catch { /* sync failure is non-critical */ }
    }
  }

  // Quick VDOT from a recent race result
  const [raceDist, setRaceDist] = useState('21.1')
  const [raceTime, setRaceTime] = useState('')
  const [calcVdot, setCalcVdot] = useState<number | null>(null)

  function calcFromRace() {
    const distKm = parseFloat(raceDist)
    const parts = raceTime.split(':').map(Number)
    let timeSec = 0
    if (parts.length === 3) timeSec = parts[0] * 3600 + parts[1] * 60 + parts[2]
    else if (parts.length === 2) timeSec = parts[0] * 60 + parts[1]
    if (!distKm || !timeSec) return
    try {
      const v = vdotFromRace(distKm * 1000, timeSec)
      if (v > 20 && v < 85) setCalcVdot(Math.round(v * 10) / 10)
    } catch {}
  }

  function applyCalcVdot() {
    if (calcVdot) { update('vdot', calcVdot); setCalcVdot(null) }
  }

  const paces = buildPaceTable(s.vdot)

  return (
    <div className="tab-content">
      {/* Strava section at the top */}
      <div className="section-title">Strava</div>
      {!authed ? (
        <div className="settings-group">
          <p style={{ fontSize: '13px', color: 'var(--text2)', lineHeight: 1.5 }}>
            Verbinde Strava um Aktivitäten zu synchronisieren und Analysen zu sehen.
          </p>
          <button className="btn-strava" onClick={handleStravaConnect}>
            Mit Strava verbinden
          </button>
          <div style={{ fontSize: '11px', color: 'var(--text2)', marginTop: '8px', lineHeight: 1.6 }}>
            <div>Redirect URI: <code style={{ fontSize: '10px' }}>{REDIRECT_URI}</code></div>
            <div>Diese Domain muss in deiner <a href="https://www.strava.com/settings/api" target="_blank" rel="noreferrer" style={{ color: 'var(--accent)' }}>Strava API App</a> eingetragen sein.</div>
          </div>
          {stravaErr && <div className="error-box">{stravaErr}</div>}
        </div>
      ) : (
        <div className="settings-group">
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{ fontSize: '18px' }}>🟠</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 700, fontSize: '14px' }}>Strava verbunden</div>
              {athleteName && <div style={{ fontSize: '12px', color: 'var(--text2)' }}>{athleteName}</div>}
            </div>
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text2)', lineHeight: 1.8 }}>
            {cachedCount > 0 && <div>📦 {cachedCount} Aktivitäten im Cache</div>}
            {tokenExpiry && <div>🔑 Token gültig bis {tokenExpiry}</div>}
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              className="btn-primary"
              onClick={handleStravaSync}
              disabled={syncing}
              style={{ flex: 1 }}
            >
              {syncing ? '⏳ Synchronisiere…' : '🔄 Sync'}
            </button>
            <button className="btn-small btn-danger" onClick={handleStravaDisconnect}>
              Trennen
            </button>
          </div>
          {syncMsg  && <div style={{ fontSize: '12px', color: 'var(--green)' }}>{syncMsg}</div>}
          {stravaErr && <div className="error-box">{stravaErr}</div>}
        </div>
      )}

      {/* GitHub Sync section */}
      <div className="section-title">Geräte-Sync (GitHub)</div>
      <div className="settings-group">
        {!hasToken() ? (
          <>
            <p style={{ fontSize: '13px', color: 'var(--text2)', lineHeight: 1.5 }}>
              Einstellungen und Trainingstausche zwischen iPhone und Mac synchronisieren.
            </p>
            <label className="setting-label">
              GitHub Token
              <input
                type="password"
                className="setting-input"
                value={ghToken}
                placeholder="github_pat_..."
                onChange={e => setGhToken(e.target.value)}
              />
            </label>
            <button className="btn-primary" onClick={handleSaveToken} disabled={!ghToken}>
              Token speichern
            </button>
          </>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
              <span style={{ fontSize: '18px' }}>🔗</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, fontSize: '14px' }}>Sync aktiv</div>
                <div style={{ fontSize: '12px', color: 'var(--text2)' }}>Einstellungen & Trainingstausch werden automatisch gespeichert</div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button className="btn-primary" onClick={handleGhSync} disabled={ghSyncing} style={{ flex: 1 }}>
                {ghSyncing ? '⏳ Prüfe…' : '🔄 Status prüfen'}
              </button>
              <button className="btn-small btn-danger" onClick={handleClearToken}>Entfernen</button>
            </div>
          </>
        )}
        {ghMsg && <div style={{ fontSize: '12px', color: 'var(--green)' }}>{ghMsg}</div>}
        {ghErr && <div className="error-box">{ghErr}</div>}
      </div>

      <div className="section-title">Fitness</div>

      <div className="settings-group">
        <label className="setting-label">
          VDOT
          <div className="setting-row">
            <input
              type="number"
              className="setting-input"
              value={s.vdot}
              step="0.1"
              min="30"
              max="85"
              onChange={e => update('vdot', parseFloat(e.target.value))}
            />
            <span className="setting-hint">Easy: {paces.E_high}–{paces.E_low} /km</span>
          </div>
        </label>

        <label className="setting-label">
          Max. Herzfrequenz
          <input
            type="number"
            className="setting-input"
            value={s.maxHr}
            step="1"
            min="150"
            max="220"
            onChange={e => update('maxHr', parseInt(e.target.value))}
          />
        </label>

        <label className="setting-label">
          Ruhepuls
          <input
            type="number"
            className="setting-input"
            value={s.restHr}
            step="1"
            min="30"
            max="80"
            onChange={e => update('restHr', parseInt(e.target.value))}
          />
        </label>
      </div>

      {/* VDOT calculator */}
      <div className="section-title">VDOT aus Rennergebnis</div>
      <div className="vdot-calc">
        <div className="calc-row">
          <label className="setting-label">
            Distanz (km)
            <input
              type="number"
              className="setting-input small"
              value={raceDist}
              step="0.1"
              onChange={e => setRaceDist(e.target.value)}
            />
          </label>
          <label className="setting-label">
            Zeit (hh:mm:ss)
            <input
              type="text"
              className="setting-input small"
              value={raceTime}
              placeholder="1:29:45"
              onChange={e => setRaceTime(e.target.value)}
            />
          </label>
        </div>
        <button className="btn-secondary" onClick={calcFromRace}>Berechnen</button>
        {calcVdot && (
          <div className="calc-result">
            VDOT = <strong>{calcVdot}</strong>
            <button className="btn-small btn-primary" onClick={applyCalcVdot}>Übernehmen</button>
          </div>
        )}
      </div>

      <div className="section-title">Trainingsumfang</div>
      <div className="settings-group">
        <label className="setting-label">
          Aktuelle Wochenkm
          <input
            type="number"
            className="setting-input"
            value={s.currentWeeklyKm}
            step="5"
            min="20"
            max="150"
            onChange={e => update('currentWeeklyKm', parseFloat(e.target.value))}
          />
        </label>

        <label className="setting-label">
          Läufe pro Woche
          <select
            className="setting-input"
            value={s.runsPerWeek}
            onChange={e => update('runsPerWeek', parseInt(e.target.value))}
          >
            {[3, 4, 5, 6].map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>

        <label className="setting-label">
          Erfahrung
          <select
            className="setting-input"
            value={s.experience}
            onChange={e => update('experience', e.target.value as AppSettings['experience'])}
          >
            <option value="einsteiger">Einsteiger</option>
            <option value="mittel">Mittel</option>
            <option value="fortgeschritten">Fortgeschritten</option>
          </select>
        </label>
      </div>

      <div className="section-title">Renntermine</div>
      <div className="settings-group">
        <label className="setting-label">
          Rennen 1 — Typ
          <select
            className="setting-input"
            value={s.raceType1}
            onChange={e => update('raceType1', e.target.value as 'hm' | 'marathon')}
          >
            <option value="hm">Halbmarathon</option>
            <option value="marathon">Marathon</option>
          </select>
        </label>

        <label className="setting-label">
          Rennen 1 — Datum
          <input
            type="date"
            className="setting-input"
            value={s.raceDate1}
            onChange={e => update('raceDate1', e.target.value)}
          />
        </label>

        <label className="setting-label">
          Rennen 2 — Typ
          <select
            className="setting-input"
            value={s.raceType2}
            onChange={e => update('raceType2', e.target.value as 'hm' | 'marathon')}
          >
            <option value="marathon">Marathon</option>
            <option value="hm">Halbmarathon</option>
          </select>
        </label>

        <label className="setting-label">
          Rennen 2 — Datum
          <input
            type="date"
            className="setting-input"
            value={s.raceDate2}
            onChange={e => update('raceDate2', e.target.value)}
          />
        </label>

        <label className="setting-label toggle-label">
          <input
            type="checkbox"
            checked={s.preRaceEnabled}
            onChange={e => update('preRaceEnabled', e.target.checked)}
          />
          Rennen 1 als Vorbereitung für Rennen 2 (HM-Tapering)
        </label>
      </div>

      <button
        className={`btn-save ${saved ? 'saved' : ''}`}
        onClick={handleSave}
      >
        {saved ? '✅ Gespeichert' : 'Speichern'}
      </button>
    </div>
  )
}
