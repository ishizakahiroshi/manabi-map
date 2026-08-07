import { StrictMode } from 'react'
import { createRoot, hydrateRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import { AppShell, AppTree } from './AppTree'

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

// 本番の各 HTML は build 時に #root をプリレンダー済みなので、捨てずに引き継ぐ（hydrateRoot）。
// 従来の createRoot は #root の中身を毎回捨てて描き直していたため、
// プリレンダー内容が一瞬そのまま見えていた（plan_ssr-hydration.md）。
//
// dev サーバーの index.html は #root が空なので createRoot に落とす。
// プリレンダー漏れは verify-static-output のテストで検出するので、この分岐は
// 漏れをごまかすためのものではなく、漏れたときに白画面を出さないための保険。
if (container.firstElementChild) {
  hydrateRoot(container, tree)
} else {
  createRoot(container).render(tree)
}
