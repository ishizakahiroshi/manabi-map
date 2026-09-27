import { describe, expect, it } from 'vitest'
import { callbackFailure, consumeAuthReturn, rememberAuthReturn } from './siteMoveRecovery'

function storage() {
  const values = new Map<string, string>()
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } }
}
describe('same-origin authentication recovery', () => {
  it('resumes the token-free pending invite once and keeps legacy callbacks off the portal', () => {
    const store = storage()
    rememberAuthReturn('/family/join/', store, 100)
    expect(consumeAuthReturn(true, store, 101)).toBe('/family/join')
    expect(consumeAuthReturn(true, store, 102)).toBe('/mypage')
    expect(consumeAuthReturn(false, store, 102)).toBe('/')
  })
  it('never accepts external/query/fragment destinations, stale or future state', () => {
    for (const path of ['//other.invalid/', 'https://other.invalid/', '/family/join?token=synthetic', '/family/join#token=synthetic']) {
      const store = storage(); rememberAuthReturn(path, store, 100)
      expect(consumeAuthReturn(true, store, 101)).toBe('/mypage')
    }
    for (const now of [99, 600101]) {
      const store = storage(); rememberAuthReturn('/family/join', store, 100)
      expect(consumeAuthReturn(true, store, now)).toBe('/mypage')
    }
  })
  it('survives unavailable storage', () => {
    const store = { getItem: () => { throw Error('denied') }, setItem: () => { throw Error('denied') }, removeItem: () => { throw Error('denied') } }
    expect(() => rememberAuthReturn('/mypage', store)).not.toThrow()
    expect(consumeAuthReturn(true, store)).toBe('/mypage')
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')
    Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, get() { throw new Error('SecurityError') } })
    try {
      expect(() => rememberAuthReturn('/family/join')).not.toThrow()
      expect(consumeAuthReturn(true)).toBe('/mypage')
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'sessionStorage', descriptor)
      else Reflect.deleteProperty(globalThis, 'sessionStorage')
    }
  })
  it('detects query and fragment errors even when no error_code is supplied', () => {
    expect(callbackFailure('?error=access_denied', '')?.code).toBe('access_denied')
    expect(callbackFailure('', '#error=access_denied&error_description=Cancelled')?.description).toBe('Cancelled')
    expect(callbackFailure('?error_code=identity_already_exists', '')?.code).toBe('identity_already_exists')
    expect(callbackFailure('?code=synthetic', '#token=synthetic')).toBeNull()
  })
})
