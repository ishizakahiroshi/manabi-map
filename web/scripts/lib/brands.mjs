import { readFileSync } from 'node:fs'
import { jsonLdScript } from './json-ld.mjs'

export function validateBrands(config) {
  for (const id of ['high-school', 'school', 'apex']) {
    const brand = config?.[id]
    for (const value of [brand?.name, brand?.shortName, brand?.alternateName, brand?.displayName?.ja, brand?.displayName?.en]) {
      if (typeof value !== 'string' || !value.trim() || [...value].some((c) => c.charCodeAt(0) < 32)) throw new Error(`Invalid brand text: ${id}`)
    }
    for (const value of [brand.logo, brand.shareImage]) {
      if (typeof value !== 'string' || !/^\/[a-zA-Z0-9/_-]+\.[a-zA-Z0-9]+$/.test(value) || value.includes('//')) throw new Error(`Invalid brand asset: ${id}`)
    }
  }
  return config
}

export const brands = validateBrands(JSON.parse(readFileSync(new URL('../../data/brands.json', import.meta.url), 'utf8')))
export const schoolBrand = brands['high-school']
export const escapeBrandHtml = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

/** Text and attributes are escaped independently from JSON script contents. */
export function renderBrandHtml(html, id = 'high-school', config = brands, origins = {}) {
  const brand = validateBrands(config)[id]
  if (!brand) throw new Error('Unknown brand identifier')
  const values = { NAME: brand.name, DISPLAY_NAME: brand.displayName.ja, SHORT_NAME: brand.shortName,
    ALTERNATE_NAME: brand.alternateName, LOGO: brand.logo, SHARE_IMAGE: brand.shareImage }
  const origin = origins.SITE_ORIGIN ?? '__SITE_ORIGIN__'
  return html.replace(/__(BRAND_(?:NAME|DISPLAY_NAME|SHORT_NAME|ALTERNATE_NAME|LOGO|SHARE_IMAGE|WEBSITE_JSON_LD)|SITE_ORIGIN|SCHOOL_ORIGIN|HIGH_SCHOOL_ORIGIN)__/g, (token, key) => {
    if (key === 'BRAND_WEBSITE_JSON_LD') return jsonLdScript({
      '@context': 'https://schema.org', '@type': 'WebSite', '@id': `${origin}/#website`,
      name: brand.name, alternateName: brand.alternateName, url: `${origin}/`, inLanguage: 'ja',
      description: '住所を入れると通える高校が地図に出る、親子で使う学校選びの地図ノート。',
      publisher: { '@id': `${origin}/#organization` },
    })
    return key.startsWith('BRAND_') ? escapeBrandHtml(values[key.slice(6)]) : escapeBrandHtml(origins[key] ?? token)
  })
}

export function brandManifest(template, config = brands) {
  const brand = validateBrands(config)['high-school']
  return { ...template, name: brand.name, short_name: brand.shortName }
}
