import { Component, type ErrorInfo, type ReactNode } from 'react'

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
 *
 * 注意: エラーバウンダリはレンダリング/ライフサイクル中の同期例外のみ捕捉する。
 * イベントハンドラや非同期（fetch の失敗など）は各所の try/catch・error state 側で扱う。
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false }

  static getDerivedStateFromError(): State {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // PII を含みうるため詳細はコンソールのみ（外部送信しない）。
    console.error('ErrorBoundary caught:', error, info.componentStack)
  }

  private handleReload = (): void => {
    window.location.reload()
  }

  render(): ReactNode {
    if (!this.state.hasError) return this.props.children
    return (
      <div className="app-error" role="alert">
        <div className="app-error-card">
          <div className="app-error-title">一時的な問題が発生しました</div>
          <p className="app-error-text">
            画面の読み込み中に問題が起きました。通信環境のよい場所で、
            もう一度お試しください。
          </p>
          <button className="app-error-btn" onClick={this.handleReload}>
            再読み込みする
          </button>
          <p className="app-error-contact">
            何度も表示される場合は{' '}
            <a href="mailto:hello@manabi-map.app">hello@manabi-map.app</a>{' '}
            までご連絡ください。
          </p>
        </div>
      </div>
    )
  }
}
