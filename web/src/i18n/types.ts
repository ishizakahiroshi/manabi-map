export type Locale = 'ja' | 'en'

export const LOCALE_STORAGE_KEY = 'manabi-map-locale'

export const DEFAULT_LOCALE: Locale = 'ja'

/** Nested message tree. Leaf values are template strings with `{var}` placeholders. */
export type MessageTree = { [key: string]: string | MessageTree }