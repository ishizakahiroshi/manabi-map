import { describe, expect, it, vi } from 'vitest'
vi.mock('../lib/brand', () => ({ schoolBrand: {
  name: 'Synthetic {url} $&', displayName: { ja: '合成 {url} $&', en: 'Synthetic {url} $&' },
} }))
import { createTranslator, formatMessage } from './resolve'

describe('brand text and message variables are inserted once', () => {
  it('preserves template-like brand text in translated UI and invitations', () => {
    expect(createTranslator('ja')('common.brand')).toBe('合成 {url} $&')
    const message = createTranslator('en')('family.lineShareMessage', { url: 'https://school.example/family/join' })
    expect(message).toContain('Synthetic {url} $&')
    expect(message).toContain('https://school.example/family/join')
  })
  it('preserves token-like and replacement syntax in any inserted value', () => {
    expect(formatMessage('{a} {b}', { a: '{b} $&', b: 'literal' })).toBe('{b} $& literal')
    expect(formatMessage('{unknown}', {})).toBe('{unknown}')
  })
})
