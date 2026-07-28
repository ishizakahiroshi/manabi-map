import type { DeptUiGroup, School } from '../types/school'

/**
 * Return the UI groups represented by a school's department data.
 *
 * A school with no department rows is different from a school whose department
 * exists but has an unmapped course type. Keep those cases separate so the map
 * filter can expose missing data without mixing it into "Other".
 */
export function departmentUiGroups(school: Pick<School, 'departments'>): DeptUiGroup[] {
  if (school.departments.length === 0) return ['unknown']
  return school.departments.map((department) => department.ui_group ?? 'other')
}
