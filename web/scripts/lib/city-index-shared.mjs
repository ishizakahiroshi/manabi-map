/** Pure city-index helpers shared by the Node generator and React bundle. */
export function cityPagePath(prefSlug, city) {
  return `/pref/${prefSlug}/${encodeURIComponent(city)}/`
}

export function buildCityCounts(prefIndex) {
  const counts = new Map()
  for (const entry of prefIndex.schools) {
    if (entry.c == null) continue
    counts.set(entry.c, (counts.get(entry.c) ?? 0) + 1)
  }
  return prefIndex.cities
    .filter((city) => counts.has(city))
    .map((city) => ({ c: city, n: counts.get(city) }))
}
