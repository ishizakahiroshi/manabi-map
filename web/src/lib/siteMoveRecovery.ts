/** Enabled only by the dedicated legacy shell, never by a query parameter. */
export function isLegacySchoolShell(): boolean {
  return typeof document !== 'undefined' && document.querySelector('meta[name="legacy-school-shell"]')?.getAttribute('content') === '1'
}

const RETURN_KEY = 'mm.auth_return_path'
const RETURN_TTL = 10 * 60 * 1000
const paths = new Set(['/family/join', '/mypage'])

/** Keep only a route locally. No token, query, fragment or cross-origin destination. */
export function rememberAuthReturn(pathname: string, storage?: Pick<Storage, 'setItem' | 'removeItem'>, now = Date.now()): void {
  try {
    storage ??= sessionStorage
    const path = pathname.replace(/\/+$/, '')
    if (paths.has(path)) storage.setItem(RETURN_KEY, JSON.stringify({ path, savedAt: now }))
    else storage.removeItem(RETURN_KEY)
  } catch { /* Storage may be unavailable; callback uses its safe default. */ }
}

export function consumeAuthReturn(legacy: boolean, storage?: Pick<Storage, 'getItem' | 'removeItem'>, now = Date.now()): string {
  const fallback = legacy ? '/mypage' : '/'
  try {
    storage ??= sessionStorage
    const raw = storage.getItem(RETURN_KEY)
    storage.removeItem(RETURN_KEY)
    if (!raw) return fallback
    const value = JSON.parse(raw)
    if (paths.has(value.path) && Number.isFinite(value.savedAt) && now >= value.savedAt && now - value.savedAt <= RETURN_TTL) return value.path
  } catch { /* Fail closed to the local school page. */ }
  return fallback
}

export function callbackFailure(search: string, hash: string): { code: string; description: string } | null {
  const query = new URLSearchParams(search)
  const fragment = new URLSearchParams(hash.replace(/^#/, ''))
  const params = query.has('error') || query.has('error_code') ? query : fragment
  const code = params.get('error_code') || params.get('error')
  return code ? { code, description: params.get('error_description') ?? '' } : null
}
