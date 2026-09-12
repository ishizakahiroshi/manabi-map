import type MarkdownComponent from 'react-markdown'
import type remarkGfmPlugin from 'remark-gfm'

/**
 * Markdown 描画器（react-markdown + remark-gfm・gzip 約 47KB）を初期バンドルから外すための入れ物。
 *
 * **このファイルは react-markdown を import しない。** 型だけ `import type` で借りる
 * （型は実行時に消えるのでバンドルへ混ざらない）。実体は markdownRuntimeImpl.ts が持ち、
 * 動的 import か、SSR 側の静的 import 経由で登録される。
 *
 * なぜ React.lazy ではないか（plan_legal-guide-markdown-split.md）:
 * /legal/* と /guide/* はビルド時プリレンダー対象で、main.tsx が hydrateRoot で引き継ぐ。
 * 両ページはプリレンダーが埋め込んだ本文を useState の初期値に使うため、
 * **初回 render の時点で既に本文を描いている**。hydration の瞬間に描画器が無いと
 * サーバー HTML と食い違い、plan_ssr-hydration.md が潰した
 * 「プリレンダーが一瞬で消える」事故が戻る。
 * そのため main.tsx は、対象ルートでは hydrate の前に loadMarkdownRuntime() を待つ。
 */
export interface MarkdownRuntime {
  Markdown: typeof MarkdownComponent
  remarkGfm: typeof remarkGfmPlugin
}

let runtime: MarkdownRuntime | null = null
let loading: Promise<MarkdownRuntime> | null = null

/** SSR 側（entry-server.tsx）と、動的 import の完了時に呼ぶ */
export function setMarkdownRuntime(value: MarkdownRuntime): void {
  runtime = value
}

/** 同期で取れるなら返す。null なら未ロード（呼び出し側は「読み込み中」を出す） */
export function getMarkdownRuntime(): MarkdownRuntime | null {
  return runtime
}

/** 描画器を読み込む。並行して何度呼ばれても取得は 1 回だけ。 */
export function loadMarkdownRuntime(): Promise<MarkdownRuntime> {
  if (runtime) return Promise.resolve(runtime)
  loading ??= import('./markdownRuntimeImpl').then((module) => {
    setMarkdownRuntime(module.markdownRuntime)
    return module.markdownRuntime
  })
  return loading
}
