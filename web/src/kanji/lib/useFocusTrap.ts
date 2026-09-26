// シート・引き出しのフォーカス管理（C7 レビュー must 2）。
// 学校サイトの web/src/hooks/useFocusTrap.ts を見本にしたが、コードは共有しない（子 plan
// 「このファイルを開いた AI へ」）。本家との違いは、閉じたときに開く前のフォーカスへ戻す処理を
// 持つこと（本家には無い。レビューの指示どおり）。
//
// 動き:
// - active になったら（開いたら）、.sheet-close か先頭の操作できる要素へフォーカスを移す。
// - Tab をコンテナの中に閉じ込める（Shift+Tab で先頭から出ようとしたら末尾へ、Tab で末尾から
//   出ようとしたら先頭へ）。
// - active が false に戻ったら（閉じたら）、active になる直前にフォーカスがあった要素へ戻す。
//
// LanguageSheet・ProfileSheet は「開く」＝「マウントする」（LoginSheet 流）なので、これらは
// active に常に true を渡す（マウント＝開く・アンマウント＝閉じるのタイミングでこのフックの
// effect が発火する）。MoreDrawer は Sidebar 流に常にマウントしたまま open の真偽を渡す。

import { useEffect, useRef, type RefObject } from 'react'

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

export function useFocusTrap(containerRef: RefObject<HTMLElement | null>, active: boolean): void {
  const previouslyFocusedRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!active) return
    const container = containerRef.current
    if (!container) return

    previouslyFocusedRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null

    const nodes = () =>
      Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => !el.hasAttribute('disabled') && el.tabIndex !== -1,
      )

    const focusFirst = () => {
      const list = nodes()
      const preferred = list.find((el) => el.classList.contains('sheet-close')) ?? list[0]
      preferred?.focus()
    }

    // React が子の描画を終えてからフォーカスを移す（本家と同じ理由）
    const raf = requestAnimationFrame(focusFirst)

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return
      const list = nodes()
      if (list.length === 0) return
      const first = list[0]
      const last = list[list.length - 1]
      if (e.shiftKey) {
        if (document.activeElement === first || !container.contains(document.activeElement)) {
          e.preventDefault()
          last.focus()
        }
      } else if (document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }

    container.addEventListener('keydown', onKeyDown)
    return () => {
      cancelAnimationFrame(raf)
      container.removeEventListener('keydown', onKeyDown)
      // must 2: 閉じたら、開く前にフォーカスがあった要素へ戻す（本家の useFocusTrap には無い）。
      previouslyFocusedRef.current?.focus()
    }
  }, [active, containerRef])
}
