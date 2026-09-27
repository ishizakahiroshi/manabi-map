// Checks HTML injection only, not execution or measurement. Edge injection needs a browser UA.
// Usage: node scripts/smoke-beacon.mjs [--url https://example.com/]
import { parseArgs } from 'node:util'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { SITE_ORIGIN } from './lib/site.mjs'

const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

function attributes(tag) {
  const attrs = new Map()
  const source = tag.replace(/^<\s*[\w:-]+/, '').replace(/>$/, '')
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g
  for (const match of source.matchAll(pattern)) {
    const name = match[1].toLowerCase()
    if (!attrs.has(name)) attrs.set(name, match[2] ?? match[3] ?? match[4] ?? '')
  }
  return attrs
}

/** Conservative scan: ignore comments, inert containers and raw-text elements. */
export function hasBeaconScript(html) {
  const tags = /<!--[\s\S]*?(?:-->|$)|<![^>]*>|<\/?[a-z][^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>/gi
  let templateDepth = 0
  const foreign = []
  let rawText = null
  for (const match of html.matchAll(tags)) {
    const tag = match[0]
    if (tag.startsWith('<!')) continue
    const name = /^<\/?([\w:-]+)/.exec(tag)?.[1].toLowerCase()
    const closing = tag.startsWith('</')
    if (rawText) {
      if (closing && name === rawText) rawText = null
      continue
    }
    if (name === 'svg' || name === 'math') {
      if (!closing && !/\/\s*>$/.test(tag)) foreign.push(name)
      else if (closing && foreign.at(-1) === name) foreign.pop()
      continue
    }
    if (name === 'template') {
      templateDepth = Math.max(0, templateDepth + (closing ? -1 : 1))
      continue
    }
    if (closing) continue
    if (name === 'plaintext') break
    if (['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript'].includes(name)) rawText = name
    if (name !== 'script' || templateDepth || foreign.length) continue
    const attrs = attributes(tag)
    if (attrs.has('nomodule')) continue
    const type = (attrs.get('type') ?? '').trim().toLowerCase()
    if (type && !['text/javascript', 'application/javascript', 'module'].includes(type)) continue
    if (!type && attrs.has('language') && !/^javascript(?:1\.[0-5])?$/i.test(attrs.get('language'))) continue
    try {
      const url = new URL(attrs.get('src') ?? '')
      if (url.protocol === 'https:' && url.hostname === 'static.cloudflareinsights.com'
        && !url.port && !url.username && !url.password
        && /^\/beacon\.min\.js(?:\/[a-z0-9]+)?$/i.test(url.pathname)) return true
    } catch {
      // Missing, relative or malformed src cannot establish edge injection.
    }
  }
  return false
}

export async function checkBeacon(url, fetchImpl = fetch) {
  const response = await fetchImpl(url, {
    headers: { 'user-agent': BROWSER_UA, accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
    redirect: 'follow', signal: AbortSignal.timeout(15_000),
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  const mime = (response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
  if (!['text/html', 'application/xhtml+xml'].includes(mime)) throw new Error('response is not HTML')
  const html = await response.text()
  if (!hasBeaconScript(html)) throw new Error('Cloudflare Analytics script not found in HTML')
  return html.length
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { url: { type: 'string', default: `${SITE_ORIGIN}/` } } })
  try {
    const size = await checkBeacon(values.url)
    console.log(`smoke-beacon: OK — Analytics script found (${size} characters; execution/measurement not checked)`)
  } catch (err) {
    console.error(`smoke-beacon: ${err.message}`)
    process.exitCode = 1
  }
}
