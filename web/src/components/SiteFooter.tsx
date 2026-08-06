import siteFooterLinks from '../../data/site-footer-links.json'
import { useNavigate } from 'react-router-dom'
import { useI18n } from '../contexts/I18nContext'

/**
 * サイト共通フッター（トップ・一覧ハブ・404 用）。
 * リンク定義の実体は web/data/site-footer-links.json。ここに直接足さない。
 */
export function SiteFooter() {
  const navigate = useNavigate()
  const { locale, t } = useI18n()
  const links = siteFooterLinks.links.map((link) => [link.path, link[locale]] as const)
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
      </nav>
    </footer>
  )
}
