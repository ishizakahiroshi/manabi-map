import { StrictMode } from 'react'
import { createRoot, hydrateRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import { AppShell, AppTree } from './AppTree'
import { isPrerenderedForRoute } from './lib/ssrRoute'

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
// _redirects の SPA fallback はトップページの HTML を返すため、対象ルートが違うときは
// createRoot に落とす。dev サーバーの index.html も #root が空なので同じ経路になる。
// プリレンダー漏れは verify-static-output のテストで検出するので、この分岐は
// 漏れをごまかすためのものではなく、漏れたときに白画面を出さないための保険。
const prerenderedFor = container.dataset.mmRoute

if (
  container.firstElementChild &&
  prerenderedFor &&
  isPrerenderedForRoute(prerenderedFor, location.pathname)
) {
  hydrateRoot(container, tree)
} else {
  container.replaceChildren()
  createRoot(container).render(tree)
}
