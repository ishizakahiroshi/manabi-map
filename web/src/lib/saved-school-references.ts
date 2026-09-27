import type { MineRecord, School } from '../types/school'

/** Saved IDs own the list; the public map only supplies display information. */
export function savedSchoolEntries<T>(schools: School[], saved: Record<string, T>) {
  const entries = schools.filter((school) => Object.hasOwn(saved, school.id))
    .map((school) => ({ id: school.id, school: school as School | undefined, record: saved[school.id] }))
  const known = new Set(entries.map(({ id }) => id))
  for (const [id, record] of Object.entries(saved)) {
    if (!known.has(id)) entries.push({ id, school: undefined, record })
  }
  return entries
}

/** Retain values for departments omitted from the current public school too. */
export function savedDepartmentValues(school: School | undefined, record: MineRecord) {
  const names = new Map(school?.departments.map((department) => [department.id, department.name]))
  const ids = [...names.keys(), ...Object.keys(record.depts).filter((id) => !names.has(id))]
  return ids.map((id) => [id, record.depts[id]] as const)
    .filter(([, value]) => value != null)
    .map(([id, value]) => ({ id, name: names.get(id), value }))
}

export function schoolReferenceStatus(loading: boolean, error: string | null) {
  return error ? 'failed' : loading ? 'loading' : 'unlisted'
}
