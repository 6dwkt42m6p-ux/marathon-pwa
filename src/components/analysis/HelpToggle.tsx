// Inhalt: ⓘ-Toggle fuer Glossar-Erklaerungen an KPI-Labels (T-244); aus Analysis.tsx verschoben (T-275 AC2).
// Einstieg: HelpToggle({ glossaryKey, open, onToggle, variant }) — Zustand (open) liegt im Aufrufer.
// Regeln: reine Darstellung, kein State.

// T-244: ⓘ-Toggle für Glossar-Erklärungen an KPI-Labels — kein title-Tooltip (funktioniert
// auf Touch nicht, siehe T-244-Befund), Tap togglet eine sichtbare `kpi-help`-Zeile.
// `variant="tile"` füllt die volle Breite einer schmalen KPI-Tile (kollisionsfrei in der
// engen 3-Spalten-Reihe, echtes 44px-Touch-Ziel ohne Overlap mit Nachbar-Buttons);
// `variant="inline"` ist ein kompaktes rundes Icon für Fließtext-Kontexte (z.B. neben einer
// Section-Überschrift wie „Verletzungsrisiko").
export function HelpToggle({ glossaryKey, open, onToggle, variant = 'inline' }: {
  glossaryKey: string
  open: boolean
  onToggle: () => void
  variant?: 'inline' | 'tile'
}) {
  return (
    <button
      type="button"
      className={variant === 'tile' ? 'kpi-help-btn kpi-help-btn--tile' : 'kpi-help-btn'}
      aria-label={`Erklärung ${glossaryKey}`}
      aria-expanded={open}
      onClick={onToggle}
    >
      ⓘ
    </button>
  )
}
