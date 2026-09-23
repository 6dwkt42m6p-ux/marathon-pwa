// src/lib/glossary.ts — PWA-Port des Desktop-Glossars (T-244).
//
// glossary.json wird aus glossary.py generiert (Desktop-Repo: `python3
// tools/gen_glossary_json.py`) — NICHT von Hand editieren, sonst driftet die
// PWA-Erklärung vom Desktop weg (siehe glossary.py-Docstring, T-234). Python
// bleibt die Referenz (CLAUDE.md Cross-Plattform-Parität).

import glossaryData from '../data/glossary.json'

export interface GlossaryEntry {
  name: string
  short: string
  long?: string
  unit?: string
}

export const GLOSSARY: Record<string, GlossaryEntry> = glossaryData as Record<string, GlossaryEntry>

/** `${name}: ${short}` — Pendant zu `glossary.help_text()` (Python). Leerer
 * String statt Crash, falls ein Key (noch) nicht existiert. */
export function helpText(key: string): string {
  const entry = GLOSSARY[key]
  if (!entry) return ''
  return `${entry.name}: ${entry.short}`
}

/** `${key} · ${name}${suffix}` — Pendant zu `glossary.label()` (Python).
 * Strippt einen doppelten Klammer-Suffix " (KEY)" aus `name`, falls `name`
 * die Abkürzung selbst schon in Klammern trägt (T-235-Review-Fix-Pendant:
 * ohne Strip entstünde z.B. "TSB · Training Stress Balance (TSB)"). */
export function label(key: string, suffix: string = ''): string {
  const entry = GLOSSARY[key]
  if (!entry) return key
  let name = entry.name
  const parenSuffix = ` (${key})`
  if (name.endsWith(parenSuffix)) {
    name = name.slice(0, -parenSuffix.length)
  }
  return `${key} · ${name}${suffix}`
}
