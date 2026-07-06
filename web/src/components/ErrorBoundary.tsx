import { Component, type ErrorInfo, type ReactNode } from 'react'
import { getStaticT } from '../contexts/I18nContext'

interface Props {
  children: ReactNode
}

interface State {
  hasError: boolean
}

/**
 * アプリ全体を包む React エラーバウンダリ（C5 フルエラー処理）。
 * レンダリング中に例外が投げられても白画面にせず、「一時的な問題」の案内・
 * 再読み込みボタン・問い合わせ先を出して復帰導線を残す。
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false }

  static getDerivedStateFromError(): State {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('ErrorBoundary caught:', error, info.componentStack)
  }

  private handleReload = (): void => {
    window.location.reload()
  }

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children
    const t = getStaticT()
    return (
      <div className="app-error" role="alert">
        <div className="app-error-card">
          <div className="app-error-title">{t('error.title')}</div>
          <p className="app-error-text">{t('error.text')}</p>
          <button className="app-error-btn" onClick={this.handleReload}>
            {t('error.reload')}
          </button>
          <p className="app-error-contact">
            {t('error.contact')}{' '}
            <a href="mailto:hello@manabi-map.app">hello@manabi-map.app</a>
          </p>
        </div>
      </div>
    )
  }
}