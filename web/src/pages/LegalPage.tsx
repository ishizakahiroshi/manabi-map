import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Markdown from 'react-markdown'

interface Props {
  doc: 'terms' | 'privacy' | 'third-party'
}

const TITLES: Record<Props['doc'], string> = {
  terms: '利用規約',
  privacy: 'プライバシーポリシー',
  'third-party': 'サードパーティライセンス',
}

/** /legal/*。本文は web/public/legal/*.md を表示する */
export function LegalPage({ doc }: Props) {
  const navigate = useNavigate()
  const [body, setBody] = useState<string | null>(null)
  const [error, setError] = useState(false)

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
        <button className="icon-btn" onClick={() => navigate(-1)} aria-label="戻る">
          ←
        </button>
        <div className="brand">{TITLES[doc]}</div>
      </div>
      <div className="content legal-content">
        {error && <div className="error-banner">文書の読み込みに失敗しました。時間をおいて再読み込みしてください。</div>}
        {body == null && !error && <p>読み込み中…</p>}
        {body != null && <Markdown>{body}</Markdown>}
      </div>
    </div>
  )
}
