import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App'
import { AuthProvider } from './contexts/AuthContext'
import { AppProvider } from './contexts/AppContext'
import { I18nProvider } from './contexts/I18nContext'
import { ErrorBoundary } from './components/ErrorBoundary'
import { MaintenanceProvider } from './hooks/useMaintenanceMode'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <I18nProvider>
      <ErrorBoundary>
        <BrowserRouter>
          <AuthProvider>
            <MaintenanceProvider>
              <AppProvider>
                <App />
              </AppProvider>
            </MaintenanceProvider>
          </AuthProvider>
        </BrowserRouter>
      </ErrorBoundary>
    </I18nProvider>
  </StrictMode>,
)
