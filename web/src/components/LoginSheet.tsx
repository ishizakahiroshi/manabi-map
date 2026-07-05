import { useState } from 'react'
import { useApp } from '../contexts/AppContext'
import { useAuth } from '../contexts/AuthContext'

export function LoginSheet() {
  const { loginOpen, setLoginOpen, toast } = useApp()
  const { kind, signInAnonymous, signInLINE, linkLINE } = useAuth()
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
          志望校の保存・家族への共有には LINE ログインが必要です。
          <br />
          まず試したいだけなら「とりあえず試す」で始められます。
        </p>

        <button className="login-line" onClick={() => void handleLINE()} disabled={busy}>
          <span className="li-icon">💚</span>
          <span className="li-tx">{kind === 'anon' ? 'LINE 連携でデータを引き継ぐ' : 'LINE で続ける'}</span>
        </button>

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
          匿名で始めた場合も、あとから LINE 連携でデータを引き継げます。
        </p>

        <div className="login-v02">
          Google / メール / Instagram / X ログインは <b>v0.2 以降</b>で対応予定。
          要望があれば「フィードバックを送る」から教えてください。
        </div>
      </div>
    </div>
  )
}
