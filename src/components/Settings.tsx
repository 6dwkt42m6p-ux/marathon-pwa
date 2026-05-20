import { useState } from 'react'
import type { AppSettings } from '../lib/storage'
import { saveSettings } from '../lib/storage'
import { vdotFromRace, buildPaceTable } from '../lib/vdot'

interface Props {
  settings: AppSettings
  onUpdate: (s: AppSettings) => void
}

export default function Settings({ settings, onUpdate }: Props) {
  const [s, setS] = useState(settings)
  const [saved, setSaved] = useState(false)

  function update<K extends keyof AppSettings>(key: K, val: AppSettings[K]) {
    setS(prev => ({ ...prev, [key]: val }))
    setSaved(false)
  }

  function handleSave() {
    saveSettings(s)
    onUpdate(s)
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
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
