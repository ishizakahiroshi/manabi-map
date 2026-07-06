import type { Locale, MessageTree } from './types'
import { en } from './en'
import { ja } from './ja'

const CATALOG: Record<Locale, MessageTree> = { ja, en }

export function getCatalog(locale: Locale): MessageTree {
  return CATALOG[locale] ?? CATALOG.ja
}

export function resolveMessage(tree: MessageTree, key: string): string | undefined {
  const parts = key.split('.')
  let cur: unknown = tree
  for (const part of parts) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return typeof cur === 'string' ? cur : undefined
}

export function formatMessage(
  template: string,
  vars?: Record<string, string | number>,
): string {
  if (!vars) return template
  return Object.entries(vars).reduce(
    (text, [k, v]) => text.replaceAll(`{${k}}`, String(v)),
    template,
  )
}

export function createTranslator(locale: Locale) {
  const tree = getCatalog(locale)
  return function t(key: string, vars?: Record<string, string | number>): string {
    const raw = resolveMessage(tree, key)
    if (raw == null) return key
    return formatMessage(raw, vars)
  }
}