/**
 * Hand-rolled SVG sparkline — handoff doc dop wybór: „bez biblioteki".
 *
 * Input: array liczb (0-100 dla CPU/RAM/disk; dowolny zakres dla net/count).
 * Wypełnia całą szerokość kontenera. Min/max auto-fit (lub forced).
 * Null values pomijane (cut line, np. temp gdy macOS bez sudo).
 */
interface SparklineProps {
  data: (number | null)[]
  width?: number
  height?: number
  min?: number          // force range; default = auto from data
  max?: number          // default = auto
  color?: string        // CSS color/var
  fillOpacity?: number  // 0..1, default 0.15
  /** Pokaż ostatnią wartość jako kropka. */
  showLastDot?: boolean
}

export function Sparkline({
  data,
  width = 100,
  height = 30,
  min,
  max,
  color = 'var(--blue)',
  fillOpacity = 0.15,
  showLastDot = true,
}: SparklineProps) {
  const validData = data.filter((d): d is number => d !== null && Number.isFinite(d))
  if (validData.length === 0) {
    return (
      <div style={{
        width, height,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: 'var(--muted-2)', fontSize: 10,
      }}>
        brak danych
      </div>
    )
  }

  const lo = min ?? Math.min(...validData)
  const hi = max ?? Math.max(...validData)
  const range = hi - lo || 1
  const stepX = data.length > 1 ? width / (data.length - 1) : width

  // Wytycz path — pomijając null punkty (segmenty rozdzielone gdy null w środku).
  const segments: { x: number; y: number }[][] = []
  let current: { x: number; y: number }[] = []
  data.forEach((v, i) => {
    if (v === null || !Number.isFinite(v)) {
      if (current.length > 0) { segments.push(current); current = [] }
      return
    }
    const x = i * stepX
    const y = height - ((v - lo) / range) * height
    current.push({ x, y })
  })
  if (current.length > 0) segments.push(current)

  const linePaths = segments.map((seg) =>
    seg.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ')
  )

  // Filled area path — ostatni segment (główny ciąg). Dla MVP — pełen path
  // przez wszystkie segmenty, łączymy w jedną fill area.
  const allPoints = segments.flat()
  const areaPath = allPoints.length > 0
    ? `M ${allPoints[0].x.toFixed(1)} ${height} ` +
      allPoints.map((p) => `L ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ') +
      ` L ${allPoints[allPoints.length - 1].x.toFixed(1)} ${height} Z`
    : ''

  const lastPoint = allPoints[allPoints.length - 1]

  return (
    <svg width={width} height={height} style={{ display: 'block', overflow: 'visible' }}>
      {areaPath && (
        <path
          d={areaPath}
          fill={color}
          fillOpacity={fillOpacity}
          stroke="none"
        />
      )}
      {linePaths.map((d, i) => (
        <path
          key={i}
          d={d}
          fill="none"
          stroke={color}
          strokeWidth={1.4}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
      {showLastDot && lastPoint && (
        <circle
          cx={lastPoint.x}
          cy={lastPoint.y}
          r={2.5}
          fill={color}
        />
      )}
    </svg>
  )
}
