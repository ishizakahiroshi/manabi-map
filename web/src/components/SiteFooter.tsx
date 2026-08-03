import { useNavigate } from 'react-router-dom'
import { useI18n } from '../contexts/I18nContext'

/**
 * サイト共通フッター（トップ・一覧ハブ・404 用）。
 * プリレンダー版（scripts/gen-seo-pages.mjs の FOOTER_HTML）と項目を一致させること。
 * /guide/ はガイド公開（plan_seo-citation-assets C3）まで枠のみ確保し、リンクにしない。
 */
export function SiteFooter() {
  const navigate = useNavigate()
  const { t } = useI18n()
  const links: Array<[string, string]> = [
    ['/press', t('footer.press')],
    ['/legal/terms', t('nav.terms')],
    ['/legal/privacy', t('footer.privacy')],
    ['/legal/deviation-methodology', t('nav.deviationMethodology')],
    ['/legal/third-party', t('nav.thirdParty')],
  ]
  return (
    <footer className="site-footer">
      <nav aria-label={t('footer.navLabel')}>
        {links.map(([path, label]) => (
          <a
            key={path}
            href={`${path}/`}
            onClick={(e) => {
              e.preventDefault()
              navigate(path)
            }}
          >
            {label}
          </a>
        ))}
        <span className="site-footer-soon">{t('footer.guidePreparing')}</span>
      </nav>
    </footer>
  )
}
