import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { BOOK_AD_MAX_BYTES, parseBookAdCatalog } from '../web/src/lib/bookAdCatalog.ts'

// Local preparation only. This command never uploads, deploys, or reads credentials.
const [input, output] = process.argv.slice(2)
if (!input || process.argv.length > 4) throw new Error('Usage: node scripts/prepare-book-ads.ts <catalog.json> [output-directory]')
if ((await stat(input)).size > 2 * 1024 * 1024) throw new Error('Catalog exceeds 2 MiB')
const catalog = parseBookAdCatalog(JSON.parse(await readFile(input, 'utf8')))
const files: { code: string; body: string }[] = []
for (let i = 1; i <= 47; i++) {
  const code = String(i).padStart(2, '0')
  const body = JSON.stringify({ ...catalog, ads: catalog.ads.filter(ad => ad.prefectureCode === code) }, null, 2) + '\n'
  if (Buffer.byteLength(body) > BOOK_AD_MAX_BYTES) throw new Error(`Prefecture ${code} exceeds 64 KiB`)
  files.push({ code, body })
}
if (output) {
  const directory = path.resolve(output, 'book-ads')
  await mkdir(directory, { recursive: true })
  // Empty prefectures are intentional: uploading all files also removes previously listed ads.
  for (const { code, body } of files) await writeFile(path.join(directory, `${code}.json`), body, 'utf8')
}
console.log(JSON.stringify({ valid: true, ads: catalog.ads.length, registeredPrefectures: new Set(catalog.ads.map(ad => ad.prefectureCode)).size, filesWritten: output ? files.length : 0 }))
