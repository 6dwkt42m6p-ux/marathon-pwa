// T-287: Schichten-Gate der PWA — keine Laufzeit-Importzyklen in src/lib, lib importiert nie components.
// Eigene kleine Import-Graph-Analyse (Regex, keine Dependency); `import type` zaehlt nicht (zur Laufzeit geloescht).
// Selbsttests unten beweisen, dass Zyklus bzw. Schichtverletzung tatsaechlich erkannt werden.
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')
const LIB = join(SRC, 'lib')

function files(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...files(p))
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p)
  }
  return out
}

const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')

/** Relative Modulpfade, die zur Laufzeit geladen werden (ohne `import type` / `export type`). */
export function runtimeSpecs(text: string): string[] {
  const t = stripComments(text)
  const out: string[] = []
  const re = /(?:^|\n)\s*(?:import|export)\s+(type\s+)?(?:[^'";]*?\s*from\s*)?['"]([^'"]+)['"]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(t))) if (!m[1]) out.push(m[2])
  const dyn = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g
  while ((m = dyn.exec(t))) out.push(m[1])
  return out
}

/** Graph: absoluter Dateipfad (ohne Endung) -> Menge importierter Dateipfade; Aufloesung wie Bundler (Datei vor Ordner-Index). */
export function buildGraph(sources: Record<string, string>): Map<string, Set<string>> {
  const known = new Set(Object.keys(sources))
  const resolveSpec = (from: string, spec: string): string | null => {
    if (!spec.startsWith('.')) return null
    const base = resolve(dirname(from), spec)
    for (const c of [base, join(base, 'index')]) if (known.has(c)) return c
    return null
  }
  const g = new Map<string, Set<string>>()
  for (const [file, text] of Object.entries(sources)) {
    const deps = new Set<string>()
    for (const spec of runtimeSpecs(text)) {
      const r = resolveSpec(file, spec)
      if (r && r !== file) deps.add(r)
    }
    g.set(file, deps)
  }
  return g
}

/** Stark zusammenhaengende Komponenten mit > 1 Knoten (Tarjan, iterativ genug fuer ~60 Dateien). */
export function findCycles(g: Map<string, Set<string>>): string[][] {
  const idx = new Map<string, number>(), low = new Map<string, number>()
  const stack: string[] = [], on = new Set<string>(), out: string[][] = []
  let n = 0
  const visit = (v: string) => {
    idx.set(v, n); low.set(v, n); n++; stack.push(v); on.add(v)
    for (const w of g.get(v) ?? []) {
      if (!idx.has(w)) { visit(w); low.set(v, Math.min(low.get(v)!, low.get(w)!)) }
      else if (on.has(w)) low.set(v, Math.min(low.get(v)!, idx.get(w)!))
    }
    if (low.get(v) === idx.get(v)) {
      const comp: string[] = []
      for (;;) { const w = stack.pop()!; on.delete(w); comp.push(w); if (w === v) break }
      if (comp.length > 1) out.push(comp.sort())
    }
  }
  for (const v of g.keys()) if (!idx.has(v)) visit(v)
  return out
}

/** Kanten lib -> components (verboten). */
export function libToComponents(g: Map<string, Set<string>>): string[] {
  const comps = join(SRC, 'components')
  const bad: string[] = []
  for (const [from, deps] of g) {
    if (!from.startsWith(LIB)) continue
    for (const d of deps) if (d.startsWith(comps)) bad.push(`${relative(SRC, from)} -> ${relative(SRC, d)}`)
  }
  return bad
}

function loadSources(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const dir of [LIB, join(SRC, 'components')]) {
    let list: string[] = []
    try { list = files(dir) } catch { /* components fehlt */ }
    for (const f of list) out[f.replace(/\.tsx?$/, '')] = readFileSync(f, 'utf8')
  }
  return out
}

const rel = (cycles: string[][]) => cycles.map(c => c.map(f => relative(SRC, f)))

describe('Import-Schichten (T-287)', () => {
  const sources = loadSources()
  const graph = buildGraph(sources)

  it('Graph deckt lib und components ab', () => {
    expect(graph.size).toBeGreaterThan(20)
    expect(graph.has(join(LIB, 'durability'))).toBe(true)
  })

  it('keine Laufzeit-Importzyklen', () => {
    expect(rel(findCycles(graph))).toEqual([])
  })

  it('lib importiert nie components', () => {
    expect(libToComponents(graph)).toEqual([])
  })

  it('Selbsttest: Zyklus ueber Barrel wird erkannt', () => {
    const a = join(LIB, 'a'), b = join(LIB, 'b'), idx = join(LIB, 'b', 'index')
    const g = buildGraph({
      [a]: "import { x } from './b'\nexport const y = x",
      [idx]: "import { y } from '../a'\nexport const x = y",
      [b]: "export * from './b/index'",
    })
    expect(findCycles(g).length).toBeGreaterThan(0)
  })

  it('Selbsttest: import type und Kommentare zaehlen nicht', () => {
    const a = join(LIB, 'a'), b = join(LIB, 'b')
    const g = buildGraph({
      [a]: "import type { T } from './b'\n// import { z } from './b'\nexport const y = 1",
      [b]: "import { y } from './a'\nexport const x = y",
    })
    expect(findCycles(g)).toEqual([])
  })

  it('Selbsttest: mehrzeilige und dynamische Importe zaehlen', () => {
    const a = join(LIB, 'a'), b = join(LIB, 'b')
    const g = buildGraph({
      [a]: "import {\n  x,\n  type T,\n} from './b'\nexport const y = x",
      [b]: "export const x = () => import('./a')",
    })
    expect(findCycles(g).length).toBeGreaterThan(0)
  })

  it('Selbsttest: lib -> components wird erkannt', () => {
    const a = join(LIB, 'a'), c = join(SRC, 'components', 'C')
    const g = buildGraph({ [a]: "import C from '../components/C'", [c]: 'export default 1' })
    expect(libToComponents(g)).toEqual(['lib/a -> components/C'])
  })
})
