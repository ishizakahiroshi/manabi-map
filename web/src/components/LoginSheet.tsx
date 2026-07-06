import { useState } from 'react'
import { useApp } from '../contexts/AppContext'
import { useAuth } from '../contexts/AuthContext'

export function LoginSheet() {
  const { loginOpen, setLoginOpen, toast } = useApp()
  const { kind, signInAnonymous, signInLINE, signInGoogle, linkLINE, linkGoogle } = useAuth()
  const [busy, setBusy] = useState(false)

  const handleLINE = async () => {
    setBusy(true)
    try {
      // 匿名ユーザーは linkIdentity でデータを引き継ぐ（§13.3.6）
      if (kind === 'anon') await linkLINE()
      else await signInLINE()
      // OAuth リダイレクトに遷移するのでここには通常戻らない
    } catch {
      toast('LINE ログインを開始できませんでした')
      setBusy(false)
    }
  }

  const handleGoogle = async () => {
    setBusy(true)
    try {
      // 匿名ユーザーは linkIdentity でデータを引き継ぐ（LINE と同じ流儀）
      if (kind === 'anon') await linkGoogle()
      else await signInGoogle()
      // OAuth リダイレクトに遷移するのでここには通常戻らない
    } catch {
      toast('Google ログインを開始できませんでした')
      setBusy(false)
    }
  }

  const handleAnonymous = async () => {
    setBusy(true)
    try {
      await signInAnonymous()
      setLoginOpen(false)
      toast('ゲストとして始めます')
    } catch {
      toast('匿名ログインに失敗しました。通信環境を確認してください')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={`sheet auto ${loginOpen ? '' : 'hidden'}`} aria-hidden={!loginOpen}>
      <button className="handle" onClick={() => setLoginOpen(false)} aria-label="閉じる" />
      <div className="head">
        <span className="grow">
          <h3 className="detail-title">Manabi Map にログイン</h3>
        </span>
        <button className="sheet-close" onClick={() => setLoginOpen(false)} aria-label="閉じる">
          ×
        </button>
      </div>
      <div className="body">
        <p className="login-note">
          志望校の保存・家族への共有には LINE または Google ログインが必要です。
          <br />
          まず試したいだけなら「とりあえず試す」で始められます。
        </p>

        <button className="login-line" onClick={() => void handleLINE()} disabled={busy}>
          <span className="li-icon">💚</span>
          <span className="li-tx">{kind === 'anon' ? 'LINE 連携でデータを引き継ぐ' : 'LINE で続ける'}</span>
        </button>

        <button className="login-google" onClick={() => void handleGoogle()} disabled={busy}>
          <span className="li-icon" aria-hidden="true">
            {/* Google "G" ロゴ（ブランドガイドライン準拠の 4 色） */}
            <svg width="20" height="20" viewBox="0 0 48 48" role="img" aria-label="Google">
              <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
              <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
              <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
              <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
            </svg>
          </span>
          <span className="li-tx">{kind === 'anon' ? 'Google 連携でデータを引き継ぐ' : 'Google でログイン'}</span>
        </button>

        <p className="login-caution">
          2 回目以降は前回と同じ方法でログインしてください（方法が違うと別のデータになります）。
        </p>

        {kind !== 'anon' && (
          <>
            <div className="divider">または</div>
            <button className="login-anon" onClick={() => void handleAnonymous()} disabled={busy}>
              <span className="li-icon">👻</span>
              <span className="li-tx">とりあえず試す（匿名）</span>
            </button>
          </>
        )}

        <p className="login-small">
          ログインするとお気に入り・メモ・自宅住所が家族デバイスで共有できます。
          <br />
          匿名で始めた場合も、あとから LINE / Google 連携でデータを引き継げます。
        </p>

        <div className="login-v02">
          メール / Instagram / X ログインは <b>今後</b>対応予定。
          要望があれば「フィードバックを送る」から教えてください。
        </div>
      </div>
    </div>
  )
}
