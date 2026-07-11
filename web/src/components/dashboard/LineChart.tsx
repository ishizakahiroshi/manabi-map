interface LineChartProps { dates: string[]; values: number[]; unit?: string }
export function LineChart({ dates, values, unit = '' }: LineChartProps) {
  if (!values.length) return <p>データなし</p>
  const max = Math.max(1, ...values); const width = 520; const height = 170; const left = 34; const bottom = 22
  const point = (value: number, index: number) => `${left + (width - left - 8) * (index / Math.max(1, values.length - 1))},${12 + (height - 12 - bottom) * (1 - value / max)}`
  return <svg viewBox={`0 0 ${width} ${height}`} width="100%" role="img" aria-label="日次推移"><polyline points={values.map(point).join(' ')} fill="none" stroke="#e8622a" strokeWidth="2" />{values.map((value, index) => <circle key={dates[index]} cx={point(value, index).split(',')[0]} cy={point(value, index).split(',')[1]} r="3" fill="#e8622a"><title>{dates[index]}: {value.toLocaleString()}{unit}</title></circle>)}<text x={left} y={height - 4} fill="#837a6c" fontSize="10">{dates[0]}</text><text x={width - 8} y={height - 4} textAnchor="end" fill="#837a6c" fontSize="10">{dates.at(-1)}</text></svg>
}
