import { describe, expect, it } from 'vitest'

import { parsePendingInvite } from './FamilyJoinPage'

describe('pending family invite storage', () => {
  const now = 1_700_000_000_000

  it('accepts a recent synthetic token', () => {
    expect(parsePendingInvite(JSON.stringify({
      token: '00000000-0000-4000-8000-000000000001',
      userId: null,
      savedAt: now - 60_000,
    }), now)).toEqual({
      token: '00000000-0000-4000-8000-000000000001',
      userId: null,
      savedAt: now - 60_000,
    })
  })

  it('rejects expired, future, malformed, and empty tokens', () => {
    const valid = { token: 'synthetic-token', userId: 'synthetic-user', savedAt: now }
    expect(parsePendingInvite(JSON.stringify({ ...valid, savedAt: now - 10 * 60 * 1000 - 1 }), now)).toBeNull()
    expect(parsePendingInvite(JSON.stringify({ ...valid, savedAt: now + 1 }), now)).toBeNull()
    expect(parsePendingInvite(JSON.stringify({ ...valid, token: '' }), now)).toBeNull()
    expect(parsePendingInvite('not-json', now)).toBeNull()
    expect(parsePendingInvite(null, now)).toBeNull()
  })
})
