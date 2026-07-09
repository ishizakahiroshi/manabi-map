import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useI18n } from '../contexts/I18nContext'

interface Props {
  doc: 'terms' | 'privacy' | 'third-party'
}

/** /legal/*。本文は web/public/legal/*.md を表示する */
export function LegalPage({ doc }: Props) {
  const navigate = useNavigate()
  const { t } = useI18n()
  const [body, setBody] = useState<string | null>(null)
  const [error, setError] = useState(false)

  const title =
    doc === 'terms' ? t('nav.terms') : doc === 'privacy' ? t('nav.privacy') : t('nav.thirdParty')

  useEffect(() => {
    let cancelled = false
    setBody(null)
    setError(false)
    fetch(`/legal/${doc}.md`)
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status))
        return r.text()
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
  }, [doc])

  return (
    <div className="screen">
      <div className="header">
        <button className="icon-btn" onClick={() => navigate(-1)} aria-label={t('common.back')}>
          ←
        </button>
        <div className="brand">{title}</div>
      </div>
      <main id="main-content" className="content legal-content" tabIndex={-1}>
        {error && <div className="error-banner" role="alert">{t('legal.loadFail')}</div>}
        {body == null && !error && <p>{t('common.loading')}</p>}
        {body != null && (
          <Markdown
            remarkPlugins={[remarkGfm]}
            components={{
              a: ({ href, children, ...rest }) => {
                // 第一党 markdown でも javascript: 等を href に通さない多層防御
                const safe =
                  href && /^(https?:|mailto:)/i.test(href) ? href : undefined
                return (
                  <a
                    href={safe}
                    target="_blank"
                    rel="noopener noreferrer"
                    {...rest}
                  >
                    {children}
                  </a>
                )
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