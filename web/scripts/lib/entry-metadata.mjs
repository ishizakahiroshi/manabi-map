const escape = (value) => String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

/** Static entry metadata only. Candidate output remains non-indexable. */
export function entrySupportFiles({ origin, brand, description, stylesheet }) {
  const url = new URL(origin)
  if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password || /[\r\n]/.test(brand + description)) throw new Error('Invalid entry metadata')
  if (stylesheet !== undefined && stylesheet !== '/portal.css') throw new Error('Invalid entry stylesheet')
  const head = `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><meta name="referrer" content="no-referrer">`
  const style = stylesheet ? `<link rel="stylesheet" href="${stylesheet}">` : '<style>body{font-family:system-ui,sans-serif;background:#f7f3ea;color:#241f1a;padding:40px 24px;line-height:1.8}main{max-width:960px;margin:auto}a{color:#6f361c;overflow-wrap:anywhere}</style>'
  return {
    'robots.txt': `User-agent: *\nDisallow: /\nSitemap: ${origin}/sitemap.xml\n`,
    'sitemap.xml': `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${escape(origin)}/</loc></url></urlset>\n`,
    'llms.txt': `# ${brand}\n\n${description}\n\n移行候補。公開確認前の入口です。\n\n- [入口](${origin}/)\n`,
    '404.html': `<!doctype html><html lang="ja"><head>${head}<title>ページが見つかりません | ${escape(brand)}</title>${style}</head><body><main><h1>ページが見つかりません</h1><p>入口から、もう一度お探しください。</p><a href="/">${escape(brand)}の入口へ</a></main></body></html>`,
    '_headers': `/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: no-referrer\n  X-Robots-Tag: noindex\n  X-Frame-Options: DENY\n`,
  }
}
