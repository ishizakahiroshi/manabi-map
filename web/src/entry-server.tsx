import { StrictMode } from 'react'
import { renderToString } from 'react-dom/server'
import { StaticRouter } from 'react-router-dom'
import { AppShell, AppTree } from './AppTree'
import { serializeInitialData, setInitialData, type InitialData } from './lib/initialData'

/**
 * ビルド時プリレンダー用のエントリ。`vite build --ssr` でバンドルし、
 * web/scripts/gen-seo-pages.mjs から呼んで #root の中身を作る。
 *
 * ここで返す HTML はクライアントの hydrateRoot がそのまま引き継ぐ。
 * 「クローラー向けに別物の HTML を手書きして mount 時に捨てる」旧方式をやめるための土台
 * （plan_ssr-hydration.md）。CSS は client バンドル側が持つので、ここでは import しない。
 */
export function render(
  url: string,
  initialData: InitialData | null = null,
): { html: string; initialScript: string } {
  // データはページごとに差し替える。描画後に必ず捨てて、次のページへ持ち越さない。
  setInitialData(initialData)
  try {
    const html = renderToString(
      <StrictMode>
        <AppShell>
          <StaticRouter location={url}>
            <AppTree />
          </StaticRouter>
        </AppShell>
      </StrictMode>,
    )
    return {
      html,
      initialScript: initialData ? serializeInitialData(initialData) : '',
    }
  } finally {
    setInitialData(null)
  }
}
