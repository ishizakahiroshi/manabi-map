import { Suspense, lazy, useMemo } from 'react'
import { Navigate, Routes, Route, useLocation } from 'react-router-dom'
import { useI18n } from './contexts/I18nContext'
import { useUserData } from './hooks/useUserData'
import { HomePage } from './pages/HomePage'
import { SchoolDetailPage } from './pages/SchoolDetailPage'
import { LegalPage } from './pages/LegalPage'
import { GuidePage } from './pages/GuidePage'
import { PressPage } from './pages/PressPage'
import { DataPage } from './pages/DataPage'
import { SchoolsHubPage } from './pages/SchoolsHubPage'
import { PrefecturePage } from './pages/PrefecturePage'
import { CityPage } from './pages/CityPage'
import { NotFoundPage } from './pages/NotFoundPage'
import { Sidebar } from './components/Sidebar'
import { LoginSheet } from './components/LoginSheet'
import { Toast } from './components/Toast'
import { OfflineBanner } from './components/OfflineBanner'
import { MaintenanceBanner } from './components/MaintenanceBanner'
import { BottomTabBar } from './components/BottomTabBar'
import { useIsAdmin } from './hooks/useIsAdmin'

// --- ルート単位の動的 import（plan_data-usage-audit.md C4） ---------------------
//
// **ビルド時にプリレンダーするルートは、ここへ入れてはいけない。**
// プリレンダー済みの HTML は main.tsx が hydrateRoot で引き継ぐ（lib/ssrRoute.ts の
// isPrerenderedForRoute が真になる経路）。hydration の最中に lazy が未解決だと、React は
// その Suspense 境界のサーバー HTML を捨ててフォールバックへ切り替えるため、
// 「プリレンダーした内容が一瞬で消える」という plan_ssr-hydration.md が潰した事故が戻る。
//
// プリレンダー対象（web/scripts/gen-seo-pages.mjs が HTML を書き出すルート）:
//   / , /school/:id , /schools , /pref/:pref , /pref/:pref/:city ,
//   /legal/* , /guide/* , /press , /data , 404.html
// → これらは静的 import のまま据え置く。
//
// 下の 7 ルートは gen-seo-pages.mjs が HTML を出さず、必ず createRoot 経路になる
// （SPA フォールバックでトップの HTML が返り、data-mm-route が一致しない）。
// いずれも開いた直後に useSchools() が全国データ（約 0.81MB）を取りに行くか、
// 管理者・招待経由でしか到達しない画面なので、数十 KB のチャンク 1 本の追加往復は
// 体験に対して小さい。
const MapPage = lazy(() =>
  import('./pages/MapPage').then((module) => ({ default: module.MapPage })),
)
const SchoolSearchPage = lazy(() =>
  import('./pages/SchoolSearchPage').then((m) => ({ default: m.SchoolSearchPage })),
)
const FavoritesPage = lazy(() =>
  import('./pages/FavoritesPage').then((m) => ({ default: m.FavoritesPage })),
)
const ComparePage = lazy(() =>
  import('./pages/ComparePage').then((m) => ({ default: m.ComparePage })),
)
const MyPage = lazy(() => import('./pages/MyPage').then((m) => ({ default: m.MyPage })))
const AuthCallbackPage = lazy(() =>
  import('./pages/AuthCallbackPage').then((m) => ({ default: m.AuthCallbackPage })),
)
const FamilyJoinPage = lazy(() =>
  import('./pages/FamilyJoinPage').then((m) => ({ default: m.FamilyJoinPage })),
)
const DashboardPage = lazy(() =>
  import('./pages/DashboardPage').then((m) => ({ default: m.DashboardPage })),
)

function DashboardRoute({ isAdmin, checking }: { isAdmin: boolean; checking: boolean }) {
  // 管理者照会が終わるまで待つ。先に redirect すると、正規管理者が
  // セッション復元直後にトップへ飛ばされる競合が起きる。
  if (checking) return <main id="main-content" className="page" aria-busy="true" />
  return isAdmin ? <DashboardPage /> : <Navigate to="/" replace />
}

export default function App() {
  const location = useLocation()
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
    path === '/press' ||
    path === '/data'
  )

  return (
    <div className="stage">
      <div className="phone">
        <a className="skip-link" href="#main-content">
          {t('common.skipToContent')}
        </a>

        {isHome && (
          <div className="header">
            <img className="brand-icon" src="/brand-mark.svg" alt="" aria-hidden="true" />
            <div className="brand">{t('common.brand')}</div>
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
          <Route path="/data" element={<DataPage />} />
          <Route path="/schools" element={<SchoolsHubPage />} />
          <Route path="/pref/:pref" element={<PrefecturePage userData={userData} />} />
          <Route path="/pref/:pref/:city" element={<CityPage userData={userData} />} />
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
