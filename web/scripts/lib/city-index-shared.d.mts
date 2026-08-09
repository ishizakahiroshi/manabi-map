export function cityPagePath(prefSlug: string, city: string): string

export function buildCityCounts(payload: {
  cities: readonly string[]
  schools: ReadonlyArray<{ c: string | null }>
}): Array<{ c: string; n: number }>
