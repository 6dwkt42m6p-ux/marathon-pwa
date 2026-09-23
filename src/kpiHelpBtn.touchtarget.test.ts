// T-244 Fix-Loop 1 (Coordinator-Review, iPhone 390px): "Erklärung ACWR" (inline-Variante
// von HelpToggle, Analysis.tsx) mass 41x41px statt der geforderten 44x44px (AC3) — die
// padding/negative-margin-Technik bemass die Hit-Fläche über die Glyph-Content-Box der
// "ⓘ"-Zeichen, die schmaler war als angenommen (14px Padding + ~13px Glyphe statt 16px).
//
// jsdom liefert kein echtes Layout (getBoundingClientRect() bleibt bei 0), daher parst
// dieser Test die deklarierten CSS-Regeln aus App.css direkt statt ein DOM zu rendern und
// zu vermessen — das ist die einzige Weise, "44px" hier vor dem Merge deterministisch zu
// verifizieren. Deckt BEIDE HelpToggle-Varianten ab (inline: nur .kpi-help-btn; tile:
// .kpi-help-btn + .kpi-help-btn--tile-Override, wie in Analysis.tsx tatsächlich gerendert:
// `className="kpi-help-btn kpi-help-btn--tile"`), damit keine künftige Variante die
// Basisregel unbemerkt unterschreiten kann.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
// Kommentare vorab entfernen — sonst haengt ein mehrzeiliger `/* ... */`-Block vor einer
// Regel am Selektor-Text (m[1]), und der exakte Klassen-Vergleich in
// computedDeclarationsFor() schlaegt fehl (Selektor waere "/* ... */\n.kpi-help-btn"
// statt ".kpi-help-btn").
const CSS = readFileSync(resolve(HERE, 'App.css'), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, '')

const MIN_TOUCH_PX = 44

/** Extrahiert alle CSS-Regeln (Selektor-Liste + Deklarations-Body) — flaches CSS,
 * keine Nesting/@media-Blöcke in diesem Ausschnitt, ein Regex-Pass reicht. */
function parseRules(css: string): Array<{ selectors: string[]; declarations: Record<string, string> }> {
  const rules: Array<{ selectors: string[]; declarations: Record<string, string> }> = []
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g
  let m: RegExpExecArray | null
  while ((m = ruleRe.exec(css)) !== null) {
    const selectors = m[1].split(',').map(s => s.trim()).filter(Boolean)
    const declarations: Record<string, string> = {}
    for (const decl of m[2].split(';')) {
      const idx = decl.indexOf(':')
      if (idx === -1) continue
      const key = decl.slice(0, idx).trim()
      const value = decl.slice(idx + 1).trim()
      if (key) declarations[key] = value
    }
    rules.push({ selectors, declarations })
  }
  return rules
}

/** Deklarationen aller Regeln, deren Selektor-Liste `selector` exakt enthält, in
 * Dateireihenfolge gemerged (spätere Regel gewinnt je Property — Cascade-Analog für
 * gleiche Spezifität, wie bei `className="kpi-help-btn kpi-help-btn--tile"`). */
function computedDeclarationsFor(rules: ReturnType<typeof parseRules>, ...classNames: string[]): Record<string, string> {
  const wanted = new Set(classNames.map(c => `.${c}`))
  const merged: Record<string, string> = {}
  for (const rule of rules) {
    if (rule.selectors.some(sel => wanted.has(sel))) {
      Object.assign(merged, rule.declarations)
    }
  }
  return merged
}

function pxValue(decl: Record<string, string>, ...keys: string[]): number | null {
  for (const key of keys) {
    const raw = decl[key]
    if (raw && raw.endsWith('px')) return parseFloat(raw)
  }
  return null
}

describe('HelpToggle Touch-Ziel ≥44px — CSS-Gate (T-244 Fix-Loop 1)', () => {
  const rules = parseRules(CSS)

  it('.kpi-help-btn (Basis, Grundlage für BEIDE Varianten) ist box-sizing:border-box mit width/height ≥44px', () => {
    const decl = computedDeclarationsFor(rules, 'kpi-help-btn')
    expect(decl['box-sizing'], 'box-sizing muss border-box sein, sonst addiert Padding auf width/height').toBe('border-box')
    const width = pxValue(decl, 'width', 'min-width')
    const height = pxValue(decl, 'height', 'min-height')
    expect(width, '.kpi-help-btn: keine width/min-width in px gefunden').not.toBeNull()
    expect(height, '.kpi-help-btn: keine height/min-height in px gefunden').not.toBeNull()
    expect(width!).toBeGreaterThanOrEqual(MIN_TOUCH_PX)
    expect(height!).toBeGreaterThanOrEqual(MIN_TOUCH_PX)
  })

  it('inline-Variante (nur .kpi-help-btn, z.B. ACWR-Button im Verletzungsrisiko-Block) bleibt ≥44x44px', () => {
    const decl = computedDeclarationsFor(rules, 'kpi-help-btn')
    const width = pxValue(decl, 'width', 'min-width')
    const height = pxValue(decl, 'height', 'min-height')
    expect(width!).toBeGreaterThanOrEqual(MIN_TOUCH_PX)
    expect(height!).toBeGreaterThanOrEqual(MIN_TOUCH_PX)
  })

  it('tile-Variante (.kpi-help-btn + .kpi-help-btn--tile, TSB/CTL/ATL) bleibt ≥44x44px nach Override', () => {
    const decl = computedDeclarationsFor(rules, 'kpi-help-btn', 'kpi-help-btn--tile')
    // width darf hier bewusst `100%` sein (volle Kachelbreite) statt eines fixen px-Werts —
    // das ist in der 3-Spalten-KPI-Reihe immer breiter als 44px (Tiles sind nie schmaler
    // als ~90px auf den unterstützten Viewports, siehe Coordinator-Screenshot 91x44px).
    // Ein px-Override < 44 würde HIER durchrutschen; die height-Assertion (nicht
    // überschrieben, bleibt bei der Basis-Deklaration) und der explizite
    // Falsifizierbarkeits-Test unten decken die eigentliche Regression ab.
    const widthPx = pxValue(decl, 'width', 'min-width')
    const widthIsFullWidth = decl['width'] === '100%'
    expect(widthPx !== null || widthIsFullWidth, 'tile: width ist weder ≥44px noch 100%').toBe(true)
    if (widthPx !== null) expect(widthPx).toBeGreaterThanOrEqual(MIN_TOUCH_PX)

    const height = pxValue(decl, 'height', 'min-height')
    expect(height, 'tile: height fehlt — .kpi-help-btn--tile darf die 44px-Basishöhe nicht überschreiben').not.toBeNull()
    expect(height!).toBeGreaterThanOrEqual(MIN_TOUCH_PX)
  })

  it('Falsifizierbarkeit: eine Regel, die height auf 41px schrumpft, MUSS dieses Gate rot machen', () => {
    // Nur den exakten `.kpi-help-btn { ... }`-Block treffen (nicht `:active`/`--tile`,
    // deren Selektor nicht direkt von `{` gefolgt wird) und die Override-Deklaration ANS
    // ENDE des Bodys anhängen — sonst würde die spätere echte "height: 44px;" im
    // Originaltext die vorgetäuschte 41px-Regel wieder überschreiben (letzte Deklaration
    // gewinnt je Property innerhalb eines Rule-Bodys).
    const shrunk = CSS.replace(
      /\.kpi-help-btn\s*\{([^}]*)\}/,
      (_full, body: string) => `.kpi-help-btn {${body} height: 41px;}`
    )
    expect(shrunk).not.toBe(CSS) // Ersetzung muss tatsächlich gegriffen haben
    const shrunkRules = parseRules(shrunk)
    const decl = computedDeclarationsFor(shrunkRules, 'kpi-help-btn')
    const height = pxValue(decl, 'height', 'min-height')
    expect(height!).toBeLessThan(MIN_TOUCH_PX)
  })
})
