// T-244: PWA-Port des Desktop-Glossars (glossary.py, T-234). glossary.json wird
// aus dem Python-Repo generiert (tools/gen_glossary_json.py) — NICHT von Hand editieren.
// Test-first: rot, solange src/lib/glossary.ts fehlt.

import { describe, it, expect } from 'vitest'
import { GLOSSARY, helpText, label, type GlossaryEntry } from './glossary'
import glossaryData from '../data/glossary.json'

// AC2: feste Liste — jeder dieser Keys MUSS im generierten JSON existieren.
const REQUIRED_KEYS = ['VDOT', 'CTL', 'ATL', 'TSB', 'EF', 'ACWR', 'HRR', 'LTHR']

describe('glossary — Parität mit glossary.py (T-244)', () => {
  it.each(REQUIRED_KEYS)('enthält Key "%s"', (key) => {
    expect(GLOSSARY[key]).toBeDefined()
    expect(GLOSSARY[key].name.length).toBeGreaterThan(0)
    expect(GLOSSARY[key].short.length).toBeGreaterThan(0)
  })

  it('jeder Eintrag hat mindestens name + short', () => {
    for (const [key, entry] of Object.entries(GLOSSARY)) {
      expect(entry.name, `${key}.name fehlt`).toBeTruthy()
      expect(entry.short, `${key}.short fehlt`).toBeTruthy()
    }
  })

  it('Mutation: ein entfernter Key wird von diesem Test bemerkt (Falsifizierbarkeit)', () => {
    const withoutTsb: Record<string, GlossaryEntry> = { ...(glossaryData as Record<string, GlossaryEntry>) }
    delete withoutTsb['TSB']
    const missing = REQUIRED_KEYS.filter((k) => !(k in withoutTsb))
    expect(missing).toEqual(['TSB'])
  })

  it('helpText("CTL") folgt "name: short" (Pendant zu glossary.help_text)', () => {
    const entry = GLOSSARY['CTL']
    expect(helpText('CTL')).toBe(`${entry.name}: ${entry.short}`)
  })

  it('helpText("TSB") enthält denselben Wortlaut wie die Desktop-Erklärzeile', () => {
    expect(helpText('TSB')).toContain('CTL − ATL')
  })

  it('label("CTL") strippt den doppelten Klammer-Suffix (T-235-Review-Fix-Pendant)', () => {
    expect(GLOSSARY['CTL'].name).toBe('Chronic Training Load (CTL)')
    expect(label('CTL')).toBe('CTL · Chronic Training Load')
  })

  it('label("CTL", " (42d)") hängt den Suffix nach dem gestrippten Namen an', () => {
    expect(label('CTL', ' (42d)')).toBe('CTL · Chronic Training Load (42d)')
  })

  it('label("ATL") strippt ebenfalls (Regressionsschutz für mehrere Keys)', () => {
    expect(label('ATL')).toBe('ATL · Acute Training Load')
  })

  it('helpText/label liefern für unbekannten Key einen sicheren Fallback statt zu crashen', () => {
    expect(helpText('DOES_NOT_EXIST')).toBe('')
    expect(label('DOES_NOT_EXIST')).toBe('DOES_NOT_EXIST')
  })
})
