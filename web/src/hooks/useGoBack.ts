import { useCallback } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

/**
 * 「前のページへ戻る」。履歴があれば 1 つ戻り、無ければ fallback へ置き換え遷移する。
 *
 * 検索エンジン・共有リンクからの直リンク着地（＝このタブで最初に開いたページ）で
 * navigate(-1) すると、戻り先が無いためサイトの外へ出てしまう。その場合だけ
 * fallback を使い、アプリ内に留まらせる。
 *
 * 最初のエントリかどうかは react-router が history.state に持たせる idx で判定する。
 * 取れない環境（history.state を他所で上書きされた等）では location.key で代替する
 * （react-router は初回エントリの key を 'default' にする）。
 */
export function useGoBack(fallback: string): () => void {
  const navigate = useNavigate()
  const location = useLocation()
  return useCallback(() => {
    const idx = (window.history.state as { idx?: number } | null)?.idx
    const isFirstEntry = typeof idx === 'number' ? idx === 0 : location.key === 'default'
    if (isFirstEntry) navigate(fallback, { replace: true })
    else navigate(-1)
  }, [navigate, location.key, fallback])
}
