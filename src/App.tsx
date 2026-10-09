import { useState, useEffect, lazy, Suspense } from 'react'
import { loadSettings, saveSettings, isUsingDefaultSettings, mergeRemoteSettings, applyRemoteWeekOverrides, pendingWeekOverrideMaps, clearWeekOverridePending } from './lib/storage'
import type { AppSettings } from './lib/storage'
import TodayWorkout from './components/TodayWorkout'
import TrainingPlan from './components/TrainingPlan'
import VdotPaces from './components/VdotPaces'
// T-173: Analysis/Settings/CoachChat lazy-split — dickste Bundle-Brocken (Analysis 1197 Z.,
// Settings 744 Z.) und CoachChat (per COACH_TAB_ENABLED deaktiviert, aber sonst totes
// Bundle-Gewicht). Gemeinsamer <Suspense> in der Tab-Render-Sektion unten.
const Analysis = lazy(() => import('./components/Analysis'))
const Settings = lazy(() => import('./components/Settings'))
// CoachChat import kept intentionally — deaktiviert via COACH_TAB_ENABLED (separate Anthropic-API-Kosten).
// Reaktivierung: COACH_TAB_ENABLED auf true setzen, kein weiterer Code-Aufwand.
const CoachChat = lazy(() => import('./components/CoachChat'))
import { hasToken, fetchSync, pushSync, type SyncData } from './lib/githubSync'
import {
  reconcilePendingNoteMutations,
  mergeNoteMutationQueue,
  markNoteMutationsPushed,
} from './lib/notesSync'
import { syncActivities, getValidToken, secsSinceLastSync, SYNC_MIN_INTERVAL_SEC, type SyncedThreshold, getStorageWarning, clearStorageWarning } from './lib/strava'
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

// T-156: Flush pending note mutations against just-fetched sync data.
// Remove applied mutations (Desktop already processed them), re-push remaining once.
// T-260 P-04: reconcile compacts per activity_id + marks remotely-seen ones as pushed; the payload
// queue is compacted too, so a superseded older note can never be re-applied after a newer one.
function flushPendingNoteMutations(data: SyncData, sha: string): void {
  const remaining = reconcilePendingNoteMutations({ noteMutations: data.noteMutations, notes: data.plan?.notes })
  if (remaining.length === 0) return
  // Re-push remaining once — best-effort, no retry, no await (fire-and-forget).
  const buildPayload = (base: SyncData): SyncData =>
    ({ ...base, noteMutations: mergeNoteMutationQueue(base.noteMutations, remaining) })
  pushSync(buildPayload(data), sha, buildPayload)
    .then(() => { markNoteMutationsPushed(remaining.map(m => m.ts)) })
    .catch(() => { /* best-effort */ })
}

// T-260 P-06: re-push local swaps whose push never succeeded (offline/failed). Best-effort,
// fire-and-forget; marker cleared per week on success only if no newer local edit re-marked it
// (stamp) — see TodayWorkout.pushOverridesToGitHub for why not "on remote confirmation".
function flushPendingWeekOverrides(data: SyncData, sha: string): void {
  const pending = pendingWeekOverrideMaps()
  const weeks = Object.keys(pending)
  if (weeks.length === 0) return
  const buildPayload = (base: SyncData): SyncData => {
    const wo = { ...(base.weekOverrides ?? {}) }
    for (const w of weeks) wo[w] = pending[w].map
    return { ...base, weekOverrides: wo }
  }
  pushSync(buildPayload(data), sha, buildPayload)
    .then(() => { for (const w of weeks) clearWeekOverridePending(w, pending[w].stamp) })
    .catch(() => { /* best-effort — stays pending */ })
}

export default function App() {
  const hasOAuthCode = (() => { const q = new URLSearchParams(window.location.search); return q.has('code') || q.has('error') })()
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
  const [syncedThreshold, setSyncedThreshold] = useState<SyncedThreshold | null>(null)

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
      // T-138: capture threshold from synced plan for rTSS/hrTSS in PWA
      if (data.plan?.threshold) setSyncedThreshold(data.plan.threshold as SyncedThreshold)
      else setSyncedThreshold(null)
      // Apply remote settings if they exist (remote wins on first load).
      // T-182 Phase B review fix (Bug 2): mergeRemoteSettings strips null/undefined remote
      // values before merging — a blind spread let `raceDate1: null` (Event 1 disabled on the
      // Desktop) land in the non-nullable AppSettings.raceDate1 and corrupt VdotPaces.tsx.
      if (data.settings) {
        const merged = mergeRemoteSettings(loadSettings(), data.settings)
        saveSettings(merged)
        setSettings(merged)
      }
      // Apply week overrides from remote into localStorage.
      // T-260 P-06: always (a missing field = no swaps remote) — remote is SSoT for non-pending
      // weeks; still-pending local swaps (push failed/offline) are re-pushed once.
      applyRemoteWeekOverrides(data.weekOverrides)
      flushPendingWeekOverrides(data, result.sha)
      // T-156: Flush pending note mutations — resolve applied ones, re-push remaining.
      // Best-effort: one attempt, no retry, no new timer/poll.
      flushPendingNoteMutations(data, result.sha)
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
  // T-158(b): true when no coach_settings saved AND no sync available → DEFAULTS.vdot in use.
  // VdotPaces shows a hint so a fresh-install user isn't misled by the hardcoded 47.9 default.
  const usingDefaultVdot = !syncedVdot && isUsingDefaultSettings()

  // T-163: storage warning — set when saveCachedActivities couldn't persist even after eviction.
  // Read once on mount; user dismisses via close button which calls clearStorageWarning().
  const [storageWarning, setStorageWarning] = useState<string | null>(() => getStorageWarning())

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

      {storageWarning && (
        <div className="offline-banner" role="alert" aria-live="polite">
          <span className="offline-banner-dot" />
          Speicher voll — Detaildaten aufgeräumt. Bitte Website-Daten bereinigen falls Problem anhält.
          <button
            style={{ marginLeft: 8, background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', fontWeight: 'bold' }}
            onClick={() => { clearStorageWarning(); setStorageWarning(null) }}
            aria-label="Warnung schließen"
          >✕</button>
        </div>
      )}

      <main className="app-main">
        {tab === 'today'    && <TodayWorkout settings={settings} activitiesVersion={activitiesVersion} effectiveVdot={effectiveVdot} syncedFtp={syncedFtp} syncedThreshold={syncedThreshold} />}
        {tab === 'plan'     && <TrainingPlan settings={settings} activitiesVersion={activitiesVersion} />}
        {tab === 'paces'    && <VdotPaces    settings={settings} effectiveVdot={effectiveVdot} syncedFtp={syncedFtp} syncedThreshold={syncedThreshold} usingDefaultVdot={usingDefaultVdot} />}
        <Suspense fallback={<div className="tab-loading">Lädt…</div>}>
          {tab === 'analyse'  && <Analysis settings={settings} onGoToSettings={() => setTab('settings')} effectiveVdot={effectiveVdot} syncedFtp={syncedFtp} syncedThreshold={syncedThreshold} />}
          {tab === 'coach'    && COACH_TAB_ENABLED && <CoachChat settings={settings} online={online} />}
          {tab === 'settings' && <Settings settings={settings} onUpdate={handleSettingsUpdate} />}
        </Suspense>
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
