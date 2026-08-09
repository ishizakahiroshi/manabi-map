import { describe, expect, it } from 'vitest'

import { isPrerenderedForRoute } from './ssrRoute'

describe('SSR route marker', () => {
  it('accepts the static-file trailing slash difference', () => {
    expect(isPrerenderedForRoute('/pref/gunma', '/pref/gunma/')).toBe(true)
  })

  it('rejects a top-page fallback for another SPA route', () => {
    expect(isPrerenderedForRoute('/', '/map')).toBe(false)
  })

  it('rejects an HTML document without a route marker', () => {
    expect(isPrerenderedForRoute(undefined, '/')).toBe(false)
  })
})
