import { StrictMode } from 'react'
import { createRoot, hydrateRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import { AppShell, AppTree } from './AppTree'
import { isPrerenderedForRoute } from './lib/ssrRoute'
import { loadMarkdownRuntime } from './lib/markdownRuntime'

const container = document.getElementById('root')!

const tree = (
  <StrictMode>
    <AppShell>
      <BrowserRouter>
        <AppTree />
      </BrowserRouter>
    </AppShell>
  </StrictMode>
)

// 本番の各 HTML は build 時に #root をプリレンダー済みなので、対象ルートが一致するときだけ
// 捨てずに引き継ぐ（hydrateRoot）。
// 従来の createRoot は #root の中身を毎回捨てて描き直していたため、
// プリレンダー内容が一瞬そのまま見えていた（plan_ssr-hydration.md）。
//
// SPA フォールバック（functions/_middleware.ts の SPA_ROUTES）はトップページの HTML を
// 200 で返すため、対象ルートが違うときは
// createRoot に落とす。dev サーバーの index.html も #root が空なので同じ経路になる。
// プリレンダー漏れは verify-static-output のテストで検出するので、この分岐は
// 漏れをごまかすためのものではなく、漏れたときに白画面を出さないための保険。
const prerenderedFor = container.dataset.mmRoute

function mountFresh() {
  container.replaceChildren()
  createRoot(container).render(tree)
}

// /legal/* と /guide/* のプリレンダー HTML は、埋め込んだ本文を Markdown で描いた結果を含む。
// 描画器は初期バンドルから外してあるので（plan_legal-guide-markdown-split.md）、
// **hydrate の前に読み終えておかないとサーバー HTML と食い違う。**
// 取得に失敗したときは hydrate せず createRoot へ落とす（食い違ったまま引き継がない）。
const needsMarkdownBeforeHydrate = /^\/(legal|guide)\//.test(location.pathname)

if (
  container.firstElementChild &&
  prerenderedFor &&
  isPrerenderedForRoute(prerenderedFor, location.pathname)
) {
  if (needsMarkdownBeforeHydrate) {
    loadMarkdownRuntime().then(
      () => hydrateRoot(container, tree),
      () => mountFresh(),
    )
  } else {
    hydrateRoot(container, tree)
  }
} else {
  mountFresh()
}
