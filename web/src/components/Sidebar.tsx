import { useNavigate } from 'react-router-dom'
import { useApp } from '../contexts/AppContext'
import { useAuth } from '../contexts/AuthContext'

const REPO_URL = 'https://github.com/ishizakahiroshi/manabi-map'
const ISSUE_URL = `${REPO_URL}/issues/new?labels=data-correction&title=%E5%AD%A6%E6%A0%A1%E6%83%85%E5%A0%B1%E3%81%AE%E4%BF%AE%E6%AD%A3%E6%8F%90%E6%A1%88`
const FEEDBACK_URL = `${REPO_URL}/issues/new?labels=feedback&title=%E3%83%95%E3%82%A3%E3%83%BC%E3%83%89%E3%83%90%E3%83%83%E3%82%AF`

interface SidebarProps {
  favCount: number
  noteCount: number
}

export function Sidebar({ favCount, noteCount }: SidebarProps) {
  const { sidebarOpen, setSidebarOpen, setLoginOpen, toast } = useApp()
  const { session, kind, displayName, signOut } = useAuth()
  const navigate = useNavigate()

  const close = () => setSidebarOpen(false)
  const go = (path: string) => {
    close()
    navigate(path)
  }

  const handleLoginButton = () => {
    close()
    setLoginOpen(true)
  }

  const handleSignOut = async () => {
    try {
      await signOut()
      toast('ログアウトしました')
    } catch {
      toast('ログアウトに失敗しました')
    }
    close()
  }

  return (
    <>
      <button
        className={`sb-backdrop ${sidebarOpen ? 'on' : ''}`}
        onClick={close}
        aria-label="メニューを閉じる"
        tabIndex={sidebarOpen ? 0 : -1}
      />
      <aside className={`sidebar ${sidebarOpen ? 'on' : ''}`} aria-hidden={!sidebarOpen}>
        <div className="sb-head">
          <button className="icon-btn" onClick={close} aria-label="閉じる">
            ×
          </button>
          <div className="brand">Manabi Map</div>
        </div>
        <div className="sb-body">
          <div className="sb-user">
            <div className="sb-avatar">👤</div>
            <div className="sb-user-info">
              <div className="sb-name">{displayName}</div>
              <div className="sb-stat">
                志望校 {favCount} 件 / 通学メモ {noteCount} 件
              </div>
            </div>
          </div>
          {!session && (
            <button className="sb-login" onClick={handleLoginButton}>
              ログイン / 新規登録
            </button>
          )}
          {kind === 'anon' && (
            <button className="sb-login" onClick={handleLoginButton}>
              💚 LINE 連携でデータを引き継ぐ
            </button>
          )}

          <div className="sb-section">
            <button className="sb-item" onClick={() => go('/map')}>
              <span className="ic">🗺</span>
              <span className="tx">地図</span>
              <span className="arrow">›</span>
            </button>
            <button className="sb-item" onClick={() => go('/favorites')}>
              <span className="ic">★</span>
              <span className="tx">お気に入り</span>
              <span className="badge">{favCount}</span>
            </button>
            <button className="sb-item" onClick={() => go('/')}>
              <span className="ic">🏠</span>
              <span className="tx">自宅の設定</span>
              <span className="arrow">›</span>
            </button>
          </div>

          <div className="sb-section">
            <div className="sb-label">OSS 参加</div>
            <a className="sb-item" href={ISSUE_URL} target="_blank" rel="noreferrer" onClick={close}>
              <span className="ic">✏️</span>
              <span className="tx">学校情報の修正提案</span>
              <span className="arrow">›</span>
            </a>
            <a className="sb-item" href={REPO_URL} target="_blank" rel="noreferrer" onClick={close}>
              <span className="ic">🌐</span>
              <span className="tx">GitHub でデータを編集</span>
              <span className="arrow">›</span>
            </a>
            <button
              className="sb-item"
              onClick={() => {
                close()
                toast('学校詳細シートの「私の記録」から提供できます')
              }}
            >
              <span className="ic">📊</span>
              <span className="tx">偏差値情報を提供する</span>
              <span className="arrow">›</span>
            </button>
          </div>

          <div className="sb-section">
            <div className="sb-label">サービス情報</div>
            <a className="sb-item" href={REPO_URL} target="_blank" rel="noreferrer" onClick={close}>
              <span className="ic">ℹ️</span>
              <span className="tx">このサービスについて</span>
              <span className="arrow">›</span>
            </a>
            <a className="sb-item" href={`${REPO_URL}#readme`} target="_blank" rel="noreferrer" onClick={close}>
              <span className="ic">❓</span>
              <span className="tx">使い方 / ヘルプ</span>
              <span className="arrow">›</span>
            </a>
            <a className="sb-item" href={FEEDBACK_URL} target="_blank" rel="noreferrer" onClick={close}>
              <span className="ic">💬</span>
              <span className="tx">フィードバックを送る</span>
              <span className="arrow">›</span>
            </a>
            <button
              className="sb-item"
              onClick={() => {
                close()
                toast('コード: AGPL-3.0 / データ: CC BY-SA 4.0')
              }}
            >
              <span className="ic">⚖️</span>
              <span className="tx">ライセンス</span>
              <span className="arrow">›</span>
            </button>
          </div>

          <div className="sb-section">
            <div className="sb-label">設定・その他</div>
            <button
              className="sb-item"
              onClick={() => {
                close()
                toast('ブラウザのメニューから「ホーム画面に追加」を選んでください')
              }}
            >
              <span className="ic">📱</span>
              <span className="tx">ホーム画面に追加</span>
              <span className="arrow">›</span>
            </button>
            {session && (
              <button className="sb-item" onClick={() => void handleSignOut()}>
                <span className="ic">🚪</span>
                <span className="tx">ログアウト</span>
                <span className="arrow">›</span>
              </button>
            )}
          </div>

          <div className="sb-footer">
            <div>Manabi Map v0.1.0</div>
            <div className="sb-oss">🌱 Open Source · AGPL-3.0</div>
            <div style={{ marginTop: 4 }}>
              <a href="/legal/privacy" onClick={(e) => { e.preventDefault(); go('/legal/privacy') }}>
                プライバシー
              </a>
              ・
              <a href="/legal/terms" onClick={(e) => { e.preventDefault(); go('/legal/terms') }}>
                利用規約
              </a>
            </div>
          </div>
        </div>
      </aside>
    </>
  )
}
