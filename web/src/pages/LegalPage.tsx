import { useEffect, useRef, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useI18n } from '../contexts/I18nContext'
import { useGoBack } from '../hooks/useGoBack'
import { getInitialData } from '../lib/initialData'

interface Props {
  doc: 'terms' | 'privacy' | 'third-party' | 'deviation-methodology'
}

/** /legal/*。本文は web/public/legal/*.md を表示する */
export function LegalPage({ doc }: Props) {
  const goBack = useGoBack('/')
  const { t } = useI18n()
  // プリレンダーが埋め込んだ本文があれば初回 render から使う。
  // null 始まりにするとプリレンダー（本文あり）と食い違って hydration が壊れる
  // （plan_ssr-hydration.md）。
  const [body, setBody] = useState<string | null>(() => getInitialData()?.docMarkdown ?? null)
  const [error, setError] = useState(false)
  // 本文が揃っている doc。body を effect の依存に入れるとループするので ref で持つ。
  const settledDoc = useRef<string | null>(body != null ? doc : null)

  const title =
    doc === 'terms'
      ? t('nav.terms')
      : doc === 'privacy'
        ? t('nav.privacy')
        : doc === 'third-party'
          ? t('nav.thirdParty')
          : t('nav.deviationMethodology')

  useEffect(() => {
    // 埋め込み本文で既に描けている doc は取りに行かない。
    if (settledDoc.current === doc) return
    let cancelled = false
    setBody(null)
    setError(false)
    fetch(`/legal/${doc}.md`)
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status))
        return r.text()
      })
      .then((text) => {
        if (!cancelled) {
          settledDoc.current = doc
          setBody(text)
        }
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
        <button className="icon-btn" onClick={goBack} aria-label={t('common.back')}>
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
