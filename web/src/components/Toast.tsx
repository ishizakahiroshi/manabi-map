import { useApp } from '../contexts/AppContext'

export function Toast() {
  const { toastMsg, toastShow } = useApp()
  return (
    <div className={`toast ${toastShow ? 'show' : ''}`} role="status" aria-live="polite">
      {toastMsg}
    </div>
  )
}
