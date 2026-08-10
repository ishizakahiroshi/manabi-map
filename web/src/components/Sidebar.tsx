import { useRef } from 'react'
import siteFooterLinks from '../../data/site-footer-links.json'
import { useNavigate } from 'react-router-dom'
import { useApp } from '../contexts/AppContext'
import { useAuth } from '../contexts/AuthContext'
import { useI18n } from '../contexts/I18nContext'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { useEscapeKey } from '../hooks/useEscapeKey'

const REPO_URL = 'https://github.com/ishizakahiroshi/manabi-map'

interface SidebarProps {
  favCount: number
  noteCount: number
  isAdmin: boolean
}

export function Sidebar({ favCount, noteCount, isAdmin }: SidebarProps) {
  const { sidebarOpen, setSidebarOpen, setLoginOpen, toast } = useApp()
  const { session, kind, displayName, signOut } = useAuth()
  const { t, locale, setLocale } = useI18n()
  const navigate = useNavigate()
  const asideRef = useRef<HTMLElement>(null)

  useFocusTrap(asideRef, sidebarOpen)
  useEscapeKey(() => setSidebarOpen(false), sidebarOpen)

  // サイドバーとフッターは別コンポーネントだが、外向けページの表示名は同じ実体を使う。
  // ラベルの実体は web/data/site-footer-links.json（ここに文字列を直書きしない）。
  const siteLinkLabel = (path: string) =>
    siteFooterLinks.links.find((link) => link.path === path)?.[locale] ?? ''

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
      toast(t('nav.logoutDone'))
    } catch {
      toast(t('nav.logoutFail'))
    }
    close()
  }

  return (
    <>
      <button
        className={`sb-backdrop ${sidebarOpen ? 'on' : ''}`}
        onClick={close}
        aria-label={t('nav.closeMenu')}
        tabIndex={sidebarOpen ? 0 : -1}
        aria-hidden={!sidebarOpen}
      />
      <aside
        ref={asideRef}
        className={`sidebar ${sidebarOpen ? 'on' : ''}`}
        aria-hidden={!sidebarOpen}
        role="dialog"
        aria-modal="true"
        aria-label={t('common.menu')}
      >
        <div className="sb-head">
          <button className="icon-btn" onClick={close} aria-label={t('common.close')}>
            ×
          </button>
          <div className="brand">{t('common.brand')}</div>
        </div>
        <div className="sb-body">
          <div className="sb-user">
            <div className="sb-avatar" aria-hidden="true">👤</div>
            <div className="sb-user-info">
              <div className="sb-name">{displayName}</div>
              <div className="sb-stat">
                {t('nav.favStat', { fav: favCount, note: noteCount })}
              </div>
            </div>
          </div>
          {!session && (
            <button className="sb-login" onClick={handleLoginButton}>
              {t('nav.login')}
            </button>
          )}
          {kind === 'anon' && (
            <button className="sb-login" onClick={handleLoginButton}>
              🔗 {t('nav.linkData')}
            </button>
          )}

          <div className="sb-section">
            <button className="sb-item" onClick={() => go('/mypage')}>
              <span className="ic" aria-hidden="true">👤</span>
              <span className="tx">{t('mypage.title')}</span>
              <span className="arrow" aria-hidden="true">›</span>
            </button>
          </div>
          {isAdmin && <div className="sb-section"><button className="sb-item" onClick={() => go('/dashboard')}><span className="ic" aria-hidden="true">▦</span><span className="tx">管理ダッシュボード</span><span className="arrow" aria-hidden="true">›</span></button></div>}

          <div className="sb-section">
            <div className="sb-label">{t('nav.serviceInfo')}</div>
            <a className="sb-item" href={REPO_URL} target="_blank" rel="noreferrer" onClick={close}>
              <span className="ic" aria-hidden="true">ℹ️</span>
              <span className="tx">{t('nav.about')}</span>
              <span className="arrow" aria-hidden="true">›</span>
            </a>
            <a className="sb-item" href={`${REPO_URL}#readme`} target="_blank" rel="noreferrer" onClick={close}>
              <span className="ic" aria-hidden="true">❓</span>
              <span className="tx">{t('nav.help')}</span>
              <span className="arrow" aria-hidden="true">›</span>
            </a>
            <button className="sb-item" onClick={() => go('/legal/third-party')}>
              <span className="ic" aria-hidden="true">⚖️</span>
              <span className="tx">{t('nav.license')}</span>
              <span className="arrow" aria-hidden="true">›</span>
            </button>
            <button className="sb-item" onClick={() => go('/press')}>
              <span className="ic" aria-hidden="true">📰</span>
              <span className="tx">{siteLinkLabel('/press')}</span>
              <span className="arrow" aria-hidden="true">›</span>
            </button>
            <button className="sb-item" onClick={() => go('/data')}>
              <span className="ic" aria-hidden="true">🗂️</span>
              <span className="tx">{siteLinkLabel('/data')}</span>
              <span className="arrow" aria-hidden="true">›</span>
            </button>
          </div>

          <div className="sb-section">
            <div className="sb-label">{t('nav.settings')}</div>
            <div className="lang-switch" role="group" aria-label={t('common.language')}>
              <button
                type="button"
                className={`chip ${locale === 'ja' ? 'on' : ''}`}
                aria-pressed={locale === 'ja'}
                onClick={() => setLocale('ja')}
              >
                {t('common.japanese')}
              </button>
              <button
                type="button"
                className={`chip ${locale === 'en' ? 'on' : ''}`}
                aria-pressed={locale === 'en'}
                onClick={() => setLocale('en')}
              >
                {t('common.english')}
              </button>
            </div>
            <button
              className="sb-item"
              onClick={() => {
                close()
                toast(t('nav.addToHomeHint'))
              }}
            >
              <span className="ic" aria-hidden="true">📱</span>
              <span className="tx">{t('nav.addToHome')}</span>
              <span className="arrow" aria-hidden="true">›</span>
            </button>
            {session && (
              <button className="sb-item" onClick={() => void handleSignOut()}>
                <span className="ic" aria-hidden="true">🚪</span>
                <span className="tx">{t('nav.logout')}</span>
                <span className="arrow" aria-hidden="true">›</span>
              </button>
            )}
          </div>

          <div className="sb-footer">
            <div>Manabi Map v{__APP_VERSION__}</div>
            <div className="sb-oss">🌱 Open Source · AGPL-3.0</div>
            <div style={{ marginTop: 4 }}>
              <a href="/legal/privacy" onClick={(e) => { e.preventDefault(); go('/legal/privacy') }}>
                {t('nav.privacy')}
              </a>
              ・
              <a href="/legal/terms" onClick={(e) => { e.preventDefault(); go('/legal/terms') }}>
                {t('nav.terms')}
              </a>
              ・
              <a href="/press" onClick={(e) => { e.preventDefault(); go('/press') }}>
                {siteLinkLabel('/press')}
              </a>
            </div>
          </div>
        </div>
      </aside>
    </>
  )
}
