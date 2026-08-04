import { useEffect, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { GUIDE_BY_SLUG } from '../lib/guides'
import { useI18n } from '../contexts/I18nContext'
import { useGoBack } from '../hooks/useGoBack'
import { NotFoundPage } from './NotFoundPage'

interface Props {
  slug: string
}

/** /guide/:slug。本文は public/guide/*.md に置き、静的生成側も同じファイルを HTML 化する。 */
export function GuidePage({ slug }: Props) {
  const goBack = useGoBack('/')
  const { t } = useI18n()
  const guide = GUIDE_BY_SLUG.get(slug)
  const [body, setBody] = useState<string | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    if (!guide) return
    let cancelled = false
    setBody(null)
    setError(false)
    fetch(`/guide/${guide.slug}.md`)
      .then((response) => {
        if (!response.ok) throw new Error(String(response.status))
        return response.text()
      })
      .then((text) => {
        if (!cancelled) setBody(text)
      })
      .catch(() => {
        if (!cancelled) setError(true)
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
        <div className="brand">{t('footer.guide')}</div>
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
