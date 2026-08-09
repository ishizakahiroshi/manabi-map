import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { createTranslator } from '../i18n/resolve'
import {
  DEFAULT_LOCALE,
  LOCALE_STORAGE_KEY,
  type Locale,
} from '../i18n/types'

export type TFunction = (key: string, vars?: Record<string, string | number>) => string

interface I18nContextValue {
  locale: Locale
  setLocale: (locale: Locale) => void
  t: TFunction
}

const I18nContext = createContext<I18nContextValue | null>(null)

function readStoredLocale(): Locale {
  try {
    const raw = localStorage.getItem(LOCALE_STORAGE_KEY)
    if (raw === 'en' || raw === 'ja') return raw
  } catch {
    /* localStorage unavailable */
  }
  return DEFAULT_LOCALE
}

export function I18nProvider({ children }: { children: ReactNode }) {
  // 初回 render は必ず DEFAULT_LOCALE にする。localStorage を初期値に使うと、
  // ビルド時プリレンダー（常に既定言語）と食い違って hydration が壊れ、
  // React がツリーを描き直す＝ちらつきが形を変えて戻る（plan_ssr-hydration.md C2）。
  const [locale, setLocaleState] = useState<Locale>(DEFAULT_LOCALE)

  // hydration 後に保存済みの言語へ戻す。同値なら React が bail out するので再描画は起きない。
  useEffect(() => {
    setLocaleState(readStoredLocale())
  }, [])

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next)
    try {
      localStorage.setItem(LOCALE_STORAGE_KEY, next)
    } catch {
      /* noop */
    }
  }, [])

  useEffect(() => {
    document.documentElement.lang = locale === 'en' ? 'en' : 'ja'
  }, [locale])

  const value = useMemo<I18nContextValue>(
    () => ({
      locale,
      setLocale,
      t: createTranslator(locale),
    }),
    [locale, setLocale],
  )

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext)
  if (!ctx) throw new Error('useI18n must be used within I18nProvider')
  return ctx
}

/** For class components / error boundary outside the provider tree edge. */
export function getStaticT(): TFunction {
  return createTranslator(readStoredLocale())
}