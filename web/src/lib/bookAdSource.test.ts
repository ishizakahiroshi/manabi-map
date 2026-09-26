import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchBookAdCatalog } from './bookAdSource'
import { BOOK_AD_MAX_BYTES } from './bookAdCatalog'
import { syntheticBookAd as ad } from './bookAdCatalog.fixture'

const catalog = { version: 1, enabled: true, ads: [ad] }
const signal = new AbortController().signal
afterEach(() => vi.unstubAllGlobals())

describe('public static book ad source', () => {
  it.each(['text/plain; charset=utf-8', 'application/json'])('accepts %s and preserves the validated catalog', async contentType => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(catalog), { headers: { 'content-type': contentType } }))
    vi.stubGlobal('fetch', fetcher)
    expect(await fetchBookAdCatalog('10', signal, 'https://data.example/book-ads/')).toEqual(catalog)
    expect(fetcher).toHaveBeenCalledWith('https://data.example/book-ads/10.json', { signal, cache: 'no-store', credentials: 'omit' })
  })
  it.each([
    new Response(JSON.stringify(catalog), { status: 404 }),
    new Response(JSON.stringify(catalog), { headers: { 'content-type': 'text/html' } }),
    new Response('<html>Unavailable</html>', { headers: { 'content-type': 'text/plain' } }),
    new Response(JSON.stringify({ ...catalog, version: 2 })),
    new Response('{}', { headers: { 'content-length': String(BOOK_AD_MAX_BYTES + 1) } }),
    new Response(' '.repeat(BOOK_AD_MAX_BYTES + 1)),
  ])('rejects unavailable, invalid or oversized responses', async response => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response))
    await expect(fetchBookAdCatalog('10', signal)).rejects.toThrow()
  })
  it('rejects network errors and invalid prefectures without requesting arbitrary paths', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('Network unavailable'))
    vi.stubGlobal('fetch', fetcher)
    await expect(fetchBookAdCatalog('../10', signal)).rejects.toThrow('Invalid prefecture')
    expect(fetcher).not.toHaveBeenCalled()
    await expect(fetchBookAdCatalog('10', signal)).rejects.toThrow('Network unavailable')
  })
})
