import { useEffect, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import siteFooterLinks from '../../data/site-footer-links.json'
import { GUIDE_BY_SLUG } from '../lib/guides'
import { useI18n } from '../contexts/I18nContext'
import { useGoBack } from '../hooks/useGoBack'
import { getInitialData } from '../lib/initialData'
import { NotFoundPage } from './NotFoundPage'

interface Props {
  slug: string
}

/** /guide/:slug。本文は public/guide/*.md に置き、静的生成側も同じファイルを HTML 化する。 */
export function GuidePage({ slug }: Props) {
  const goBack = useGoBack('/')
  const { locale, t } = useI18n()
  const guide = GUIDE_BY_SLUG.get(slug)
  const guideLabel = siteFooterLinks.links.find((link) => link.path === '/guide/school-visit')?.[locale] ?? ''
  // プリレンダーが埋め込んだ本文があれば初回 render から使う（plan_ssr-hydration.md）。
  // 埋め込みはビルド時点の値なので、正典は常に /guide/*.md。hydration 後に取り直す。
  // fetch 失敗時も埋め込みを消さないので、画面が空になることはない。
  const [body, setBody] = useState<string | null>(() => getInitialData()?.docMarkdown ?? null)
  const [error, setError] = useState(false)
  // 直前に表示していた slug。切り替わったときだけ body をクリアする
  // （初回マウントで埋め込みを setBody(null) するとちらつく）。
  const lastSlug = useRef<string | null>(body != null ? slug : null)

  useEffect(() => {
    if (!guide) return
    const slugChanged = lastSlug.current !== guide.slug
    if (slugChanged) {
      setBody(null)
      lastSlug.current = guide.slug
    }
    setError(false)
    let cancelled = false
    fetch(`/guide/${guide.slug}.md`)
      .then((response) => {
        if (!response.ok) throw new Error(String(response.status))
        return response.text()
      })
      .then((text) => {
        if (!cancelled) setBody(text)
      })
      .catch(() => {
        // 埋め込みで既に描けている slug の取り直し失敗では画面を潰さない。
        // 何も無い初回（slug 切替直後）だけ error 表示になる。
        if (!cancelled && slugChanged) setError(true)
      })
    return () => {
      cancelled = true
    }
  }, [guide])

  if (!guide) return <NotFoundPage />

  return (
    <div className="screen">
      <div className="header">
        <button className="icon-btn" onClick={goBack} aria-label={t('common.back')}>
          ←
        </button>
        <div className="brand">{guideLabel}</div>
      </div>
      <main id="main-content" className="content legal-content" tabIndex={-1}>
        {error && <div className="error-banner" role="alert">{t('guide.loadFail')}</div>}
        {body == null && !error && <p>{t('common.loading')}</p>}
        {body != null && (
          <Markdown
            remarkPlugins={[remarkGfm]}
            components={{
              a: ({ href, children, ...rest }) => {
                const safe = href && /^(https?:|mailto:|\/)/i.test(href) ? href : undefined
                return <a href={safe} {...rest}>{children}</a>
              },
            }}
          >
            {body}
          </Markdown>
        )}
      </main>
    </div>
  )
}
