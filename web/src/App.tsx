import { useMemo } from 'react'
import { Routes, Route, useNavigate, useLocation } from 'react-router-dom'
import { useApp } from './contexts/AppContext'
import { useAuth } from './contexts/AuthContext'
import { useI18n } from './contexts/I18nContext'
import { useUserData } from './hooks/useUserData'
import { HomePage } from './pages/HomePage'
import { MapPage } from './pages/MapPage'
import { SchoolSearchPage } from './pages/SchoolSearchPage'
import { FavoritesPage } from './pages/FavoritesPage'
import { ComparePage } from './pages/ComparePage'
import { AuthCallbackPage } from './pages/AuthCallbackPage'
import { FamilyJoinPage } from './pages/FamilyJoinPage'
import { LegalPage } from './pages/LegalPage'
import { MyPage } from './pages/MyPage'
import { Sidebar } from './components/Sidebar'
import { LoginSheet } from './components/LoginSheet'
import { Toast } from './components/Toast'
import { OfflineBanner } from './components/OfflineBanner'
import { MaintenanceBanner } from './components/MaintenanceBanner'
import { BottomTabBar } from './components/BottomTabBar'
import { DashboardPage } from './pages/DashboardPage'
import { useIsAdmin } from './hooks/useIsAdmin'

export default function App() {
  const navigate = useNavigate()
  const location = useLocation()
  const { setSidebarOpen, setLoginOpen } = useApp()
  const { session, kind } = useAuth()
  const { t } = useI18n()
  const userData = useUserData()
  const isAdmin = useIsAdmin()

  const favCount = Object.keys(userData.favorites).length
  const noteCount = useMemo(
    () => Object.values(userData.notes).filter((n) => n.note || n.commute_note).length,
    [userData.notes],
  )

  const isHome = location.pathname === '/'
  const showBottomTabs = !(
    location.pathname === '/auth/callback' ||
    location.pathname === '/family/join' ||
    location.pathname.startsWith('/legal/')
  )

  return (
    <div className="stage">
      <div className="phone">
        <a className="skip-link" href="#main-content">
          {t('common.skipToContent')}
        </a>

        {isHome && (
          <div className="header">
            <button className="icon-btn" onClick={() => setSidebarOpen(true)} aria-label={t('common.menu')}>
              ≡
            </button>
            <img className="brand-icon" src="/brand-mark.svg" alt="" aria-hidden="true" />
            <div className="brand">Manabi Map</div>
            <button
              className="icon-btn"
              onClick={() => (session && kind !== 'anon' ? navigate('/favorites') : setLoginOpen(true))}
              aria-label={session && kind !== 'anon' ? t('header.favList') : t('header.loginBtn')}
            >
              <span className="header-fav-icon" aria-hidden="true">★</span>
            </button>
          </div>
        )}

        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/map" element={<MapPage userData={userData} />} />
          <Route path="/search" element={<SchoolSearchPage />} />
          <Route path="/school/:id" element={<MapPage userData={userData} />} />
          <Route path="/favorites" element={<FavoritesPage userData={userData} />} />
          <Route path="/compare" element={<ComparePage userData={userData} />} />
          <Route path="/mypage" element={<MyPage userData={userData} favCount={favCount} noteCount={noteCount} />} />
          <Route path="/auth/callback" element={<AuthCallbackPage />} />
          <Route path="/family/join" element={<FamilyJoinPage />} />
          <Route path="/legal/terms" element={<LegalPage doc="terms" />} />
          <Route path="/legal/privacy" element={<LegalPage doc="privacy" />} />
          <Route path="/legal/third-party" element={<LegalPage doc="third-party" />} />
          <Route path="/dashboard" element={isAdmin ? <DashboardPage /> : <main id="main-content" className="page"><h1>ページが見つかりません</h1></main>} />
        </Routes>

        {showBottomTabs && <BottomTabBar />}
        <Sidebar favCount={favCount} noteCount={noteCount} isAdmin={isAdmin} />
        <LoginSheet />
        <MaintenanceBanner />
        <OfflineBanner />
        <Toast />
      </div>
    </div>
  )
}
