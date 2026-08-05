/**
 * 広告リンクへの UTM パラメータ付与ユーティリティ。
 *
 * §7.5 塾アフィリ枠のクリック計測用。utm_source は "manabi-map" 固定、
 * utm_medium は掲載箇所（school-detail 等）、utm_campaign はリリース版タグ。
 * 既存クエリを持つ URL でも安全にマージし、既存 utm_* は上書きする（後勝ち）。
 */

export interface UtmOptions {
  campaign: string
  medium?: string
  source?: string
  content?: string
}

export function withUtm(baseUrl: string, opts: UtmOptions): string {
  const source = opts.source ?? 'manabi-map'
  const medium = opts.medium ?? 'school-detail'
  try {
    const url = new URL(baseUrl)
    url.searchParams.set('utm_source', source)
    url.searchParams.set('utm_medium', medium)
    url.searchParams.set('utm_campaign', opts.campaign)
    if (opts.content) url.searchParams.set('utm_content', opts.content)
    return url.toString()
  } catch {
    // 相対 URL 等・URL コンストラクタが失敗するケース向けの手動マージ
    const [head, hash = ''] = baseUrl.split('#')
    const [path, query = ''] = head.split('?')
    const params = new URLSearchParams(query)
    params.set('utm_source', source)
    params.set('utm_medium', medium)
    params.set('utm_campaign', opts.campaign)
    if (opts.content) params.set('utm_content', opts.content)
    const qs = params.toString()
    return `${path}?${qs}${hash ? `#${hash}` : ''}`
  }
}

/** Vite が git tag / package.json の version を注入する。テスト・Vite 外では package version に戻す。 */
const APP_VERSION = typeof __APP_VERSION__ === 'string' && __APP_VERSION__ ? __APP_VERSION__ : '0.4.0'

/** 全 AdSlot 共通のキャンペーン名。リリース版の更新は git tag に追随する。 */
export const AD_CAMPAIGN = `launch-${APP_VERSION}`
