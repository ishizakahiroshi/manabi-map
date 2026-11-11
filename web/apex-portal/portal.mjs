import { readFileSync } from 'node:fs'
import { brands, validateBrands } from '../scripts/lib/brands.mjs'
import deploymentTargets from '../data/deployment-targets.json' with { type: 'json' }

// 総合入口は外部の画像を読まない（CSP は default-src 'none'）。ロゴはブランド設定の SVG を
// <symbol id="brand-mark"> にして HTML へ埋め込み、ヘッダー・フッター・地図の絵が <use> で参照する。
export function brandMarkSymbol(svg) {
  const match = /^<svg\b[^>]*\sviewBox="([\d\s.-]+)"[^>]*>([\s\S]*)<\/svg>$/.exec(String(svg).trim())
  if (!match || /<script|<style|<foreignObject|<!\[CDATA\[|href\s*=|\son\w+\s*=|url\(|\{\{/i.test(match[2])) throw new Error('Invalid brand mark')
  const body = match[2].replace(/<!--[\s\S]*?-->/g, '').replace(/\s+/g, ' ').replace(/> </g, '><').trim()
  return `<symbol id="brand-mark" viewBox="${match[1].trim()}">${body}</symbol>`
}
export const brandMark = (config = brands) => brandMarkSymbol(readFileSync(new URL(`../public${validateBrands(config).apex.logo}`, import.meta.url), 'utf8'))

// タブのアイコンも HTML へ埋め込む。CSP の img-src は data: だけを許すので、画像を通信で取りに行くことは無い。
// 高校版・学校入口と同じアイコン（web/public の favicon.svg と 32px の PNG）を使う。SVG を読めないブラウザは PNG を使う。
export function faviconLinks(svg, png) {
  const text = String(svg).trim()
  if (!/^<svg\b[\s\S]*<\/svg>$/.test(text) || /<script|<foreignObject|\son\w+\s*=|href\s*=\s*["'](?!#)|\{\{/i.test(text)) throw new Error('Invalid favicon')
  if (!(png instanceof Uint8Array) || png.length > 4096 || Buffer.from(png.subarray(0, 8)).toString('hex') !== '89504e470d0a1a0a') throw new Error('Invalid favicon')
  const minified = text.replace(/<!--[\s\S]*?-->/g, '').replace(/\s+/g, ' ').replace(/> </g, '><')
  return `<link rel="icon" type="image/png" sizes="32x32" href="data:image/png;base64,${Buffer.from(png).toString('base64')}"><link rel="icon" type="image/svg+xml" sizes="any" href="data:image/svg+xml;base64,${Buffer.from(minified).toString('base64')}">`
}
const publicFile = (name) => readFileSync(new URL(`../public/${name}`, import.meta.url))
export const favicon = () => faviconLinks(publicFile('favicon.svg').toString('utf8'), publicFile('favicon-32.png'))

// Candidate-only destinations. Publication flags are deliberately false until verified.
export const portal = {
  brand: brands.apex.displayName.ja,
  brandMark: brandMark(),
  favicon: favicon(),
  schoolBrand: brands['high-school'].displayName.ja,
  services: {
    school: { name: '高校・高専を探す', description: '', url: deploymentTargets.targets['high-school'].origin + '/', published: false },
    kanji: { name: 'たねもじ', description: '漢字を学ぶ。毎日の練習を、少しずつ積み重ねる教材。', url: 'https://kanji.manabi-map.app/', published: false },
    karuta: { name: 'かるたで地域を知る', description: '遊びを通じて、ことばや地域に親しむ教材。', url: 'https://karuta.manabi-map.app/', published: false },
    home: { name: '住まい・暮らしを調べる', description: '', url: 'https://home.manabi-map.app/', published: false },
  },
}
export function portalWithBrands(config) {
  return { ...portal, brand: config.apex.displayName.ja, brandMark: brandMark(config), schoolBrand: config['high-school'].displayName.ja }
}
const escape = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
function action(service) {
  const url = new URL(service.url)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('A bare public HTTPS destination is required')
  return service.published === true ? `<a class="primary" href="${escape(url.href)}" referrerpolicy="no-referrer">${escape(service.name)} →</a>` : '<span class="state">準備中・公開確認後にご案内します</span>'
}
export function renderEntryPage(template, config = portal) {
  if (config.migrationPhase && !['candidate-rescue', 'candidate-retired'].includes(config.migrationPhase)) throw new Error('Invalid candidate phase')
  const retired = config.migrationPhase === 'candidate-retired'
  const recoveryLink = retired ? '<a class="recovery" href="/school-recovery-ended.html">旧URLでの手続きについて →</a>' : '<a class="recovery" href="/mypage">旧URLで保存情報・連携を確認する →</a>'
  const recoveryNotice = retired ? '旧URLでの認証・連携・招待の受付は終了しています。新しい高校版でログインし直してください。ゲストの保存情報が自動で移るわけではありません。' : 'ゲストで保存した情報は、旧URLのマイページでLINE・Googleとの連携をご確認ください。認証や家族招待の途中でも、旧URLで手続きを続けられます。'
  const values = { origin: escape(deploymentTargets.targets.apex.origin), brand: escape(config.brand), brandMark: config.brandMark, favicon: config.favicon, schoolBrand: escape(config.schoolBrand), schoolAction: action(config.services.school), homeAction: action(config.services.home), homeBrand: '', recoveryLink, recoveryNotice,
    learningCards: ['kanji', 'karuta'].map((id) => { const service = config.services[id]; return `<article><span class="badge" aria-hidden="true"><svg><use href="#pin-${id}"/></svg></span><h2>${escape(service.name)}</h2><p>${escape(service.description)}</p>${action(service)}</article>` }).join('') }
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => { if (typeof values[key] !== 'string') throw new Error('Unknown portal field'); return values[key] })
}

export function renderRecoveryEnded(config = portal) {
  return `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><meta name="referrer" content="no-referrer"><title>旧URLでの手続きについて | ${escape(config.brand)}</title><link rel="stylesheet" href="/portal.css"></head><body><main><h1>旧URLでの受付は終了しました</h1><p>認証・連携は、新しい高校版でログインし直してください。招待は、送信者に新しいリンクをご確認ください。</p><p>ゲストの保存情報が自動で移るわけではありません。</p>${action(config.services.school)}<p><a href="/">総合入口へ</a></p></main></body></html>`
}
