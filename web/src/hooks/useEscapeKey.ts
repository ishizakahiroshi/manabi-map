import { useEffect, useRef } from 'react'

/** Close overlays on Escape — standard modal/sheet keyboard contract. */
const escapeStack: symbol[] = []

export function useEscapeKey(onEscape: () => void, active: boolean): void {
  const onEscapeRef = useRef(onEscape)

  useEffect(() => {
    onEscapeRef.current = onEscape
  }, [onEscape])

  useEffect(() => {
    if (!active) return
    const id = Symbol('escape-overlay')
    escapeStack.push(id)
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || escapeStack[escapeStack.length - 1] !== id) return
      e.preventDefault()
      onEscapeRef.current()
    }
    document.addEventListener('keydown', handler)
    return () => {
      document.removeEventListener('keydown', handler)
      const index = escapeStack.indexOf(id)
      if (index >= 0) escapeStack.splice(index, 1)
    }
  }, [active])
}
