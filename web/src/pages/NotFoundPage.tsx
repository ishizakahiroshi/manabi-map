import { useNavigate } from 'react-router-dom'
import { useI18n } from '../contexts/I18nContext'
import { SiteFooter } from '../components/SiteFooter'

/**
 * クライアント側の catch-all 404。
 * 直リンクの未知 URL は Cloudflare Pages が dist/404.html（HTTP 404）を返し、
 * その上で本コンポーネントが同じ内容を描画する（plan_seo-growth-strategy_c5 C4）。
 */
export function NotFoundPage() {
  const navigate = useNavigate()
  const { t } = useI18n()
  return (
    <div className="screen">
      <div className="header">
        <button className="icon-btn" onClick={() => navigate('/')} aria-label={t('common.home')}>
          ←
        </button>
        <div className="brand">{t('notFound.title')}</div>
      </div>
      <main id="main-content" className="content legal-content" tabIndex={-1}>
        <h1>{t('notFound.title')}</h1>
        <p>{t('notFound.body')}</p>
        <p>
          <a
            href="/"
            onClick={(e) => {
              e.preventDefault()
              navigate('/')
            }}
          >
            {t('notFound.toTop')}
          </a>
          {' ／ '}
          <a
            href="/schools/"
            onClick={(e) => {
              e.preventDefault()
              navigate('/schools')
            }}
          >
            {t('notFound.toSchools')}
          </a>
        </p>
        <SiteFooter />
      </main>
    </div>
  )
}
