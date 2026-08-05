import { useRef, useState } from 'react'
import { useApp } from '../contexts/AppContext'
import { useAuth } from '../contexts/AuthContext'
import { useI18n } from '../contexts/I18nContext'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { useEscapeKey } from '../hooks/useEscapeKey'
import { OAuthButton } from './OAuthButton'

export function LoginSheet() {
  const { loginOpen, setLoginOpen, toast } = useApp()
  const { kind, signInAnonymous, signInLINE, signInGoogle, linkLINE, linkGoogle } = useAuth()
  const { t } = useI18n()
  const [busy, setBusy] = useState(false)
  const sheetRef = useRef<HTMLDivElement>(null)

  useFocusTrap(sheetRef, loginOpen)
  useEscapeKey(() => setLoginOpen(false), loginOpen)

  const handleLINE = async () => {
    setBusy(true)
    try {
      if (kind === 'anon') await linkLINE()
      else await signInLINE()
    } catch {
      toast(t('login.lineFail'))
      setBusy(false)
    }
  }

  const handleGoogle = async () => {
    setBusy(true)
    try {
      if (kind === 'anon') await linkGoogle()
      else await signInGoogle()
    } catch {
      toast(t('login.googleFail'))
      setBusy(false)
    }
  }

  const handleAnonymous = async () => {
    setBusy(true)
    try {
      await signInAnonymous()
      setLoginOpen(false)
      toast(t('login.anonStart'))
    } catch {
      toast(t('login.anonFail'))
    } finally {
      setBusy(false)
    }
  }

  if (!loginOpen) return null

  return (
    <div
      ref={sheetRef}
      className="sheet auto"
      role="dialog"
      aria-modal="true"
      aria-labelledby="login-sheet-title"
    >
      <button className="handle" onClick={() => setLoginOpen(false)} aria-label={t('common.close')} />
      <div className="head">
        <span className="grow">
          <h3 className="detail-title" id="login-sheet-title">
            {t('login.title')}
          </h3>
        </span>
        <button className="sheet-close" onClick={() => setLoginOpen(false)} aria-label={t('common.close')}>
          ×
        </button>
      </div>
      <div className="body">
        <p className="login-note">
          {t('login.note')}
          <br />
          {t('login.noteAnon')}
        </p>

        <OAuthButton
          provider="line"
          label={kind === 'anon' ? t('login.lineLink') : t('login.lineContinue')}
          onClick={() => void handleLINE()}
          disabled={busy}
        />

        <OAuthButton
          provider="google"
          label={kind === 'anon' ? t('login.googleLink') : t('login.googleLogin')}
          onClick={() => void handleGoogle()}
          disabled={busy}
        />

        <p className="login-caution">{t('login.caution')}</p>

        {kind !== 'anon' && (
          <>
            <div className="divider">{t('common.or')}</div>
            <button className="login-anon" onClick={() => void handleAnonymous()} disabled={busy}>
              <span className="li-icon" aria-hidden="true">👻</span>
              <span className="li-tx">{t('login.anon')}</span>
            </button>
          </>
        )}

        <p className="login-small">
          {t('login.footer')}
          <br />
          {t('login.footerAnon')}
        </p>

        <div className="login-v02">{t('login.v02')}</div>
      </div>
    </div>
  )
}
