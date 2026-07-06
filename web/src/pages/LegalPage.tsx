import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Markdown from 'react-markdown'
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
    setBody(null)
    setError(false)
    fetch(`/legal/${doc}.md`)
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status))
        return r.text()
      })
      .then(setBody)
      .catch(() => setError(true))
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
        {body != null && <Markdown>{body}</Markdown>}
      </main>
    </div>
  )
}