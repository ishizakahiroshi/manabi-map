/** Keep JSON data out of every HTML script tokenizer state, including <!--<script. */
export function jsonLdScript(value) {
  return `<script type="application/ld+json">${JSON.stringify(value).replaceAll('<', '\\u003c')}</script>`
}
