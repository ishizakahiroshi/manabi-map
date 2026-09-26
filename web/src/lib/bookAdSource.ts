import source from '../../data/book-ads-source.json'
import { BOOK_AD_MAX_BYTES, isPrefectureCode, parseBookAdCatalog } from './bookAdCatalog'
import type { BookAdCatalog } from './bookAdCatalog'

/** Public static JSON; the data branch is published separately from the application. */
export async function fetchBookAdCatalog(
  code: string,
  signal: AbortSignal,
  baseUrl = import.meta.env.VITE_BOOK_ADS_BASE_URL || source.baseUrl,
): Promise<BookAdCatalog> {
  if (!isPrefectureCode(code)) throw new Error('Invalid prefecture')
  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/${code}.json`, {
    signal, cache: 'no-store', credentials: 'omit',
  })
  // GitHub Raw serves JSON as text/plain. Still reject HTML fallback/error pages.
  const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
  if (!response.ok || !['application/json', 'text/plain'].includes(contentType ?? '')) throw new Error('Unavailable')
  if (Number(response.headers.get('content-length')) > BOOK_AD_MAX_BYTES) throw new Error('Too large')
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Empty response')
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > BOOK_AD_MAX_BYTES) { await reader.cancel(); throw new Error('Too large') }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return parseBookAdCatalog(JSON.parse(new TextDecoder().decode(bytes)))
}
