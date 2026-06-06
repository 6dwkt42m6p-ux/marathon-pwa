import { useState, useEffect } from 'react'
import { loadSettings, saveSettings } from './lib/storage'
import type { AppSettings } from './lib/storage'
import TodayWorkout from './components/TodayWorkout'
import TrainingPlan from './components/TrainingPlan'
import VdotPaces from './components/VdotPaces'
import Analysis from './components/Analysis'
import Settings from './components/Settings'
import { hasToken, fetchSync } from './lib/githubSync'
import './App.css'

type Tab = 'today' | 'analyse' | 'plan' | 'paces' | 'settings'

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'today',    label: 'Heute',   icon: '🏃' },
  { id: 'analyse',  label: 'Analyse', icon: '📊' },
  { id: 'plan',     label: 'Plan',    icon: '📅' },
  { id: 'paces',    label: 'Paces',   icon: '⚡' },
  { id: 'settings', label: 'Settings',icon: '⚙️' },
]

export default function App() {
  const hasOAuthCode = new URLSearchParams(window.location.search).has('code')
  const [tab, setTab]           = useState<Tab>(hasOAuthCode ? 'settings' : 'today')
  const [settings, setSettings] = useState<AppSettings>(loadSettings)
  const [online, setOnline] = useState(navigator.onLine)

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

  // On startup: pull sync data from GitHub and apply
  useEffect(() => {
    if (!hasToken()) return
    fetchSync().then(result => {
      if (!result) return
      const { data } = result
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
  }, [])

  function handleSettingsUpdate(s: AppSettings) {
    saveSettings(s)
    setSettings(s)
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-title">
          <span className="header-icon">🏆</span>
          <span>Marathon Coach</span>
        </div>
        <div className="header-vdot">VDOT {settings.vdot.toFixed(1)}</div>
      </header>

      {!online && (
        <div className="offline-banner" role="status" aria-live="polite">
          <span className="offline-banner-dot" />
          Offline — Strava-Sync nicht verfügbar
        </div>
      )}

      <main className="app-main">
        {tab === 'today'    && <TodayWorkout settings={settings} />}
        {tab === 'analyse'  && <Analysis     settings={settings} onGoToSettings={() => setTab('settings')} />}
        {tab === 'plan'     && <TrainingPlan settings={settings} />}
        {tab === 'paces'    && <VdotPaces    settings={settings} />}
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
