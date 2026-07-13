interface HBarListProps { rows: { label: string; value: number }[] }
export function HBarList({ rows }: HBarListProps) {
  const sortedRows = [...rows].sort((a, b) => b.value - a.value)
  const max = Math.max(1, ...sortedRows.map((row) => row.value))

  if (!sortedRows.length) return <p>データなし</p>

  return (
    <div>
      {sortedRows.map((row) => (
        <div key={row.label} style={{ display: 'grid', gridTemplateColumns: 'minmax(90px,180px) 1fr 64px', gap: 8, alignItems: 'center', margin: '6px 0' }}>
          <span title={row.label} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.label}</span>
          <span style={{ height: 14, background: '#e8622a', width: `${Math.max(2, row.value / max * 100)}%` }} />
          <b className="dashboard-number" style={{ textAlign: 'right' }}>{row.value.toLocaleString()}</b>
        </div>
      ))}
    </div>
  )
}
