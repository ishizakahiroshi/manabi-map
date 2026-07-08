import { useLocation, useNavigate } from 'react-router-dom'
import { useApp } from '../contexts/AppContext'
import { useI18n } from '../contexts/I18nContext'

export function BottomTabBar() {
  const location = useLocation()
  const navigate = useNavigate()
  const { setSidebarOpen } = useApp()
  const { t } = useI18n()

  const path = location.pathname
  const isMap = path === '/map' || path.startsWith('/school/')
  const isFavorites = path === '/favorites'
  const isMyPage = path === '/mypage'

  return (
    <nav className="bottom-tabs" aria-label={t('tabs.label')}>
      <button
        type="button"
        className={`bottom-tab ${isMap ? 'on' : ''}`}
        aria-current={isMap ? 'page' : undefined}
        onClick={() => navigate('/map')}
      >
        <span aria-hidden="true">🗺</span>
        <b>{t('tabs.map')}</b>
      </button>
      <button
        type="button"
        className={`bottom-tab ${isFavorites ? 'on' : ''}`}
        aria-current={isFavorites ? 'page' : undefined}
        onClick={() => navigate('/favorites')}
      >
        <span aria-hidden="true">★</span>
        <b>{t('tabs.favorites')}</b>
      </button>
      <button
        type="button"
        className={`bottom-tab ${isMyPage ? 'on' : ''}`}
        aria-current={isMyPage ? 'page' : undefined}
        onClick={() => navigate('/mypage')}
      >
        <span aria-hidden="true">👤</span>
        <b>{t('tabs.mypage')}</b>
      </button>
      <button
        type="button"
        className="bottom-tab"
        onClick={() => setSidebarOpen(true)}
      >
        <span aria-hidden="true">☰</span>
        <b>{t('tabs.more')}</b>
      </button>
    </nav>
  )
}
