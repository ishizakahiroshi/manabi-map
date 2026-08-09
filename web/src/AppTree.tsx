import { type ReactNode } from 'react'
import App from './App'
import { AuthProvider } from './contexts/AuthContext'
import { AppProvider } from './contexts/AppContext'
import { I18nProvider } from './contexts/I18nContext'
import { ErrorBoundary } from './components/ErrorBoundary'
import { MaintenanceProvider } from './hooks/useMaintenanceMode'

/**
 * ブラウザ（main.tsx）とビルド時プリレンダー（entry-server.tsx）で共通の Provider 構成。
 *
 * 両者で違うのは Router だけ（BrowserRouter / StaticRouter）なので children で受け取る。
 * ここを二重管理すると Provider の順序が片方だけずれ、hydration が静かに壊れる
 * （plan_ssr-hydration_c1_ssr-foundation.md）。
 */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <I18nProvider>
      <ErrorBoundary>{children}</ErrorBoundary>
    </I18nProvider>
  )
}

/**
 * Router の内側。プリレンダーとブラウザで完全に同一のツリーを描く。
 * 各 Provider の副作用（Supabase セッション取得・メンテ状態の購読）は useEffect 内にあり、
 * 初回 render の出力は session=null / loading=true で両者一致する。
 */
export function AppTree() {
  return (
    <AuthProvider>
      <MaintenanceProvider>
        <AppProvider>
          <App />
        </AppProvider>
      </MaintenanceProvider>
    </AuthProvider>
  )
}
