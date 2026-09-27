import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

const targets = JSON.parse(readFileSync(new URL('./data/deployment-targets.json', import.meta.url), 'utf8')).targets

// Independent static entry: no app public directory, Functions, auth or school JSON.
export default defineConfig({
  root: fileURLToPath(new URL('./school-portal', import.meta.url)),
  publicDir: false,
  envDir: false,
  plugins: [{
    name: 'school-portal-targets',
    transformIndexHtml: {
      order: 'pre',
      handler: (html) => html.replaceAll('__SCHOOL_ORIGIN__', targets.school.origin)
        .replaceAll('__HIGH_SCHOOL_ORIGIN__', targets['high-school'].origin),
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'robots.txt', source: `User-agent: *\nAllow: /\nSitemap: ${targets.school.origin}/sitemap.xml\n` })
      this.emitFile({ type: 'asset', fileName: 'sitemap.xml', source: `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${targets.school.origin}/</loc></url></urlset>\n` })
      this.emitFile({ type: 'asset', fileName: '404.html', source: '<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>ページが見つかりません | Manabi Map</title><body style="font-family:system-ui,sans-serif;background:#f7f3ea;color:#241f1a;padding:40px 24px;line-height:1.8"><main><h1>ページが見つかりません</h1><p>学校探しの入口から、もう一度お探しください。</p><a href="/">学校探しの入口へ</a></main></body></html>' })
    },
  }],
  build: {
    outDir: fileURLToPath(new URL('./dist-school-portal', import.meta.url)),
    emptyOutDir: false,
  },
})
