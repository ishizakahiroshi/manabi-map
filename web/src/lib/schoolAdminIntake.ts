/** Intake receipts describe queue progress, never a published deviation override. */
export const SCHOOL_REQUEST_STATES = ['received', 'claimed', 'adopted', 'generated', 'publication_confirmed', 'blocked', 'rejected'] as const
export type SchoolRequestState = typeof SCHOOL_REQUEST_STATES[number]
export interface SchoolRequestReceipt { request_id: string; state: SchoolRequestState }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function publicGeneration(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null
  const hash = (value as { contentSha256?: unknown }).contentSha256
  return typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash) ? hash : null
}

export function intakeReceipt(value: unknown, expectedId: string): SchoolRequestReceipt {
  if (!Array.isArray(value) || value.length !== 1) throw new Error('intake was not accepted')
  const row = value[0] as SchoolRequestReceipt
  if (!row || row.request_id !== expectedId || !UUID.test(row.request_id) || !SCHOOL_REQUEST_STATES.includes(row.state)) {
    throw new Error('invalid intake receipt')
  }
  return { request_id: row.request_id, state: row.state }
}

export function deviationIntake(input: {
  requestId: string; departmentId: string; value: string; reason: string; pin: string;
  generation: string | null; expectedValue: number | null;
}) {
  if (!UUID.test(input.requestId) || !UUID.test(input.departmentId) || !publicGeneration({ contentSha256: input.generation })) throw new Error('generation')
  if (!/^(?:[2-7][0-9]|80)$/.test(input.value)) throw new Error('value')
  const reason = input.reason.trim()
  if (reason.length < 4 || reason.length > 500) throw new Error('reason')
  if (!input.pin || input.pin.length > 128) throw new Error('pin')
  if (input.expectedValue !== null && (!Number.isInteger(input.expectedValue) || input.expectedValue < -2147483648 || input.expectedValue > 2147483647)) throw new Error('value')
  return { p_request_id: input.requestId, p_department_id: input.departmentId, p_new_value: Number(input.value),
    p_reason: reason, p_pin: input.pin, p_expected_generation: input.generation,
    p_expected_value: input.expectedValue, p_submission_fingerprint: null }
}

export interface SchoolSubmission {
  department_id: string; department_name: string; submission_count: number;
  avg_value: number; median_value: number; min_value: number; max_value: number;
}

/** Names come only from the same displayed school, not the retired SQL school tables. */
export function schoolSubmissions(value: unknown, schoolId: string, departments: readonly { id: string; name: string }[]): SchoolSubmission[] {
  if (!Array.isArray(value)) throw new Error('invalid submissions')
  const names = new Map(departments.map(d => [d.id, d.name]))
  return value.map(row => {
    if (!row || row.school_id !== schoolId || !names.has(row.department_id) || !Number.isInteger(row.submission_count) || row.submission_count < 5 ||
      !['avg_value', 'median_value', 'min_value', 'max_value'].every(key => typeof row[key] === 'number' && Number.isFinite(row[key]))) throw new Error('invalid submissions')
    return { department_id: row.department_id, department_name: names.get(row.department_id)!, submission_count: row.submission_count,
      avg_value: row.avg_value, median_value: row.median_value, min_value: row.min_value, max_value: row.max_value }
  })
}
