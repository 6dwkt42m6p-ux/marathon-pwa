import { useState, useEffect } from 'react'
import type { AppSettings } from '../lib/storage'
import { saveSettings } from '../lib/storage'
import { vdotFromRace, buildPaceTable } from '../lib/vdot'
import {
  isAuthenticated, getAuthUrl, exchangeCode, clearTokens,
  syncActivities, loadTokens, getCachedActivities, REDIRECT_URI,
  loadLastSyncTimestamp, localISODate,
} from '../lib/strava'
import { getToken, setToken, clearToken, hasToken, fetchSync, pushSync, type SyncData } from '../lib/githubSync'
import {
  activeInjuryBreak, effectiveWindow, buildStartMutation, buildEndMutation,
  loadPendingMutation, savePendingMutation, clearPendingMutation,
  resolvePendingMutation,
  type RawInjuryBreak, type InjuryBreakMutation, type InjurySeverity,
} from '../lib/injury'
import {
  loadPendingNoteMutations,
  removePendingNoteMutations,
  resolvePendingNoteMutation,
  type NoteMutation,
} from '../lib/notesSync'

interface Props {
  settings: AppSettings
  onUpdate: (s: AppSettings) => void
}

export default function Settings({ settings, onUpdate }: Props) {
  const [s, setS] = useState(settings)
  const [saved, setSaved] = useState(false)
  // T-170: saveSettings() can fail on quota-exhaustion — confirmation must reflect the real
  // saved state, not the live widget values (project rule: "Confirmation messages read from
  // saved state, not live widget variables").
  const [settingsSaveErr, setSettingsSaveErr] = useState<string | null>(null)

  // GitHub Sync state
  const [ghToken,    setGhToken]   = useState(getToken())
  const [ghSyncing,  setGhSyncing] = useState(false)
  const [ghMsg,      setGhMsg]     = useState<string | null>(null)
  const [ghErr,      setGhErr]     = useState<string | null>(null)
  const [_ghSha,     setGhSha]     = useState<string | null>(null)

  // T-132: Verletzungspausen — synced state + pending optimistic overlay
  const [injuryBreaks,  setInjuryBreaks]  = useState<RawInjuryBreak[]>([])
  const [injuryPending, setInjuryPending] = useState<InjuryBreakMutation | null>(loadPendingMutation)
  const [injStart,    setInjStart]    = useState(localISODate(new Date()))
  const [injDays,     setInjDays]     = useState(9)
  const [injSeverity, setInjSeverity] = useState<InjurySeverity>('minor')
  const [injNote,     setInjNote]     = useState('')
  const [injBusy,     setInjBusy]     = useState(false)
  const [injErr,      setInjErr]      = useState<string | null>(null)
  const [injMsg,      setInjMsg]      = useState<string | null>(null)

  useEffect(() => {
    if (!hasToken()) return
    let mounted = true
    fetchSync().then(result => {
      if (!mounted || !result) return
      const breaks = (result.data.plan?.injury_breaks ?? []) as RawInjuryBreak[]
      setInjuryBreaks(breaks)
      const pending = loadPendingMutation()
      if (pending) {
        const resolution = resolvePendingMutation(pending, breaks, result.data)
        if (resolution === 'applied') {
          clearPendingMutation()
          setInjuryPending(null)
        } else if (resolution === 'discarded') {
          clearPendingMutation()
          setInjuryPending(null)
          setInjMsg('Eingabe vom Desktop verworfen (Pause existierte bereits).')
        }
      }
    }).catch(() => { /* best-effort, same pattern as App.tsx startup sync */ })
    return () => { mounted = false }
  }, [])

  async function handleStartInjuryBreak() {
    setInjBusy(true); setInjErr(null)
    try {
      const fresh = await fetchSync(true)
      const mutation = buildStartMutation(injStart, injDays, injSeverity, injNote)
      // rebuildFn closes the 409 RMW race: on conflict, re-append OWN mutation to the
      // freshly fetched queue instead of pushing the stale pre-fetch snapshot.
      const buildPayload = (base: SyncData): SyncData => ({
        ...base,
        injuryBreakMutations: [...(base.injuryBreakMutations ?? []), mutation],
      })
      await pushSync(buildPayload(fresh?.data ?? {}), fresh?.sha, buildPayload)
      savePendingMutation(mutation)
      setInjuryPending(mutation)
      setInjNote('')
    } catch (e) {
      setInjErr(String(e))
    } finally {
      setInjBusy(false)
    }
  }

  async function handleEndInjuryBreak(breakId: string) {
    setInjBusy(true); setInjErr(null)
    try {
      const fresh = await fetchSync(true)
      const mutation = buildEndMutation(breakId, localISODate(new Date()))
      // rebuildFn closes the 409 RMW race: same pattern as handleStartInjuryBreak.
      const buildPayload = (base: SyncData): SyncData => ({
        ...base,
        injuryBreakMutations: [...(base.injuryBreakMutations ?? []), mutation],
      })
      await pushSync(buildPayload(fresh?.data ?? {}), fresh?.sha, buildPayload)
      savePendingMutation(mutation)
      setInjuryPending(mutation)
    } catch (e) {
      setInjErr(String(e))
    } finally {
      setInjBusy(false)
    }
  }

  async function handleGhSync() {
    setGhSyncing(true); setGhErr(null); setGhMsg(null)
    try {
      const result = await fetchSync(true)  // force: bypass TTL cache on explicit refresh
      if (result) {
        setGhSha(result.sha)
        setGhMsg(`Synced — zuletzt geändert: ${result.data.lastDevice ?? '?'} ${result.data.lastModified ? new Date(result.data.lastModified).toLocaleString('de-AT') : ''}`)
        // T-152: resolve any pending mutation against fresh sync data so a manual
        // sync clears the overlay without requiring an app restart.
        const pending = loadPendingMutation()
        if (pending) {
          const breaks = (result.data.plan?.injury_breaks ?? []) as RawInjuryBreak[]
          const resolution = resolvePendingMutation(pending, breaks, result.data)
          if (resolution === 'applied') {
            clearPendingMutation()
            setInjuryPending(null)
            setInjuryBreaks(breaks)
          } else if (resolution === 'discarded') {
            clearPendingMutation()
            setInjuryPending(null)
            setInjuryBreaks(breaks)
            setInjMsg('Eingabe vom Desktop verworfen (Pause existierte bereits).')
          }
        }
        // T-156: resolve and re-push pending note mutations on manual sync.
        const notePending = loadPendingNoteMutations()
        if (notePending.length > 0) {
          const syncInfo = { noteMutations: result.data.noteMutations, notes: result.data.plan?.notes }
          const appliedTs = notePending
            .filter((m: NoteMutation) => resolvePendingNoteMutation(m, syncInfo) === 'applied')
            .map((m: NoteMutation) => m.ts)
          if (appliedTs.length > 0) removePendingNoteMutations(appliedTs)
          const stillPending = loadPendingNoteMutations()
          if (stillPending.length > 0) {
            const buildPayload = (base: SyncData): SyncData => {
              const existingTs = new Set((base.noteMutations ?? []).map((m: NoteMutation) => m.ts))
              const toAdd = stillPending.filter((m: NoteMutation) => !existingTs.has(m.ts))
              return { ...base, noteMutations: [...(base.noteMutations ?? []), ...toAdd] }
            }
            pushSync(buildPayload(result.data), result.sha, buildPayload).catch(() => { /* best-effort */ })
          }
        }
      } else {
        setGhMsg('Noch keine Sync-Daten vorhanden.')
      }
    } catch (e) { setGhErr(String(e)) }
    finally { setGhSyncing(false) }
  }

  function handleSaveToken() {
    // T-170: setToken can fail on quota-exhaustion — don't claim success it didn't achieve.
    if (setToken(ghToken)) {
      setGhErr(null)
      setGhMsg('Token gespeichert.')
      setTimeout(() => setGhMsg(null), 2000)
    } else {
      setGhErr('Speicher voll — Token konnte nicht gespeichert werden.')
    }
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
  const [lastSyncTime, setLastSyncTime] = useState<Date | null>(loadLastSyncTimestamp)
  const [online,    setOnline]   = useState(navigator.onLine)

  useEffect(() => {
    const up = () => setOnline(true)
    const dn = () => setOnline(false)
    window.addEventListener('online', up)
    window.addEventListener('offline', dn)
    return () => { window.removeEventListener('online', up); window.removeEventListener('offline', dn) }
  }, [])

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
            setLastSyncTime(new Date())
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
          // T-170: exchangeCode() throws this specific marker when the login succeeded but
          // the OAuth token could not be persisted (quota) — the "schlimmster Fall" from the
          // ticket (silent logout). Distinct message so the user knows to free up storage,
          // not retry the connection.
          if (msg.includes('storage_quota'))
            setStravaErr('Login erfolgreich, aber der Speicher ist voll — die Verbindung wurde NICHT gespeichert. Bitte Speicher leeren und erneut verbinden.')
          else if (msg.includes('401'))
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
    if (!online) { setStravaErr('Kein Internet — Sync nicht möglich.'); return }
    setSyncing(true)
    setStravaErr(null)
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Timeout — Verbindung prüfen und erneut versuchen')), 30_000)
    )
    try {
      const acts = await Promise.race([syncActivities(52), timeout])
      setLastSyncTime(new Date())
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

  function formatLastSync(d: Date): string {
    const now   = new Date()
    const today = now.toDateString() === d.toDateString()
    const yesterday = new Date(now.getTime() - 86400 * 1000).toDateString() === d.toDateString()
    const time = d.toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' })
    if (today)     return `heute ${time}`
    if (yesterday) return `gestern ${time}`
    return d.toLocaleString('de-AT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
  }

  function update<K extends keyof AppSettings>(key: K, val: AppSettings[K]) {
    setS(prev => ({ ...prev, [key]: val }))
    setSaved(false)
  }

  async function handleSave() {
    if (!saveSettings(s)) {
      setSettingsSaveErr('Speicher voll — Einstellungen konnten nicht gespeichert werden.')
      return
    }
    setSettingsSaveErr(null)
    onUpdate(s)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
    if (hasToken()) {
      try {
        const current = await fetchSync(true)  // force: need fresh sha before push
        // rebuildFn: spread fresh remote state, then overwrite only the settings field.
        // Preserves plan, injuryBreakMutations etc. from any concurrent Desktop write.
        const buildPayload = (base: SyncData): SyncData => ({
          ...base,
          settings: s as unknown as Record<string, unknown>,
        })
        await pushSync(buildPayload(current?.data ?? {}), current?.sha, buildPayload)
        setGhSha(null)
      } catch { /* sync failure is non-critical */ }
    }
  }

  // Quick VDOT from a recent race result
  const [raceDist,  setRaceDist]  = useState('21.1')
  const [raceTime,  setRaceTime]  = useState('')
  const [raceName,  setRaceName]  = useState('')
  const [calcVdot,  setCalcVdot]  = useState<number | null>(null)
  const [raceErr,   setRaceErr]   = useState<string | null>(null)
  const [vdotApplied, setVdotApplied] = useState<{ from: number; to: number } | null>(null)

  function parseRaceTimeSec(raw: string): number {
    const parts = raw.trim().split(':').map(Number)
    if (parts.some(isNaN)) return 0
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
    if (parts.length === 2) return parts[0] * 60 + parts[1]
    return 0
  }

  function calcFromRace() {
    setRaceErr(null)
    setCalcVdot(null)
    const distKm = parseFloat(raceDist)
    if (isNaN(distKm) || distKm < 1 || distKm > 100) {
      setRaceErr('Distanz muss zwischen 1 km und 100 km liegen.')
      return
    }
    const timeSec = parseRaceTimeSec(raceTime)
    if (!timeSec || timeSec < 120 || timeSec > 43200) {
      setRaceErr('Zeit muss zwischen 2 Minuten (0:02:00) und 12 Stunden (12:00:00) liegen.')
      return
    }
    try {
      const v = vdotFromRace(distKm * 1000, timeSec)
      if (v > 20 && v < 85) setCalcVdot(Math.round(v * 10) / 10)
      else setRaceErr('Berechneter VDOT außerhalb des gültigen Bereichs (20–85).')
    } catch { setRaceErr('Berechnung fehlgeschlagen — Eingaben prüfen.') }
  }

  function applyCalcVdot() {
    if (!calcVdot) return
    const prev = s.vdot
    const updated = { ...s, vdot: calcVdot }
    setS(updated)
    if (!saveSettings(updated)) {
      // T-170: "Übernahmebuttons" pattern (pwa_patterns.md) — a dedicated action button must
      // not claim success on a failed persist.
      setRaceErr('Speicher voll — VDOT konnte nicht übernommen werden.')
      return
    }
    onUpdate(updated)
    setVdotApplied({ from: prev, to: calcVdot })
    setCalcVdot(null)
    setTimeout(() => setVdotApplied(null), 3000)
  }

  function raceResultLabel(): string {
    const distKm = parseFloat(raceDist)
    const timeSec = parseRaceTimeSec(raceTime)
    const h = Math.floor(timeSec / 3600)
    const m = Math.floor((timeSec % 3600) / 60)
    const sec = timeSec % 60
    const timeFormatted = `${h ? h + ':' : ''}${String(m).padStart(h ? 2 : 1, '0')}:${String(sec).padStart(2, '0')}`
    const distLabel = distKm === 21.1 ? 'HM' : distKm === 42.195 ? 'Marathon' : `${distKm} km`
    const prefix = raceName.trim() || distLabel
    return `${prefix} ${timeFormatted}`
  }

  const paces = buildPaceTable(s.vdot)

  return (
    <div className="tab-content">
      {/* Strava section at the top */}
      <div className="section-title">Strava</div>
      {!authed ? (
        <div className="settings-group">
          <p style={{ fontSize: '13px', color: 'var(--text-2)', lineHeight: 1.5 }}>
            Verbinde Strava um Aktivitäten zu synchronisieren und Analysen zu sehen.
          </p>
          <button className="btn-strava" onClick={handleStravaConnect}>
            Mit Strava verbinden
          </button>
          <div style={{ fontSize: '11px', color: 'var(--text-2)', marginTop: '8px', lineHeight: 1.6 }}>
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
              {athleteName && <div style={{ fontSize: '12px', color: 'var(--text-2)' }}>{athleteName}</div>}
            </div>
          </div>
          <div style={{ fontSize: '12px', color: 'var(--text-2)', lineHeight: 1.8 }}>
            {cachedCount > 0 && <div>📦 {cachedCount} Aktivitäten im Cache</div>}
            {tokenExpiry && <div>🔑 Token gültig bis {tokenExpiry}</div>}
            {lastSyncTime && <div>🔄 Zuletzt gesynct: {formatLastSync(lastSyncTime)}</div>}
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              className="btn-primary"
              onClick={handleStravaSync}
              disabled={syncing || !online}
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
            <p style={{ fontSize: '13px', color: 'var(--text-2)', lineHeight: 1.5 }}>
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
                <div style={{ fontSize: '12px', color: 'var(--text-2)' }}>Einstellungen & Trainingstausch werden automatisch gespeichert</div>
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

      {/* T-132: Verletzungspause */}
      <div className="section-title">🩹 Verletzungspause</div>
      <div className="settings-group">
        {(() => {
          const active = activeInjuryBreak(injuryBreaks, new Date())
          if (active) {
            const { end } = effectiveWindow(active)
            return (
              <>
                <p style={{ fontSize: '13px', color: 'var(--text-2)', lineHeight: 1.5 }}>
                  Aktive Pause seit <strong>{active.start}</strong> ({active.severity}, vsl. bis {localISODate(end)}).
                  {active.note && ` ${active.note}`}
                </p>
                <button
                  className="btn-primary"
                  onClick={() => handleEndInjuryBreak(active.id)}
                  disabled={injBusy || !hasToken()}
                >
                  {injBusy ? '⏳ Speichere…' : '✅ Wieder fit (Pause beenden)'}
                </button>
              </>
            )
          }
          return (
            <>
              <label className="setting-label">
                Start
                <input
                  type="date"
                  className="setting-input"
                  value={injStart}
                  onChange={e => setInjStart(e.target.value)}
                />
              </label>
              <label className="setting-label">
                Geschätzte Tage
                <input
                  type="number"
                  className="setting-input"
                  value={injDays}
                  min="1"
                  max="180"
                  onChange={e => setInjDays(parseInt(e.target.value) || 1)}
                />
              </label>
              <label className="setting-label">
                Schwere
                <select
                  className="setting-input"
                  value={injSeverity}
                  onChange={e => setInjSeverity(e.target.value as InjurySeverity)}
                >
                  <option value="minor">Minor</option>
                  <option value="moderate">Moderate</option>
                  <option value="major">Major</option>
                </select>
              </label>
              <label className="setting-label">
                Notiz (optional)
                <input
                  type="text"
                  className="setting-input"
                  value={injNote}
                  onChange={e => setInjNote(e.target.value)}
                />
              </label>
              <button
                className="btn-primary"
                onClick={handleStartInjuryBreak}
                disabled={injBusy || !hasToken()}
              >
                {injBusy ? '⏳ Speichere…' : '🩹 Pause eintragen'}
              </button>
              {!hasToken() && (
                <p style={{ fontSize: '12px', color: 'var(--text-2)' }}>
                  Geräte-Sync-Token oben eintragen, um Pausen vom Handy einzutragen.
                </p>
              )}
            </>
          )
        })()}
        {injuryPending && (
          <div style={{ fontSize: '12px', color: 'var(--text-2)' }}>
            ⏳ Wartet auf Desktop-Sync
          </div>
        )}
        {injMsg && <div style={{ fontSize: '12px', color: 'var(--green)' }}>{injMsg}</div>}
        {injErr && <div className="error-box">{injErr}</div>}
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
        <label className="setting-label">
          Rennen (optional)
          <input
            type="text"
            className="setting-input"
            value={raceName}
            placeholder="z.B. HM Wien"
            onChange={e => { setRaceName(e.target.value); setRaceErr(null); setCalcVdot(null) }}
          />
        </label>
        <div className="calc-row">
          <label className="setting-label">
            Distanz (km)
            <input
              type="number"
              className="setting-input small"
              value={raceDist}
              step="0.1"
              min="1"
              max="100"
              onChange={e => { setRaceDist(e.target.value); setRaceErr(null); setCalcVdot(null) }}
            />
          </label>
          <label className="setting-label">
            Zeit (hh:mm:ss)
            <input
              type="text"
              className="setting-input small"
              value={raceTime}
              placeholder="1:29:45"
              onChange={e => { setRaceTime(e.target.value); setRaceErr(null); setCalcVdot(null) }}
            />
          </label>
        </div>
        <button className="btn-secondary" onClick={calcFromRace}>Berechnen</button>
        {raceErr && <div className="error-box">{raceErr}</div>}
        {calcVdot && (
          <div className="calc-result">
            <span>{raceResultLabel()} → VDOT <strong>{calcVdot}</strong> (vorher: {s.vdot})</span>
            <button className="btn-small btn-primary" onClick={applyCalcVdot}>Übernehmen</button>
          </div>
        )}
        {vdotApplied && (
          <div style={{ fontSize: '12px', color: 'var(--green)' }}>
            VDOT aktualisiert: {vdotApplied.from} → {vdotApplied.to}
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
      {settingsSaveErr && <div className="error-box">{settingsSaveErr}</div>}
    </div>
  )
}
