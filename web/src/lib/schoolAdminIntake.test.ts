import { describe, expect, it } from 'vitest'
import { deviationIntake, intakeReceipt, publicGeneration, schoolSubmissions } from './schoolAdminIntake'
const id = '00000000-0000-4000-8000-000000000001'
const input = { requestId: id, departmentId: id, value: '55', reason: 'synthetic reason', pin: '0000', generation: 'a'.repeat(64), expectedValue: 50 }
describe('school correction intake (invented fixtures)', () => {
  it('requires a full generation and strict integers, preserving the displayed expected value', () => {
    expect(publicGeneration({ hash: 'a'.repeat(10) })).toBeNull()
    expect(publicGeneration({ contentSha256: 'a'.repeat(64) })).toBe(input.generation)
    expect(deviationIntake(input)).toMatchObject({ p_new_value: 55, p_expected_value: 50, p_expected_generation: input.generation, p_submission_fingerprint: null })
    for (const value of ['55x', '55.5', ' 55', '19', '81']) expect(() => deviationIntake({ ...input, value })).toThrow()
    expect(() => deviationIntake({ ...input, generation: null })).toThrow()
    expect(() => deviationIntake({ ...input, reason: 'x'.repeat(501) })).toThrow()
    expect(deviationIntake({ ...input, expectedValue: 99 }).p_expected_value).toBe(99)
    expect(deviationIntake({ ...input, expectedValue: null }).p_expected_value).toBeNull()
  })
  it('does not interpret empty PIN failure or an unrelated request as acceptance', () => {
    expect(() => intakeReceipt([], id)).toThrow()
    expect(() => intakeReceipt([{ request_id: id, state: 'success' }], id)).toThrow()
    expect(() => intakeReceipt([{ request_id: 'other', state: 'received' }], id)).toThrow()
    expect(intakeReceipt([{ request_id: id, state: 'adopted', new_value: 55 }], id)).toEqual({ request_id: id, state: 'adopted' })
  })
  it('resolves aggregate names against the displayed departments, rejecting foreign rows', () => {
    const row = { school_id: id, department_id: id, department_name: 'untrusted', submission_count: 5, avg_value: 50, median_value: 50, min_value: 40, max_value: 60 }
    expect(schoolSubmissions([row], id, [{ id, name: 'Invented department' }])[0].department_name).toBe('Invented department')
    expect(() => schoolSubmissions([row], 'different-school', [{ id, name: 'Invented' }])).toThrow()
    expect(schoolSubmissions([{ ...row, avg_value: 90, max_value: 100 }], id, [{ id, name: 'Invented' }])[0].max_value).toBe(100)
  })
})
