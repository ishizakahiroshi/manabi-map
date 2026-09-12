import { useEffect, useRef, useState } from 'react'
import { getMarkdownRuntime, loadMarkdownRuntime } from '../lib/markdownRuntime'
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
  //
  // 埋め込みは「ビルドした瞬間の値」でしかない。md だけ差し替える運用や
  // HTML が CDN キャッシュに残っている状況では古くなるので、**正典は常に
  // /legal/*.md 側**とし、hydration 後に必ず取り直して上書きする。
  // fetch 失敗時も埋め込みを消さないので、画面が空になることはない。
  const [body, setBody] = useState<string | null>(() => {
    const embedded = getInitialData()?.docMarkdown
    return embedded?.key === `legal/${doc}` ? embedded.text : null
  })
  const [error, setError] = useState(false)
  // 直前に表示していた doc。切り替わったときだけ body をクリアする
  // （初回マウントで埋め込みを setBody(null) するとちらつく）。
  const lastDoc = useRef<string | null>(body != null ? doc : null)
  // Markdown 描画器は初期バンドルから外してある（plan_legal-guide-markdown-split.md）。
  // プリレンダー経路では main.tsx が hydrate 前に読み終えているので、初回 render から使える。
  // 画面内リンクから来た場合だけ null 始まりで、下の effect が読み終えたら再 render する。
  const [markdown, setMarkdown] = useState(() => getMarkdownRuntime())

  useEffect(() => {
    if (markdown) return
    let alive = true
    loadMarkdownRuntime()
      .then((runtime) => {
        if (alive) setMarkdown(runtime)
      })
      .catch(() => {
        if (alive) setError(true)
      })
    return () => {
      alive = false
    }
  }, [markdown])

  const title =
    doc === 'terms'
      ? t('nav.terms')
      : doc === 'privacy'
        ? t('nav.privacy')
        : doc === 'third-party'
          ? t('nav.thirdParty')
          : t('nav.deviationMethodology')

  useEffect(() => {
    const docChanged = lastDoc.current !== doc
    if (docChanged) {
      setBody(null)
      lastDoc.current = doc
    }
    setError(false)
    let cancelled = false
    fetch(`/legal/${doc}.md`)
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status))
        return r.text()
      })
      .then((text) => {
        if (!cancelled) setBody(text)
      })
      .catch(() => {
        // 埋め込みで既に描けている doc の取り直し失敗では画面を潰さない。
        // 何も無い初回（doc 切替直後）だけ error 表示になる。
        if (!cancelled && docChanged) setError(true)
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
        {(body == null || markdown == null) && !error && <p>{t('common.loading')}</p>}
        {body != null && markdown != null && (
          <markdown.Markdown
            remarkPlugins={[markdown.remarkGfm]}
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
          </markdown.Markdown>
        )}
      </main>
    </div>
  )
}
