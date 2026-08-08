/** Normalize the trailing slash difference between static files and browser URLs. */
export function normalizePrerenderRoute(path: string): string {
  return path.replace(/\/+$/, '') || '/'
}

export function isPrerenderedForRoute(prerenderedFor: string | undefined, currentPath: string): boolean {
  if (!prerenderedFor) return false
  return normalizePrerenderRoute(prerenderedFor) === normalizePrerenderRoute(currentPath)
}
