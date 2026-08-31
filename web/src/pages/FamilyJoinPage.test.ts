import { afterEach, describe, expect, it, vi } from 'vitest'

import { inviteUrlFor } from '../hooks/useFamilyShare'
import { parsePendingInvite, readInviteFromUrl, stripInviteTokenFromUrl } from './FamilyJoinPage'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('family invite URL', () => {
  it('generates a fragment token URL and encodes the token', () => {
    vi.stubGlobal('location', { origin: 'https://synthetic.example.test' })
    expect(inviteUrlFor('synthetic token')).toBe('https://synthetic.example.test/family/join#token=synthetic%20token')
  })

  it('prefers the fragment and keeps old query links read-compatible', () => {
    expect(readInviteFromUrl('?token=old-token', '#token=new-token')).toEqual({
      token: 'new-token',
      source: 'fragment',
    })
    expect(readInviteFromUrl('?token=old-token', '')).toEqual({
      token: 'old-token',
      source: 'query',
    })
    expect(readInviteFromUrl('', '#other=value')).toBeNull()
  })

  it('removes query and fragment tokens with history replacement', () => {
    const replaceState = vi.fn()
    vi.stubGlobal('window', {
      location: { href: 'https://synthetic.example.test/family/join?token=old-token&keep=1#token=new-token' },
      history: { state: { synthetic: true }, replaceState },
    })

    stripInviteTokenFromUrl('fragment')

    expect(replaceState).toHaveBeenCalledWith(
      { synthetic: true },
      '',
      '/family/join?keep=1',
    )
  })

  it('keeps unrelated query and fragment values for an old query invite', () => {
    const replaceState = vi.fn()
    vi.stubGlobal('window', {
      location: { href: 'https://synthetic.example.test/family/join?token=old-token&keep=1#section' },
      history: { state: null, replaceState },
    })

    stripInviteTokenFromUrl('query')

    expect(replaceState).toHaveBeenCalledWith(null, '', '/family/join?keep=1#section')
  })
})

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
