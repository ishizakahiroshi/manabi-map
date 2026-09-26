import { describe, expect, it } from 'vitest'
import { sanitizeLegalHref } from './legalUrl'

describe('sanitizeLegalHref', () => {
  it('allows external https URLs and marks them external', () => {
    const result = sanitizeLegalHref('https://example.com/info')
    expect(result).toEqual({
      safe: 'https://example.com/info',
      isExternal: true,
    })
  })

  it('allows external mailto URLs and marks them external', () => {
    const result = sanitizeLegalHref('mailto:support@example.com')
    expect(result).toEqual({
      safe: 'mailto:support@example.com',
      isExternal: true,
    })
  })

  it('allows root-relative internal links and marks them non-external', () => {
    const result = sanitizeLegalHref('/legal/deviation-methodology')
    expect(result).toEqual({
      safe: '/legal/deviation-methodology',
      isExternal: false,
    })
  })

  it('blocks javascript: and other dangerous schemes', () => {
    expect(sanitizeLegalHref('javascript:alert(1)')).toEqual({
      safe: undefined,
      isExternal: false,
    })
    expect(sanitizeLegalHref('data:text/html,evil')).toEqual({
      safe: undefined,
      isExternal: false,
    })
    expect(sanitizeLegalHref('vbscript:msgbox(1)')).toEqual({
      safe: undefined,
      isExternal: false,
    })
    expect(sanitizeLegalHref('//example.com')).toEqual({
      safe: undefined,
      isExternal: false,
    })
    expect(sanitizeLegalHref('/\\example.com')).toEqual({
      safe: undefined,
      isExternal: false,
    })
    expect(sanitizeLegalHref('/\t/evil.example')).toEqual({
      safe: undefined,
      isExternal: false,
    })
    expect(sanitizeLegalHref('/\n/evil.example')).toEqual({
      safe: undefined,
      isExternal: false,
    })
    expect(sanitizeLegalHref('/\r/evil.example')).toEqual({
      safe: undefined,
      isExternal: false,
    })
  })

  it('strips tab, CR, and LF inside an otherwise allowed URL', () => {
    expect(sanitizeLegalHref('https://exa\tmple.com/a')).toEqual({
      safe: 'https://example.com/a',
      isExternal: true,
    })
  })

  it('handles empty or undefined href safely', () => {
    expect(sanitizeLegalHref(undefined)).toEqual({
      safe: undefined,
      isExternal: false,
    })
    expect(sanitizeLegalHref('')).toEqual({
      safe: undefined,
      isExternal: false,
    })
  })
})
