type OAuthProvider = 'google' | 'line'

type OAuthButtonProps = {
  provider: OAuthProvider
  label: string
  onClick: () => void
  disabled?: boolean
  className?: string
}

const PROVIDER_NAME: Record<OAuthProvider, string> = {
  google: 'Google',
  line: 'LINE',
}

/** Google / LINE の公式配布アイコンを使うログインボタン。 */
export function OAuthButton({ provider, label, onClick, disabled = false, className = '' }: OAuthButtonProps) {
  const icon = provider === 'google' ? '/logos/google-signin-icon.svg' : '/logos/line-login-icon.png'

  return (
    <button
      className={`oauth-button oauth-button-${provider} ${className}`.trim()}
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
    >
      <img className="oauth-button-icon" src={icon} alt="" aria-hidden="true" />
      <span className="oauth-button-label">{label}</span>
      <span className="oauth-button-provider" aria-hidden="true">{PROVIDER_NAME[provider]}</span>
    </button>
  )
}
