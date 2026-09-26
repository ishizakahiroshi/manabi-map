/** 第一党 markdown でも javascript: 等を href に通さない多層防御 */
export function sanitizeLegalHref(href: string | undefined): {
  safe: string | undefined
  isExternal: boolean
} {
  // ブラウザはタブ・CR・LF を除いてから URL を解釈する。同じ除去のあとで判定し、通す値も除去後にする。
  const normalized = href?.replace(/[\t\n\r]/g, '')
  // https:, mailto:, または先頭が単一スラッシュ（// や /\ で始まらない内部パス）のみ許可
  const safe = normalized && /^(https?:|mailto:|\/(?![/\\]))/i.test(normalized) ? normalized : undefined
  const isExternal = Boolean(safe && /^(https?:|mailto:)/i.test(safe))
  return { safe, isExternal }
}
