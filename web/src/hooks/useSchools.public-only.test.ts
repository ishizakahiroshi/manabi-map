import { afterEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ database: vi.fn(() => { throw new Error('School DB reads are forbidden') }) }))
vi.mock('../lib/supabase', () => ({ supabase: { from: mocks.database } }))

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.resetModules()
  mocks.database.mockClear()
})

it('uses only the published map even if an obsolete Supabase source setting remains', async () => {
  vi.stubEnv('VITE_SCHOOLS_SOURCE', 'supabase')
  const fetch = vi.fn(async (url: string) => {
    if (url === '/schools-manifest.json') return Response.json({ mapUrl: '/schools-map-a1b2.json' })
    if (url === '/schools-map-a1b2.json') return Response.json([])
    throw new Error('Unexpected public request')
  })
  vi.stubGlobal('fetch', fetch)
  const { ensureSchoolsLoaded } = await import('./useSchools')
  await ensureSchoolsLoaded()
  await ensureSchoolsLoaded()
  expect(fetch.mock.calls.map(([url]) => url)).toEqual(['/schools-manifest.json', '/schools-map-a1b2.json'])
  expect(mocks.database).not.toHaveBeenCalled()
})

it('does not fall back to school DB tables when static delivery fails', async () => {
  vi.stubEnv('VITE_SCHOOLS_SOURCE', 'supabase')
  const fetch = vi.fn(async () => new Response('', { status: 503 }))
  vi.stubGlobal('fetch', fetch)
  const { ensureSchoolsLoaded } = await import('./useSchools')
  await ensureSchoolsLoaded()
  expect(fetch.mock.calls).toHaveLength(2)
  expect(mocks.database).not.toHaveBeenCalled()
})
