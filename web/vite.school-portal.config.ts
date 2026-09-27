import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import { renderBrandHtml, brands } from './scripts/lib/brands.mjs'
import { entrySupportFiles } from './scripts/lib/entry-metadata.mjs'

const targets = JSON.parse(readFileSync(new URL('./data/deployment-targets.json', import.meta.url), 'utf8')).targets

// Independent static entry: no app public directory, Functions, auth or school JSON.
export default defineConfig({
  root: fileURLToPath(new URL('./school-portal', import.meta.url)),
  publicDir: false,
  envDir: false,
  plugins: [{
    name: 'school-portal-targets',
    transformIndexHtml: {
      order: 'pre',
      handler: (html) => renderBrandHtml(html, 'school', undefined, {
        SCHOOL_ORIGIN: targets.school.origin,
        HIGH_SCHOOL_ORIGIN: targets['high-school'].origin,
      }),
    },
    generateBundle() {
      for (const [fileName, source] of Object.entries(entrySupportFiles({ origin: targets.school.origin, brand: brands.school.name, description: '学校探しの入口。高校・高専へご案内します。' }))) {
        this.emitFile({ type: 'asset', fileName, source })
      }
    },
  }],
  build: {
    outDir: fileURLToPath(new URL('./dist-school-portal', import.meta.url)),
    emptyOutDir: false,
  },
})
