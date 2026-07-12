interface LineChartProps { dates: string[]; values: number[]; unit?: string }
export function LineChart({ dates, values, unit = '' }: LineChartProps) {
  if (!values.length) return <p>データなし</p>

  const width = 520
  const height = 170
  const left = 34
  const right = 8
  const top = 12
  const bottom = 22
  const max = Math.max(1, ...values)
  const chartWidth = width - left - right
  const chartHeight = height - top - bottom
  const point = (value: number, index: number) => ({
    x: left + chartWidth * (index / Math.max(1, values.length - 1)),
    y: top + chartHeight * (1 - value / max),
  })
  const points = values.map(point)
  const polyline = points.map(({ x, y }) => `${x},${y}`).join(' ')
  const area = `${left},${height - bottom} ${polyline} ${points.at(-1)?.x ?? left},${height - bottom}`
  const lastPoint = points.at(-1) ?? { x: left, y: top }
  const lastValue = values.at(-1) ?? 0

  return (
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" role="img" aria-label="日次推移">
      {[0.25, 0.5, 0.75, 1].map((ratio) => (
        <line key={ratio} x1={left} x2={width - right} y1={top + chartHeight * ratio} y2={top + chartHeight * ratio} stroke="rgba(36,31,26,0.12)" strokeWidth="1" />
      ))}
      <polygon points={area} fill="rgba(232,98,42,0.10)" />
      <polyline points={polyline} fill="none" stroke="#e8622a" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      {values.map((value, index) => {
        const current = points[index]
        return (
          <circle key={`${dates[index] ?? 'point'}-${index}`} cx={current.x} cy={current.y} r="3" fill="#e8622a">
            <title>{dates[index] ?? '日付不明'}: {value.toLocaleString()}{unit}</title>
          </circle>
        )
      })}
      <text x={Math.min(width - right, lastPoint.x)} y={Math.max(top + 10, lastPoint.y - 8)} textAnchor="end" fill="#241f1a" fontSize="11" fontWeight="700" style={{ fontVariantNumeric: 'tabular-nums' }}>
        {lastValue.toLocaleString()}{unit}
      </text>
      <text x={left} y={height - 4} fill="#837a6c" fontSize="10">{dates[0]}</text>
      <text x={width - right} y={height - 4} textAnchor="end" fill="#837a6c" fontSize="10">{dates.at(-1)}</text>
    </svg>
  )
}
