// T-275 AC3 / T-274: jede Quelldatei unter src/lib und src/components beginnt mit einem
// Inhalts-Kopf ("// Inhalt: ..."), dessen fuehrender Kommentarblock <= 20 nicht-leere Zeilen hat.
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..')
const MAX_HEAD_LINES = 20

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p))
    else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p)
  }
  return out
}

// Fuehrender Kommentarblock = zusammenhaengende `//`-Zeilen ab Zeile 1 (Leerzeile beendet ihn).
function leadingCommentBlock(text: string): string[] {
  const block: string[] = []
  for (const line of text.split('\n')) {
    if (!line.trim().startsWith('//')) break
    block.push(line)
  }
  return block
}

const files = [...sourceFiles(join(SRC, 'lib')), ...sourceFiles(join(SRC, 'components'))]

describe('T-275 Inhalts-Koepfe', () => {
  it('findet die strava/*-Module (Gate greift auch im Unterordner)', () => {
    expect(files.some(f => f.includes(join('lib', 'strava', 'classify.ts')))).toBe(true)
  })
  it.each(files.map(f => [relative(SRC, f), f]))('%s hat einen Inhalts-Kopf', (_rel, file) => {
    const block = leadingCommentBlock(readFileSync(file, 'utf-8'))
    expect(block[0] ?? '').toMatch(/^\/\/ Inhalt:/)
    expect(block.filter(l => l.replace(/^\s*\/\/\s*/, '').trim()).length).toBeLessThanOrEqual(MAX_HEAD_LINES)
  })
  it('Zaehler ist fehlbar: Datei ohne Kopf / ueberlanger Kopf faellt durch', () => {
    expect(leadingCommentBlock('import x from "y"\n')).toEqual([])
    const long = Array.from({ length: 21 }, (_, i) => `// Zeile ${i}`).join('\n')
    expect(leadingCommentBlock(long).length).toBeGreaterThan(MAX_HEAD_LINES)
  })
})
