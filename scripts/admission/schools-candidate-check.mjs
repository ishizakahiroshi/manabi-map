#!/usr/bin/env node
/**
 * schools-candidate.csv の不変条件を S1 の段階で検査する。
 *
 * 背景: 本番schema相当への適用（S4）で落ちる defect が、S1〜S3 を素通りして
 * S4 まで持ち越される事故が繰り返し起きた。
 *   - Block 4 奈良: 中等教育学校を `type='secondary_education_school'` にして S4 FAIL
 *   - Block 3 岐阜2/三重1: 女子校を `gender_type='female'` にして defect
 *   - Block 5 大阪: 私立93校の `course_times` が空で CHECK 違反により S4 FAIL
 *     （同じ穴が京都100/101校・佐賀44/44校にも潜在していた）
 *   - Block 6 福岡: `campus_type='satellite'`（正しくは `satellite_campus`）
 *
 * gen-admission-v2.mjs は admission 4 CSV だけを見て schools 表を扱わないため、
 * `--validate-only` では上記をどれも検出できない。本toolがその穴を埋める。
 *
 * 実行:
 *   node scripts/admission/schools-candidate-check.mjs <schools-candidate.csv>
 *   node scripts/admission/schools-candidate-check.mjs <csv> --json
 *
 * 違反があれば exit 1。CSV を書き換えず、DBへも接続しない。
 */

import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

import { parseCsv } from './gsi-batch-geocode.mjs'

// 本番schemaのenum・CHECKに対応する許容値。増やすときはmigrationと必ず一致させる。
const ALLOWED_GENDER_TYPES = new Set(['coed', 'girls', 'boys'])
const FORBIDDEN_GENDER_TYPES = new Map([['female', 'girls'], ['male', 'boys']])
const FORBIDDEN_TYPES = new Map([['secondary_education_school', 'high_school']])
const FORBIDDEN_CAMPUS_TYPES = new Map([['satellite', 'satellite_campus']])

function isEmptyArrayLiteral(value) {
  const v = (value ?? '').trim()
  return v === '' || v === '{}'
}

/**
 * @param {Array<Record<string, string>>} rows
 * @returns {Array<{ row: number, school: string, rule: string, detail: string }>}
 */
export function checkSchoolRows(rows) {
  const violations = []
  const seenRecordKeys = new Map()

  rows.forEach((row, index) => {
    const lineNo = index + 2 // header 分
    const school = row.name ?? row.school_name ?? '(名称不明)'
    const add = (rule, detail) => violations.push({ row: lineNo, school, rule, detail })

    if ('course_times' in row && isEmptyArrayLiteral(row.course_times)) {
      add('course_times_empty', 'schools_course_times_nonempty CHECK に違反する（S4 で必ず落ちる）')
    }

    const gender = (row.gender_type ?? '').trim()
    if (gender && FORBIDDEN_GENDER_TYPES.has(gender)) {
      add('gender_type_forbidden', `'${gender}' は禁止。'${FORBIDDEN_GENDER_TYPES.get(gender)}' を使う`)
    } else if (gender && !ALLOWED_GENDER_TYPES.has(gender)) {
      add('gender_type_unknown', `未知の gender_type: '${gender}'`)
    }

    const type = (row.type ?? '').trim()
    if (type && FORBIDDEN_TYPES.has(type)) {
      add('type_forbidden', `'${type}' は禁止。'${FORBIDDEN_TYPES.get(type)}' を使う`)
    }

    const campusType = (row.campus_type ?? '').trim()
    if (campusType && FORBIDDEN_CAMPUS_TYPES.has(campusType)) {
      add('campus_type_forbidden', `'${campusType}' は enum 外。'${FORBIDDEN_CAMPUS_TYPES.get(campusType)}' を使う`)
    }

    const recordKey = (row.record_key ?? '').trim()
    if (!recordKey) {
      add('record_key_empty', 'record_key が空')
    } else if (seenRecordKeys.has(recordKey)) {
      add('record_key_duplicated', `record_key が ${seenRecordKeys.get(recordKey)} 行目と重複: ${recordKey}`)
    } else {
      seenRecordKeys.set(recordKey, lineNo)
    }
  })

  return violations
}

export function readSchoolRows(csvPath) {
  const rows = parseCsv(readFileSync(csvPath, 'utf8'))
  if (rows.length === 0) return []
  const [header, ...body] = rows
  return body
    .filter((cells) => cells.some((cell) => cell !== ''))
    .map((cells) => Object.fromEntries(header.map((key, i) => [key, cells[i] ?? ''])))
}

function main() {
  const args = process.argv.slice(2)
  const json = args.includes('--json')
  const csvPath = args.find((arg) => !arg.startsWith('--'))
  if (!csvPath) {
    console.error('使い方: node scripts/admission/schools-candidate-check.mjs <schools-candidate.csv> [--json]')
    process.exit(2)
  }

  const rows = readSchoolRows(csvPath)
  const violations = checkSchoolRows(rows)

  if (json) {
    console.log(JSON.stringify({ csv: csvPath, schools: rows.length, violations }, null, 2))
  } else if (violations.length === 0) {
    console.error(`検査成功: ${csvPath} schools=${rows.length} 違反なし`)
  } else {
    console.error(`検査失敗: ${csvPath} schools=${rows.length} 違反=${violations.length}`)
    for (const v of violations.slice(0, 30)) {
      console.error(`  L${v.row} ${v.school}: [${v.rule}] ${v.detail}`)
    }
    if (violations.length > 30) console.error(`  ... 他 ${violations.length - 30} 件`)
  }

  process.exit(violations.length === 0 ? 0 : 1)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main()
