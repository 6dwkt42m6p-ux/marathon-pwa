import { useState } from 'react'
import { loadSettings, saveSettings } from './lib/storage'
import type { AppSettings } from './lib/storage'
import TodayWorkout from './components/TodayWorkout'
import TrainingPlan from './components/TrainingPlan'
import VdotPaces from './components/VdotPaces'
import Analysis from './components/Analysis'
import Settings from './components/Settings'
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
  const [tab, setTab]           = useState<Tab>('today')
  const [settings, setSettings] = useState<AppSettings>(loadSettings)

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
