import { useMemo } from 'react'
import { Routes, Route, useNavigate, useLocation } from 'react-router-dom'
import { useApp } from './contexts/AppContext'
import { useAuth } from './contexts/AuthContext'
import { useUserData } from './hooks/useUserData'
import { HomePage } from './pages/HomePage'
import { MapPage } from './pages/MapPage'
import { FavoritesPage } from './pages/FavoritesPage'
import { AuthCallbackPage } from './pages/AuthCallbackPage'
import { LegalPage } from './pages/LegalPage'
import { Sidebar } from './components/Sidebar'
import { LoginSheet } from './components/LoginSheet'
import { Toast } from './components/Toast'

export default function App() {
  const navigate = useNavigate()
  const location = useLocation()
  const { setSidebarOpen, setLoginOpen } = useApp()
  const { session, kind } = useAuth()
  const userData = useUserData()

  const favCount = Object.keys(userData.favorites).length
  const noteCount = useMemo(
    () => Object.values(userData.notes).filter((n) => n.note || n.commute_note).length,
    [userData.notes],
  )

  const isHome = location.pathname === '/'

  return (
    <div className="stage">
      <div className="phone">
        {/* トップページのみ共通ヘッダー（地図・一覧は各画面が自前ヘッダーを持つ） */}
        {isHome && (
          <div className="header">
            <button className="icon-btn" onClick={() => setSidebarOpen(true)} aria-label="メニュー">
              ≡
            </button>
            <img className="brand-icon" src="/brand-mark.svg" alt="" aria-hidden="true" />
            <div className="brand">Manabi Map</div>
            <button
              className="icon-btn"
              onClick={() => (session && kind === 'line' ? navigate('/favorites') : setLoginOpen(true))}
              aria-label={session && kind === 'line' ? 'お気に入り一覧' : 'ログイン'}
            >
              <span className="header-fav-icon" aria-hidden="true">★</span>
            </button>
          </div>
        )}

        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/map" element={<MapPage userData={userData} />} />
          <Route path="/favorites" element={<FavoritesPage userData={userData} />} />
          <Route path="/auth/callback" element={<AuthCallbackPage />} />
          <Route path="/legal/terms" element={<LegalPage doc="terms" />} />
          <Route path="/legal/privacy" element={<LegalPage doc="privacy" />} />
          <Route path="/legal/third-party" element={<LegalPage doc="third-party" />} />
        </Routes>

        <Sidebar favCount={favCount} noteCount={noteCount} />
        <LoginSheet />
        <Toast />
      </div>
    </div>
  )
}
