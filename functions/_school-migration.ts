/** Inactive unless the candidate-only phase binding is explicitly supplied. */
import deploymentTargets from '../web/data/deployment-targets.json' with { type: 'json' }
export type MigrationPhase = 'candidate-rescue' | 'candidate-retired'
export const MIGRATION_INVENTORY = '/school-migration-candidate.json'
export const HIGH_SCHOOL_ORIGIN = deploymentTargets.targets['high-school'].origin
export const COMPATIBILITY_ENDPOINTS = [
  '/api/admin/me', '/api/admin/summary', '/api/admin/referers', '/api/admin/queries',
  '/api/admin/pages', '/api/admin/dims', '/api/admin/coverage', '/api/admin/maintenance', '/api/csp-report',
] as const
const endpointMethods = (path: string) => path === '/api/csp-report' ? ['POST']
  : path === '/api/admin/maintenance' ? ['GET', 'POST'] : ['GET']
const rescuePaths = new Set(['/auth/callback', '/family/join', '/mypage', '/favorites', '/compare', '/dashboard'])
const movablePaths = new Set(['/map', '/search', '/mypage', '/favorites', '/compare', '/dashboard'])
const staticRoute = /^\/(?:school\/[^/]+|schools|pref\/[^/]+(?:\/[^/]+)?|legal\/(?:terms|privacy|third-party|deviation-methodology)|guide\/[^/]+|about|press|data)$/
const hasControl = (value: string, includeSpace = false) => [...value].some((character) => {
  const code = character.codePointAt(0)!
  return code <= (includeSpace ? 32 : 31) || code === 127
})

export function normalizedMigrationPath(path: string): string {
  if (!path.startsWith('/') || path.includes('\\') || /[?#]/.test(path) || hasControl(path, true)) throw new Error('Invalid route path')
  const trimmed = path.replace(/\/$/, '')
  if (!trimmed) return '/'
  return '/' + trimmed.slice(1).split('/').map((segment) => {
    const decoded = decodeURIComponent(segment)
    if (!decoded || decoded === '.' || decoded === '..' || /[/%\\?#]/.test(decoded) || hasControl(decoded, true)) throw new Error('Invalid route segment')
    return encodeURIComponent(decoded)
  }).join('/')
}

export interface MigrationInventory { format: 'synthetic-school-routes'; phase: MigrationPhase; routes: string[]; assets: string[] }
export function validateMigrationInventory(value: unknown, phase: MigrationPhase): MigrationInventory {
  if (phase !== 'candidate-rescue' && phase !== 'candidate-retired') throw new Error('Invalid candidate phase')
  if (!value || typeof value !== 'object') throw new Error('Missing route inventory')
  const input = value as Record<string, unknown>
  if (Object.keys(input).sort().join(',') !== 'assets,format,phase,routes' || input.format !== 'synthetic-school-routes' || input.phase !== phase) throw new Error('Wrong candidate route contract')
  for (const key of ['routes', 'assets'] as const) {
    const values = input[key]
    if (!Array.isArray(values) || values.length > 100000) throw new Error('Invalid route inventory')
    const seen = new Set<string>()
    for (const path of values) {
      if (typeof path !== 'string' || normalizedMigrationPath(path) !== path || seen.has(path)) throw new Error('Invalid or duplicate route')
      if (key === 'routes' && !staticRoute.test(path)) throw new Error('Unsupported HTML route')
      if (key === 'assets' && (/\.html?$/i.test(path) || path.startsWith('/api/') || path.split('/').some((part) => part.startsWith('_')))) throw new Error('Unsupported retained asset')
      seen.add(path)
    }
  }
  return input as unknown as MigrationInventory
}

export type MigrationAction = { kind: 'next' | 'shell' | 'ended' | 'missing' } | { kind: 'method'; allow: string } | { kind: 'redirect'; location: string }
export function schoolMigrationAction(url: URL, method: string, inventory: MigrationInventory): MigrationAction {
  let path: string
  try { path = normalizedMigrationPath(url.pathname) } catch { return { kind: 'missing' } }
  if (url.origin === HIGH_SCHOOL_ORIGIN) return { kind: 'missing' }
  const read = method === 'GET' || method === 'HEAD'
  if (path.startsWith('/api/v1/')) return { kind: 'next' }
  if (path.startsWith('/api/')) {
    if (!(COMPATIBILITY_ENDPOINTS as readonly string[]).includes(path)) return { kind: 'missing' }
    if (inventory.phase === 'candidate-retired') return { kind: 'ended' }
    // Do not normalize endpoint spelling then dispatch to a different route.
    if (url.pathname !== path) return { kind: 'missing' }
    const methods = endpointMethods(path)
    return methods.includes(method) ? { kind: 'next' } : { kind: 'method', allow: methods.join(', ') }
  }
  if (!read) return { kind: 'method', allow: 'GET, HEAD' }
  if (inventory.phase === 'candidate-rescue' && rescuePaths.has(path)) return { kind: 'shell' }
  if (path === '/auth/callback' || path === '/family/join' || path === '/legacy-school' || path === '/school-recovery-ended.html') return { kind: 'ended' }
  if (movablePaths.has(path) || inventory.routes.includes(path)) {
    const target = new URL(path, HIGH_SCHOOL_ORIGIN)
    const keys = path === '/map' ? ['lat', 'lng', 'z', 'school'] : path === '/search' ? ['q'] : []
    for (const key of keys) {
      const values = url.searchParams.getAll(key)
      if (values.length === 1 && values[0].length <= (key === 'q' ? 120 : 128) && !hasControl(values[0])) target.searchParams.set(key, values[0])
    }
    // An explicit empty fragment prevents browsers inheriting an old secret fragment.
    return { kind: 'redirect', location: target.href + '#' }
  }
  if (path === '/' || inventory.assets.includes(path)) return { kind: 'next' }
  return { kind: 'missing' }
}
