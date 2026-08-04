// 公開用学校データセットを生成する。偏差値・推計・出典詳細・内部管理項目は、
// 除外リストではなく下記ホワイトリストに存在するフィールドだけを出力する。
//
//   node scripts/export-dataset.mjs [--out <directory>]
//
// 出力先は既定で gitignore 済みの dist-dataset/。GitHub Release への添付は手動運用。

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const publicDir = join(root, 'web', 'public')
const defaultOutputDir = join(root, 'dist-dataset')

function parseArgs(argv) {
  let outputDir = defaultOutputDir
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--out') {
      const value = argv[++index]
      if (!value) throw new Error('--out requires a directory')
      outputDir = resolve(value)
    } else {
      throw new Error(`unknown argument: ${argv[index]}`)
    }
  }
  return outputDir
}

const PUBLIC_FIELDS = [
  'id', 'name', 'name_kana', 'prefecture', 'city', 'address', 'postal_code',
  'latitude', 'longitude', 'ownership', 'type', 'course_times', 'gender_type',
  'campus_type', 'is_integrated', 'lifecycle_status_code', 'legally_established_on',
  'opened_on', 'closed_on', 'recruitment_status_code', 'recruitment_ended_on',
  'total_students', 'enrollment_year', 'male_ratio', 'official_url', 'school_departments',
]
const DEPARTMENT_FIELDS = ['name', 'course_type', 'ui_group']

function publicSchool(row) {
  const out = {}
  for (const field of PUBLIC_FIELDS) {
    if (field === 'school_departments') {
      out.departments = (row.school_departments ?? []).map((department) => {
        const publicDepartment = {}
        for (const departmentField of DEPARTMENT_FIELDS) {
          publicDepartment[departmentField] = department[departmentField] ?? null
        }
        return publicDepartment
      })
    } else {
      out[field] = row[field] ?? null
    }
  }
  return out
}

function csvValue(value) {
  const text = Array.isArray(value)
    ? value.map((item) => typeof item === 'object' ? item.name : item).filter(Boolean).join(' / ')
    : value == null ? '' : String(value)
  return `"${text.replaceAll('"', '""')}"`
}

const outputDir = parseArgs(process.argv.slice(2))
const manifest = JSON.parse(await readFile(join(publicDir, 'schools-manifest.json'), 'utf8'))
if (typeof manifest.url !== 'string' || !manifest.url.startsWith('/')) {
  throw new Error('schools-manifest.json does not contain a valid data URL')
}
const payloadFile = await readFile(join(publicDir, manifest.url.slice(1)))
const payloadText = manifest.compression === 'gzip' ? gunzipSync(payloadFile).toString('utf8') : payloadFile.toString('utf8')
const payload = JSON.parse(payloadText)
if (!Array.isArray(payload?.schools)) throw new Error('school payload does not contain schools')

const schools = payload.schools.map(publicSchool)
const attribution = '出典: Manabi Map（まなびマップ） https://manabi-map.app （CC BY-SA 4.0）'
const dataset = {
  license: 'CC BY-SA 4.0',
  attribution,
  sourceUrl: 'https://manabi-map.app',
  generatedAt: new Date().toISOString(),
  count: schools.length,
  fields: [...PUBLIC_FIELDS.filter((field) => field !== 'school_departments'), 'departments'],
  schools,
}
const csvHeaders = [...PUBLIC_FIELDS.filter((field) => field !== 'school_departments'), 'departments']
const csv = [
  csvHeaders.join(','),
  ...schools.map((school) => csvHeaders.map((field) => csvValue(school[field])).join(',')),
].join('\n') + '\n'

await mkdir(outputDir, { recursive: true })
await writeFile(join(outputDir, 'manabi-map-schools.json'), `${JSON.stringify(dataset, null, 2)}\n`)
await writeFile(join(outputDir, 'manabi-map-schools.csv'), csv)
console.log(`wrote ${schools.length} public school rows to ${outputDir}`)
