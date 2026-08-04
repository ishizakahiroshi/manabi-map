import { Suspense, lazy, useMemo } from 'react'
import { Navigate, Routes, Route, useNavigate, useLocation } from 'react-router-dom'
import { useApp } from './contexts/AppContext'
import { useAuth } from './contexts/AuthContext'
import { useI18n } from './contexts/I18nContext'
import { useUserData } from './hooks/useUserData'
import { HomePage } from './pages/HomePage'
import { SchoolDetailPage } from './pages/SchoolDetailPage'
import { SchoolSearchPage } from './pages/SchoolSearchPage'
import { FavoritesPage } from './pages/FavoritesPage'
import { ComparePage } from './pages/ComparePage'
import { AuthCallbackPage } from './pages/AuthCallbackPage'
import { FamilyJoinPage } from './pages/FamilyJoinPage'
import { LegalPage } from './pages/LegalPage'
import { GuidePage } from './pages/GuidePage'
import { PressPage } from './pages/PressPage'
import { MyPage } from './pages/MyPage'
import { SchoolsHubPage } from './pages/SchoolsHubPage'
import { PrefecturePage } from './pages/PrefecturePage'
import { NotFoundPage } from './pages/NotFoundPage'
import { Sidebar } from './components/Sidebar'
import { LoginSheet } from './components/LoginSheet'
import { Toast } from './components/Toast'
import { OfflineBanner } from './components/OfflineBanner'
import { MaintenanceBanner } from './components/MaintenanceBanner'
import { BottomTabBar } from './components/BottomTabBar'
import { DashboardPage } from './pages/DashboardPage'
import { useIsAdmin } from './hooks/useIsAdmin'

// 地図（Leaflet + markercluster）は初期バンドルから分離し、/map を開いたときだけ
// 動的 import する（plan_seo-growth-strategy_c7 C3。protomaps-leaflet の動的 import と
// 同じ手法のルート単位版）。学校詳細ページ（/school/:id）は Leaflet 非依存で初期描画する。
const MapPage = lazy(() =>
  import('./pages/MapPage').then((module) => ({ default: module.MapPage })),
)

function DashboardRoute({ isAdmin, checking }: { isAdmin: boolean; checking: boolean }) {
  // 管理者照会が終わるまで待つ。先に redirect すると、正規管理者が
  // セッション復元直後にトップへ飛ばされる競合が起きる。
  if (checking) return <main id="main-content" className="page" aria-busy="true" />
  return isAdmin ? <DashboardPage /> : <Navigate to="/" replace />
}

export default function App() {
  const navigate = useNavigate()
  const location = useLocation()
  const { setSidebarOpen, setLoginOpen } = useApp()
  const { session, kind } = useAuth()
  const { t } = useI18n()
  const userData = useUserData()
  const { isAdmin, checking: checkingAdmin } = useIsAdmin()

  const favCount = Object.keys(userData.favorites).length
  const noteCount = useMemo(
    () => Object.values(userData.notes).filter((n) => n.note || n.commute_note).length,
    [userData.notes],
  )

  // Cloudflare Pages はディレクトリ配信の URL を末尾スラッシュへ 308 する（/press → /press/）ため、
  // 末尾スラッシュを吸収してから経路判定する
  const path = location.pathname.replace(/\/+$/, '') || '/'
  const isHome = path === '/'
  const showBottomTabs = !(
    path === '/auth/callback' ||
    path === '/family/join' ||
    path.startsWith('/legal/') ||
    path.startsWith('/guide/') ||
    path === '/press'
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
            <div className="brand">{t('common.brand')}</div>
            <button
              className="icon-btn"
              onClick={() => (session && kind !== 'anon' ? navigate('/favorites') : setLoginOpen(true))}
              aria-label={session && kind !== 'anon' ? t('header.favList') : t('header.loginBtn')}
            >
              <span className="header-fav-icon" aria-hidden="true">★</span>
            </button>
          </div>
        )}

        <Suspense fallback={<main id="main-content" className="page" aria-busy="true" />}>
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/map" element={<MapPage userData={userData} />} />
          <Route path="/search" element={<SchoolSearchPage />} />
          <Route path="/school/:id" element={<SchoolDetailPage userData={userData} />} />
          <Route path="/favorites" element={<FavoritesPage userData={userData} />} />
          <Route path="/compare" element={<ComparePage userData={userData} />} />
          <Route path="/mypage" element={<MyPage userData={userData} favCount={favCount} noteCount={noteCount} />} />
          <Route path="/auth/callback" element={<AuthCallbackPage />} />
          <Route path="/family/join" element={<FamilyJoinPage />} />
          <Route path="/legal/terms" element={<LegalPage doc="terms" />} />
          <Route path="/legal/privacy" element={<LegalPage doc="privacy" />} />
          <Route path="/legal/third-party" element={<LegalPage doc="third-party" />} />
          <Route path="/legal/deviation-methodology" element={<LegalPage doc="deviation-methodology" />} />
          <Route path="/guide/:slug" element={<GuideRoute />} />
          <Route path="/press" element={<PressPage />} />
          <Route path="/schools" element={<SchoolsHubPage />} />
          <Route path="/pref/:pref" element={<PrefecturePage userData={userData} />} />
          <Route path="/dashboard" element={<DashboardRoute isAdmin={isAdmin} checking={checkingAdmin} />} />
          {/* 未知の URL への SPA 内遷移。直リンクは Cloudflare Pages が dist/404.html を返す */}
          <Route path="*" element={<NotFoundPage />} />
        </Routes>
        </Suspense>

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

function GuideRoute() {
  const location = useLocation()
  const slug = location.pathname.replace(/\/+$/, '').split('/').at(-1) ?? ''
  return <GuidePage slug={slug} />
}
