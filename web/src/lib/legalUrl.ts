/** 第一党 markdown でも javascript: 等を href に通さない多層防御 */
export function sanitizeLegalHref(href: string | undefined): {
  safe: string | undefined
  isExternal: boolean
} {
  const safe = href && /^(https?:|mailto:|\/)/i.test(href) ? href : undefined
  const isExternal = Boolean(safe && /^(https?:|mailto:)/i.test(safe))
  return { safe, isExternal }
}
