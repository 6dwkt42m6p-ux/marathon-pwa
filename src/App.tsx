import { useState, useEffect } from 'react'
import { loadSettings, saveSettings } from './lib/storage'
import type { AppSettings } from './lib/storage'
import TodayWorkout from './components/TodayWorkout'
import TrainingPlan from './components/TrainingPlan'
import VdotPaces from './components/VdotPaces'
import Analysis from './components/Analysis'
import Settings from './components/Settings'
// CoachChat import kept intentionally — deaktiviert via COACH_TAB_ENABLED (separate Anthropic-API-Kosten).
// Reaktivierung: COACH_TAB_ENABLED auf true setzen, kein weiterer Code-Aufwand.
import CoachChat from './components/CoachChat'
import { hasToken, fetchSync } from './lib/githubSync'
import { syncActivities, getValidToken, secsSinceLastSync, SYNC_MIN_INTERVAL_SEC } from './lib/strava'
import { selectEffectiveVdot } from './lib/vdot'
import './App.css'

// WHY false: Coach-Tab deaktiviert wegen separater Anthropic-API-Kosten (unabhaengig von Claude Pro).
// Code (CoachChat.tsx, coachChat.ts, Worker /claude-Route) bleibt vollstaendig erhalten.
// Reaktivierung: diesen Flag auf true setzen — fertig.
const COACH_TAB_ENABLED = false

type Tab = 'today' | 'analyse' | 'plan' | 'paces' | 'coach' | 'settings'

const ALL_TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'today',    label: 'Heute',   icon: '🏃' },
  { id: 'analyse',  label: 'Analyse', icon: '📊' },
  { id: 'plan',     label: 'Plan',    icon: '📅' },
  { id: 'paces',    label: 'Paces',   icon: '⚡' },
  { id: 'coach',    label: 'Coach',   icon: '🤖' },
  { id: 'settings', label: 'Settings',icon: '⚙️' },
]

const TABS = COACH_TAB_ENABLED ? ALL_TABS : ALL_TABS.filter(t => t.id !== 'coach')

export default function App() {
  const hasOAuthCode = new URLSearchParams(window.location.search).has('code')
  const [tab, setTab]           = useState<Tab>(hasOAuthCode ? 'settings' : 'today')
  const [settings, setSettings] = useState<AppSettings>(loadSettings)
  const [online, setOnline] = useState(navigator.onLine)
  // Incremented after every successful syncActivities — signals Today/Plan to re-read the cache.
  const [activitiesVersion, setActivitiesVersion] = useState(0)
  // T-123: VDOT from desktop sync.json plan (authoritative when present).
  // null = no sync yet; falls back to settings.vdot in effectiveVdot.
  const [syncedVdot, setSyncedVdot] = useState<number | null>(null)
  // T-125: FTP from desktop sync.json plan — null until sync arrives.
  // No local FTP fallback needed: without synced FTP, Ride-factor path stays active.
  const [syncedFtp, setSyncedFtp] = useState<number | null>(null)

  useEffect(() => {
    const handleOnline  = () => setOnline(true)
    const handleOffline = () => setOnline(false)
    window.addEventListener('online',  handleOnline)
    window.addEventListener('offline', handleOffline)
    return () => {
      window.removeEventListener('online',  handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [])

  // App-level Strava activity sync: runs on mount and on visibility regain
  // (e.g. user switches back to app after completing a run).
  // Uses a 60s TTL so rapid focus flicker doesn't spam the Strava API.
  useEffect(() => {
    let mounted = true

    function trySync() {
      if (!online) return
      if (secsSinceLastSync() < SYNC_MIN_INTERVAL_SEC) return
      getValidToken().then(token => {
        if (!token || !mounted) return
        syncActivities(52)
          .then(fresh => {
            if (mounted && fresh && fresh.length > 0) setActivitiesVersion(v => v + 1)
          })
          .catch(() => { /* offline or 429 — keep existing cache, no crash */ })
      }).catch(() => {})
    }

    trySync()  // on mount

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') trySync()
    }
    document.addEventListener('visibilitychange', handleVisibility)

    return () => {
      mounted = false
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [online])  // re-register when online state changes so trySync sees current value

  // On startup: pull sync data from GitHub and apply
  useEffect(() => {
    if (!hasToken()) return
    let mounted = true
    fetchSync().then(result => {
      if (!mounted || !result) return
      const { data } = result
      // T-123: capture desktop-derived VDOT as canonical source
      if (data.plan?.vdot) setSyncedVdot(data.plan.vdot)
      // T-125: capture FTP from synced plan (null when not set on Desktop)
      if (data.plan?.ftp != null && data.plan.ftp > 0) setSyncedFtp(data.plan.ftp)
      // Apply remote settings if they exist (remote wins on first load)
      if (data.settings) {
        const merged = { ...loadSettings(), ...data.settings } as AppSettings
        saveSettings(merged)
        setSettings(merged)
      }
      // Apply week overrides from remote into localStorage
      if (data.weekOverrides) {
        Object.entries(data.weekOverrides).forEach(([weekKey, map]) => {
          const lsKey = `week_override_${weekKey}`
          // Convert map {originalDay -> currentDay} back to DayAssignment array
          // We need to know all days — re-build from existing or skip if already set
          const existing = localStorage.getItem(lsKey)
          const arr: Array<{ originalDay: string; currentDay: string }> = existing ? JSON.parse(existing) : []
          const days = ['Mo','Di','Mi','Do','Fr','Sa','So']
          const updated = days
            .filter(d => arr.some(a => a.originalDay === d) || map[d])
            .map(d => {
              const found = arr.find(a => a.originalDay === d)
              return { originalDay: d, currentDay: map[d] ?? found?.currentDay ?? d }
            })
          if (updated.length > 0) localStorage.setItem(lsKey, JSON.stringify(updated))
        })
      }
    }).catch(() => { /* silent — sync is best-effort */ })
    return () => { mounted = false }
  }, [])

  function handleSettingsUpdate(s: AppSettings) {
    saveSettings(s)
    setSettings(s)
  }

  // T-123: single canonical VDOT — desktop sync wins, settings.vdot is offline fallback.
  const effectiveVdot = selectEffectiveVdot(syncedVdot, settings.vdot)
  // Show "(lokal)" tag in header when falling back to local settings value
  const vdotLabel = syncedVdot
    ? `VDOT ${effectiveVdot.toFixed(1)}`
    : `VDOT ${effectiveVdot.toFixed(1)} (lokal)`

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-title">
          <span className="header-icon">🏆</span>
          <span>Marathon Coach</span>
        </div>
        <div className="header-vdot">{vdotLabel}</div>
      </header>

      {!online && (
        <div className="offline-banner" role="status" aria-live="polite">
          <span className="offline-banner-dot" />
          Offline — Strava-Sync nicht verfügbar
        </div>
      )}

      <main className="app-main">
        {tab === 'today'    && <TodayWorkout settings={settings} activitiesVersion={activitiesVersion} effectiveVdot={effectiveVdot} />}
        {tab === 'analyse'  && <Analysis     settings={settings} onGoToSettings={() => setTab('settings')} effectiveVdot={effectiveVdot} syncedFtp={syncedFtp} />}
        {tab === 'plan'     && <TrainingPlan settings={settings} activitiesVersion={activitiesVersion} />}
        {tab === 'paces'    && <VdotPaces    settings={settings} effectiveVdot={effectiveVdot} />}
        {tab === 'coach'    && COACH_TAB_ENABLED && <CoachChat settings={settings} online={online} />}
        {tab === 'settings' && <Settings     settings={settings} onUpdate={handleSettingsUpdate} />}
      </main>

      <nav className="bottom-nav">
        {TABS.map(t => (
          <button
            key={t.id}
            className={`nav-btn ${tab === t.id ? 'active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            <span className="nav-icon">{t.icon}</span>
            <span className="nav-label">{t.label}</span>
          </button>
        ))}
      </nav>
    </div>
  )
}
