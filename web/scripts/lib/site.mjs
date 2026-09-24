import { readFileSync } from 'node:fs'

// 学校サイトの住所（origin）。正本は web/data/site.json の 1 か所だけにする。
// 画面（TypeScript）は JSON を直接 import し、ビルドのスクリプト（mjs）はここから読む。
// index.html へは vite.config.ts が、robots.txt へは gen-seo-pages.mjs が差し込む。
// この値を変えると canonical・sitemap・OGP・JSON-LD・llms.txt・公開 API の説明がまとめて切り替わる
// （docs/local/school/plan_school-subdomain-move.md C1）。
const site = JSON.parse(readFileSync(new URL('../../data/site.json', import.meta.url), 'utf8'))

/**
 * 末尾のスラッシュやパスが付いていると `${SITE_ORIGIN}/…` が `//` を含み、canonical と sitemap が
 * 静かに壊れる。origin の形（scheme://host[:port]）でなければ読み込んだ時点で落とす。
 */
function parseOrigin(value) {
  let url = null
  try {
    url = new URL(value)
  } catch {
    // 下でまとめて落とす
  }
  if (!url || url.origin !== value) {
    throw new Error(
      `web/data/site.json の origin は https://host の形で書く（末尾スラッシュ・パスなし）: ${value}`,
    )
  }
  return value
}

export const SITE_ORIGIN = parseOrigin(site.origin)
export const SITE_HOSTNAME = new URL(SITE_ORIGIN).hostname
