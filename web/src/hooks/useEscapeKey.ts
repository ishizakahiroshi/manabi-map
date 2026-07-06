import { useEffect } from 'react'

/** Close overlays on Escape — standard modal/sheet keyboard contract. */
export function useEscapeKey(onEscape: () => void, active: boolean): void {
  useEffect(() => {
    if (!active) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onEscape()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [active, onEscape])
}