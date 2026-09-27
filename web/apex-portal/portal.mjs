// Candidate-only settings. Publication flags are deliberately false until verified.
export const portal = {
  brand: 'まなびマップ',
  services: {
    school: { name: '高校・高専を探す', description: '', url: 'https://high-school.manabi-map.app/', published: false },
    kanji: { name: 'たねもじ', description: '漢字を学ぶ。毎日の練習を、少しずつ積み重ねる教材。', url: 'https://kanji.manabi-map.app/', published: false },
    karuta: { name: 'かるたで地域を知る', description: '遊びを通じて、ことばや地域に親しむ教材。', url: 'https://karuta.manabi-map.app/', published: false },
    home: { name: '住まい・暮らしを調べる', description: '', url: 'https://home.manabi-map.app/', published: false },
  },
}
const escape = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
function action(service) {
  const url = new URL(service.url)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('A bare public HTTPS destination is required')
  return service.published === true ? `<a class="primary" href="${escape(url.href)}" referrerpolicy="no-referrer">${escape(service.name)} →</a>` : '<span class="state">準備中・公開確認後にご案内します</span>'
}
export function renderEntryPage(template, config = portal) {
  const values = { brand: escape(config.brand), schoolAction: action(config.services.school), homeAction: action(config.services.home),
    learningCards: ['kanji', 'karuta'].map((id) => { const service = config.services[id]; return `<article><h2>${escape(service.name)}</h2><p>${escape(service.description)}</p>${action(service)}</article>` }).join('') }
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => { if (!(key in values)) throw new Error('Unknown portal field'); return values[key] })
}
