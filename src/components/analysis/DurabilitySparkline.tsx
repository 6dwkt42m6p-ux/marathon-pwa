// Inhalt: Inline-SVG-Sparkline fuer Durability-Signale (Drift + Fade), T-142; aus Analysis.tsx verschoben (T-275 AC2).
// Einstieg: DurabilitySparkline({ series, color }) — rendert null bei < 2 Punkten.
// Regeln: reine Darstellung, kein State.

// T-142: Inline-SVG-Sparkline für Durability-Signale (Drift + Fade).
// T-142: Inline-SVG-Sparkline für Durability-Signale (Drift + Fade).
export function DurabilitySparkline({ series, color }: { series: Array<[number, number]>; color: string }) {
  if (!series || series.length < 2) return null
  const w = 120, h = 32, pad = 3
  const xs = series.map(p => p[0]), ys = series.map(p => p[1])
  const xMin = Math.min(...xs), xMax = Math.max(...xs)
  const yMin = Math.min(...ys), yMax = Math.max(...ys)
  const sx = (x: number) => xMax === xMin ? w / 2 : pad + (x - xMin) / (xMax - xMin) * (w - 2 * pad)
  const sy = (y: number) => yMax === yMin ? h / 2 : h - pad - (y - yMin) / (yMax - yMin) * (h - 2 * pad)
  const pts = series.map(([x, y]) => `${sx(x).toFixed(1)},${sy(y).toFixed(1)}`).join(' ')
  return (
    <svg width={w} height={h} style={{ display: 'block', marginTop: 4 }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} />
      {series.map(([x, y], i) => (
        <circle key={i} cx={sx(x)} cy={sy(y)} r={1.8} fill={color} />
      ))}
    </svg>
  )
}
