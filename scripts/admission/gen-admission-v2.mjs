#!/usr/bin/env node
/**
 * 入試の募集単位・選抜区分を表す CSV v2 bundle を検査し、投入 SQL を生成する。
 *
 * bundle（UTF-8 / RFC4180）:
 *   admission-recruitment-units-v2.csv
 *   admission-selection-stats-v2.csv
 *   admission-selection-sources-v2.csv
 *   admission-selection-quality-flags-v2.csv
 *
 * 実行:
 *   node scripts/admission/gen-admission-v2.mjs --dir <bundle-dir> --out <sql>
 *   node scripts/admission/gen-admission-v2.mjs --dir <bundle-dir> --validate-only
 *
 * 本スクリプトは SQL を生成するだけで、DB へ接続・適用しない。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const FILES = {
  units: 'admission-recruitment-units-v2.csv',
  stats: 'admission-selection-stats-v2.csv',
  sources: 'admission-selection-sources-v2.csv',
  flags: 'admission-selection-quality-flags-v2.csv',
}

const HEADERS = {
  units: ['pref', 'school_name', 'school_record_key', 'unit_key', 'unit_kind_code', 'unit_label', 'course_time', 'valid_from_year', 'valid_to_year', 'department_names'],
  stats: ['pref', 'school_name', 'school_record_key', 'unit_key', 'year', 'selection_stage_code', 'selection_track_code', 'stage_label_raw', 'track_label_raw', 'selection_scope_raw', 'population_scope_raw', 'scope_key', 'map_role_code', 'is_ratio_comparable', 'capacity', 'applicants', 'examinees', 'admitted', 'exam_scope_raw', 'exam_component_codes'],
  sources: ['pref', 'school_name', 'school_record_key', 'unit_key', 'year', 'selection_stage_code', 'selection_track_code', 'scope_key', 'fact_kind_code', 'official_url', 'doc_title', 'published_at', 'source_page_or_table', 'quoted_evidence', 'last_verified_at', 'last_http_status'],
  flags: ['pref', 'school_name', 'school_record_key', 'unit_key', 'year', 'selection_stage_code', 'selection_track_code', 'scope_key', 'metric_code', 'reason_code', 'note'],
}

const LEGACY_HEADERS = Object.fromEntries(
  Object.entries(HEADERS).map(([kind, header]) => [kind, header.filter((name) => name !== 'school_record_key')]),
)

export const CODES = {
  unitKinds: new Set(['department', 'department_group', 'school', 'course_group', 'time_division', 'other', 'unknown']),
  courseTimes: new Set(['fulltime', 'parttime', 'correspondence']),
  stages: new Set(['primary', 'secondary', 'supplemental', 'unknown']),
  tracks: new Set(['general', 'recommendation', 'special', 'combined', 'other', 'unknown']),
  mapRoles: new Set(['primary_total', 'component_only', 'additional_stage', 'detail_only', 'unknown']),
  reasons: new Set(['missing_capacity', 'missing_applicants', 'stage_unknown', 'track_scope_mismatch', 'metric_scope_mismatch', 'recruitment_unit_mismatch', 'overlapping_unit', 'mixed_population', 'source_conflict', 'source_unreachable', 'scheme_changed']),
  examComponents: new Set(['academic_test', 'transcript', 'interview', 'essay', 'composition', 'practical', 'school_specific', 'other', 'unknown']),
  factKinds: new Set(['capacity', 'applicants', 'examinees', 'admitted', 'selection_rule', 'exam_method']),
  metricCodes: new Set(['capacity', 'applicants', 'examinees', 'admitted', 'selection_rule', 'exam_method']),
}

const COMMERCIAL_DOMAINS = ['minkou.jp', 'studysapuri.jp', 'shingakunet.com', 'koukou-shiken.com', 'jyukendama', 'manabi.st']
const OFFICIAL_HOST_SUFFIXES = new Map([
  ['青森県', ['pref.aomori.lg.jp']],
  ['岩手県', ['pref.iwate.jp']],
  ['宮城県', ['pref.miyagi.jp']],
  ['秋田県', ['pref.akita.lg.jp']],
  ['山形県', ['pref.yamagata.jp']],
  ['福島県', ['pref.fukushima.lg.jp']],
  ['富山県', ['pref.toyama.jp']],
  ['石川県', ['pref.ishikawa.lg.jp']],
  ['福井県', ['pref.fukui.lg.jp']],
  ['新潟県', ['pref.niigata.lg.jp']],
  ['長野県', ['pref.nagano.lg.jp']],
  ['山梨県', ['pref.yamanashi.jp']],
  ['北海道', ['dokyoi.pref.hokkaido.lg.jp']],
  ['茨城県', ['kyoiku.pref.ibaraki.jp']],
  ['栃木県', ['pref.tochigi.lg.jp']],
  ['群馬県', ['pref.gunma.jp']],
  ['埼玉県', ['pref.saitama.lg.jp']],
  ['千葉県', ['pref.chiba.lg.jp']],
  ['神奈川県', ['pref.kanagawa.jp']],
  ['東京都', ['kyoiku.metro.tokyo.lg.jp']],
  // 合成fixture専用。実県を追加するときは、県教委の公式hostを明示登録する。
  ['架空県', ['example.pref.jp']],
])

export function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  const src = text.replace(/^\uFEFF/, '')
  for (let i = 0; i < src.length; i++) {
    const char = src[i]
    if (quoted) {
      if (char === '"' && src[i + 1] === '"') {
        field += '"'
        i++
      } else if (char === '"') {
        quoted = false
      } else {
        field += char
      }
    } else if (char === '"') {
      quoted = true
    } else if (char === ',') {
      row.push(field)
      field = ''
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && src[i + 1] === '\n') i++
      row.push(field)
      field = ''
      if (row.length > 1 || row[0] !== '') rows.push(row)
      row = []
    } else {
      field += char
    }
  }
  if (quoted) throw new Error('CSV の引用符が閉じていません')
  if (field !== '' || row.length > 0) {
    row.push(field)
    if (row.length > 1 || row[0] !== '') rows.push(row)
  }
  return rows
}

function readRecords(path, expectedHeader, { allowEmpty = false, legacyHeader = null } = {}) {
  const rows = parseCsv(readFileSync(path, 'utf8'))
  if (rows.length === 0 || (!allowEmpty && rows.length < 2)) throw new Error(`${basename(path)} にデータ行がありません`)
  const header = rows[0].map((value) => value.trim())
  const isCurrent = header.length === expectedHeader.length && header.every((value, index) => value === expectedHeader[index])
  const isLegacy = legacyHeader != null && header.length === legacyHeader.length && header.every((value, index) => value === legacyHeader[index])
  if (!isCurrent && !isLegacy) {
    throw new Error(`${basename(path)} の列が固定スキーマと一致しません\n期待: ${expectedHeader.join(',')}\n実際: ${header.join(',')}`)
  }
  return rows.slice(1).map((row, rowIndex) => {
    if (row.length !== header.length) throw new Error(`${basename(path)}:${rowIndex + 2} の列数が不正です`)
    const record = Object.fromEntries(header.map((name, index) => [name, (row[index] ?? '').trim()]))
    if (isLegacy) record.school_record_key = ''
    return record
  })
}

const list = (value) => value ? value.split('|').map((item) => item.trim()).filter(Boolean) : []
const schoolIdentity = (row) => row.school_record_key || `${row.pref}\u001f${row.school_name}`
const identity = (row) => [schoolIdentity(row), row.unit_key, row.year, row.selection_stage_code, row.selection_track_code, row.scope_key].join('\u001f')
const unitIdentity = (row) => [schoolIdentity(row), row.unit_key].join('\u001f')
const annualIdentity = (row) => [schoolIdentity(row), row.year].join('\u001f')

function integer(value, label, { nullable = true, min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (value === '') {
    if (nullable) return null
    throw new Error(`${label} は必須です`)
  }
  if (!/^-?\d+$/.test(value)) throw new Error(`${label} は整数で指定してください: ${value}`)
  const result = Number(value)
  if (!Number.isSafeInteger(result) || result < min || result > max) throw new Error(`${label} が範囲外です: ${value}`)
  return result
}

function boolean(value, label) {
  if (value === 'true') return true
  if (value === 'false') return false
  throw new Error(`${label} は true / false で指定してください: ${value}`)
}

function duplicateKeys(rows, keyOf, label) {
  const seen = new Set()
  for (const [index, row] of rows.entries()) {
    const key = keyOf(row)
    if (seen.has(key)) throw new Error(`${label}:${index + 2} に重複キーがあります: ${key.replaceAll('\u001f', ' / ')}`)
    seen.add(key)
  }
}

function requireText(row, fields, label) {
  for (const field of fields) if (!row[field]) throw new Error(`${label}: ${field} は必須です`)
}

function requireCode(value, allowed, label) {
  if (!allowed.has(value)) throw new Error(`${label} がmaster未登録です: ${value}`)
}

export function validateBundle(bundle) {
  const { units, stats, sources, flags } = bundle
  const prefs = new Set([...units, ...stats, ...sources, ...flags].map((row) => row.pref))
  if (prefs.size !== 1 || ![...prefs][0]) throw new Error(`1 bundle = 1都道府県にしてください: ${[...prefs].join(', ')}`)
  const pref = [...prefs][0]
  if (!/(都|道|府|県)$/.test(pref)) throw new Error(`pref は正式都道府県名で指定してください: ${pref}`)

  duplicateKeys(units, unitIdentity, 'units')
  duplicateKeys(stats, identity, 'stats')
  duplicateKeys(sources, (row) => `${identity(row)}\u001f${row.fact_kind_code}`, 'sources')
  duplicateKeys(flags, (row) => `${identity(row)}\u001f${row.metric_code}\u001f${row.reason_code}`, 'flags')

  const unitByKey = new Map()
  for (const [index, row] of units.entries()) {
    const label = `units:${index + 2}`
    requireText(row, ['pref', 'school_name', 'unit_key', 'unit_kind_code', 'unit_label', 'course_time'], label)
    requireCode(row.unit_kind_code, CODES.unitKinds, `${label} unit_kind_code`)
    requireCode(row.course_time, CODES.courseTimes, `${label} course_time`)
    const from = integer(row.valid_from_year, `${label} valid_from_year`, { min: 2000, max: 2100 })
    const to = integer(row.valid_to_year, `${label} valid_to_year`, { min: 2000, max: 2100 })
    if (from != null && to != null && from > to) throw new Error(`${label}: valid_from_year > valid_to_year`)
    const departments = list(row.department_names)
    if (row.unit_kind_code === 'department' && departments.length !== 1) throw new Error(`${label}: department は department_names を1件指定してください`)
    if (row.unit_kind_code === 'department_group' && departments.length < 2) throw new Error(`${label}: department_group は department_names を2件以上指定してください`)
    if (new Set(departments).size !== departments.length) throw new Error(`${label}: department_names が重複しています`)
    unitByKey.set(unitIdentity(row), { ...row, departments })
  }

  const statByKey = new Map()
  for (const [index, row] of stats.entries()) {
    const label = `stats:${index + 2}`
    requireText(row, ['pref', 'school_name', 'unit_key', 'year', 'selection_stage_code', 'selection_track_code', 'stage_label_raw', 'track_label_raw', 'selection_scope_raw', 'scope_key', 'map_role_code', 'is_ratio_comparable'], label)
    if (!unitByKey.has(unitIdentity(row))) throw new Error(`${label}: 対応する募集単位がありません`)
    const year = integer(row.year, `${label} year`, { nullable: false, min: 2000, max: 2100 })
    requireCode(row.selection_stage_code, CODES.stages, `${label} selection_stage_code`)
    requireCode(row.selection_track_code, CODES.tracks, `${label} selection_track_code`)
    requireCode(row.map_role_code, CODES.mapRoles, `${label} map_role_code`)
    const comparable = boolean(row.is_ratio_comparable, `${label} is_ratio_comparable`)
    const numbers = Object.fromEntries(['capacity', 'applicants', 'examinees', 'admitted'].map((field) => [field, integer(row[field], `${label} ${field}`)]))
    if (comparable && (!(numbers.capacity > 0) || numbers.applicants == null)) throw new Error(`${label}: 比較可能行には正のcapacityとapplicantsが必要です`)
    if (row.map_role_code === 'primary_total' && row.selection_stage_code !== 'primary') throw new Error(`${label}: primary_total は selection_stage_code=primary が必要です`)
    if (row.map_role_code === 'primary_total' && !comparable) throw new Error(`${label}: primary_total は is_ratio_comparable=true が必要です`)
    const examComponents = list(row.exam_component_codes)
    for (const code of examComponents) requireCode(code, CODES.examComponents, `${label} exam_component_codes`)
    statByKey.set(identity(row), { ...row, year, comparable, numbers, examComponents })
  }

  const sourceKindsByStat = new Map()
  const sourceByStatFact = new Map()
  for (const [index, row] of sources.entries()) {
    const label = `sources:${index + 2}`
    requireText(row, ['pref', 'school_name', 'unit_key', 'year', 'selection_stage_code', 'selection_track_code', 'scope_key', 'fact_kind_code', 'official_url', 'doc_title', 'source_page_or_table', 'quoted_evidence'], label)
    if (!statByKey.has(identity(row))) throw new Error(`${label}: 対応する選抜統計がありません`)
    requireCode(row.fact_kind_code, CODES.factKinds, `${label} fact_kind_code`)
    let url
    try { url = new URL(row.official_url) } catch { throw new Error(`${label}: official_url がURLではありません`) }
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`${label}: official_url はhttp(s)のみ許可します`)
    if (COMMERCIAL_DOMAINS.some((domain) => url.hostname.includes(domain))) throw new Error(`${label}: 商用受験サイトは禁止です: ${url.hostname}`)
    const allowedHosts = OFFICIAL_HOST_SUFFIXES.get(row.pref)
    const hostname = url.hostname.toLowerCase()
    if (!allowedHosts || !allowedHosts.some((host) => hostname === host || hostname.endsWith(`.${host}`))) {
      throw new Error(`${label}: 県教委の公式hostとして未登録です: ${hostname}`)
    }
    if (row.quoted_evidence.length > 80) throw new Error(`${label}: quoted_evidence は80字以内です`)
    if (row.published_at && !/^\d{4}-\d{2}-\d{2}$/.test(row.published_at)) throw new Error(`${label}: published_at はYYYY-MM-DDです`)
    if (row.last_verified_at && !/^\d{4}-\d{2}-\d{2}$/.test(row.last_verified_at)) throw new Error(`${label}: last_verified_at はYYYY-MM-DDです`)
    const lastHttpStatus = integer(row.last_http_status, `${label} last_http_status`, { min: 100, max: 599 })
    if (Boolean(row.last_verified_at) !== Boolean(row.last_http_status)) throw new Error(`${label}: last_verified_at と last_http_status は両方指定または両方空欄にしてください`)
    const kinds = sourceKindsByStat.get(identity(row)) ?? new Set()
    kinds.add(row.fact_kind_code)
    sourceKindsByStat.set(identity(row), kinds)
    sourceByStatFact.set(`${identity(row)}\u001f${row.fact_kind_code}`, { ...row, lastHttpStatus })
  }

  for (const [index, row] of flags.entries()) {
    const label = `flags:${index + 2}`
    requireText(row, ['pref', 'school_name', 'unit_key', 'year', 'selection_stage_code', 'selection_track_code', 'scope_key', 'reason_code'], label)
    if (!statByKey.has(identity(row))) throw new Error(`${label}: 対応する選抜統計がありません`)
    if (row.metric_code) requireCode(row.metric_code, CODES.metricCodes, `${label} metric_code`)
    requireCode(row.reason_code, CODES.reasons, `${label} reason_code`)
  }

  const flagsByStat = new Set(flags.map(identity))
  for (const [key, stat] of statByKey) {
    if (!stat.comparable && !flagsByStat.has(key)) throw new Error(`比較不能行にreason_codeがありません: ${key.replaceAll('\u001f', ' / ')}`)
  }

  for (const [key, stat] of statByKey) {
    if (!stat.comparable || stat.map_role_code !== 'primary_total') continue
    const kinds = sourceKindsByStat.get(key) ?? new Set()
    if (!kinds.has('capacity') || !kinds.has('applicants')) throw new Error(`比較可能なprimary_totalにcapacity/applicantsの指標別出典がありません: ${key.replaceAll('\u001f', ' / ')}`)
    for (const factKind of ['capacity', 'applicants']) {
      const source = sourceByStatFact.get(`${key}\u001f${factKind}`)
      if (!source?.last_verified_at || source.lastHttpStatus == null || source.lastHttpStatus >= 400) {
        throw new Error(`比較可能なprimary_totalの${factKind}出典は到達確認済みである必要があります: ${key.replaceAll('\u001f', ' / ')}`)
      }
    }
  }

  const eligibleBySchoolYear = new Map()
  for (const stat of statByKey.values()) {
    if (!stat.comparable || stat.map_role_code !== 'primary_total' || stat.selection_stage_code !== 'primary') continue
    const key = annualIdentity(stat)
    const rows = eligibleBySchoolYear.get(key) ?? []
    rows.push(stat)
    eligibleBySchoolYear.set(key, rows)
  }
  for (const [key, rows] of eligibleBySchoolYear) {
    const claimed = new Set()
    let hasSchoolUnit = false
    for (const stat of rows) {
      const unit = unitByKey.get(unitIdentity(stat))
      if (unit.unit_kind_code === 'school' || unit.departments.length === 0) hasSchoolUnit = true
      for (const department of unit.departments) {
        if (claimed.has(department)) throw new Error(`地図対象の募集単位membershipが重複しています: ${key.replaceAll('\u001f', ' / ')} / ${department}`)
        claimed.add(department)
      }
    }
    if (hasSchoolUnit && rows.length > 1) throw new Error(`学校全体行と他の地図対象単位が共存しています: ${key.replaceAll('\u001f', ' / ')}`)
  }

  return { pref, units: [...unitByKey.values()], stats: [...statByKey.values()], sources, flags }
}

export function loadBundle(dir) {
  return validateBundle({
    units: readRecords(join(dir, FILES.units), HEADERS.units, { legacyHeader: LEGACY_HEADERS.units }),
    stats: readRecords(join(dir, FILES.stats), HEADERS.stats, { legacyHeader: LEGACY_HEADERS.stats }),
    sources: readRecords(join(dir, FILES.sources), HEADERS.sources, { legacyHeader: LEGACY_HEADERS.sources }),
    flags: readRecords(join(dir, FILES.flags), HEADERS.flags, { allowEmpty: true, legacyHeader: LEGACY_HEADERS.flags }),
  })
}

const sqlString = (value) => value === '' || value == null ? 'null' : `'${String(value).replaceAll("'", "''")}'`
const sqlRequired = (value) => `'${String(value).replaceAll("'", "''")}'`
const sqlComment = (value) => String(value).replace(/[\r\n]+/g, ' ')

function tempInsert(table, columns, records, valueOf) {
  if (records.length === 0) return `-- ${table}: 0 rows`
  const values = records.map((record) => `  (${columns.map((column) => valueOf(record, column)).join(', ')})`).join(',\n')
  return `insert into ${table} (${columns.join(', ')}) values\n${values};`
}

export function generateSql(bundle, sourceDir = '') {
  const { pref, units, stats, sources, flags } = bundle
  const unitColumns = HEADERS.units
  const statColumns = HEADERS.stats
  const sourceColumns = HEADERS.sources
  const flagColumns = HEADERS.flags
  const textValue = (record, column) => sqlString(record[column])
  const schoolJoin = (inputAlias = 'i') => `(
    (nullif(${inputAlias}.school_record_key,'') is not null
      and s.record_key=${inputAlias}.school_record_key
      and s.prefecture=${inputAlias}.pref
      and s.name=${inputAlias}.school_name)
    or
    (nullif(${inputAlias}.school_record_key,'') is null
      and s.prefecture=${inputAlias}.pref
      and s.name=${inputAlias}.school_name)
  )`

  const lines = [
    'begin;',
    '',
    `-- admission selection v2: ${pref}`,
    `-- generated from ${sqlComment(sourceDir || 'CSV v2 bundle')}; DBへの適用は別途承認が必要。`,
    '',
    `create temp table _adv2_units (${unitColumns.map((name) => `${name} text`).join(', ')}) on commit drop;`,
    `create temp table _adv2_stats (${statColumns.map((name) => `${name} text`).join(', ')}) on commit drop;`,
    `create temp table _adv2_sources (${sourceColumns.map((name) => `${name} text`).join(', ')}) on commit drop;`,
    `create temp table _adv2_flags (${flagColumns.map((name) => `${name} text`).join(', ')}) on commit drop;`,
    '',
    tempInsert('_adv2_units', unitColumns, units, textValue),
    tempInsert('_adv2_stats', statColumns, stats, textValue),
    tempInsert('_adv2_sources', sourceColumns, sources, textValue),
    tempInsert('_adv2_flags', flagColumns, flags, textValue),
    '',
    `do $$
declare n int;
begin
  select count(*) into n from _adv2_units i
   where (
     nullif(i.school_record_key,'') is not null
     and (select count(*) from schools s where s.record_key=i.school_record_key and s.prefecture=i.pref and s.name=i.school_name) <> 1
   ) or (
     nullif(i.school_record_key,'') is null
     and (select count(*) from schools s where s.prefecture=i.pref and s.name=i.school_name) <> 1
   );
  if n > 0 then raise exception 'CSV v2: schools未解決または曖昧 %件', n; end if;
  select count(*) into n
    from _adv2_units i cross join lateral regexp_split_to_table(nullif(i.department_names,''), '\\|') d(name)
    join schools s on ${schoolJoin()}
   where (select count(*) from school_departments sd where sd.school_id=s.id and sd.name=d.name) <> 1;
  if n > 0 then raise exception 'CSV v2: school_departments未解決または曖昧 %件', n; end if;
end $$;`,
    '',
    `delete from admission_recruitment_units
 where school_id in (select id from schools where prefecture=${sqlRequired(pref)});`,
    '',
    `insert into admission_recruitment_units
  (school_id, unit_key, unit_kind_code, label, course_time, valid_from_year, valid_to_year)
select s.id, i.unit_key, i.unit_kind_code, i.unit_label, i.course_time::school_course_time,
       nullif(i.valid_from_year,'')::int, nullif(i.valid_to_year,'')::int
  from _adv2_units i join schools s on ${schoolJoin()};`,
    '',
    `insert into admission_recruitment_unit_departments (unit_id, department_id)
select u.id, sd.id
  from _adv2_units i
  cross join lateral regexp_split_to_table(nullif(i.department_names,''), '\\|') d(name)
  join schools s on ${schoolJoin()}
  join admission_recruitment_units u on u.school_id=s.id and u.unit_key=i.unit_key
  join school_departments sd on sd.school_id=s.id and sd.name=d.name;`,
    '',
    `insert into school_admission_selection_stats
  (recruitment_unit_id, year, selection_stage_code, selection_track_code,
   stage_label_raw, track_label_raw, selection_scope_raw, population_scope_raw,
   scope_key, map_role_code, is_ratio_comparable,
   capacity, applicants, examinees, admitted, exam_scope_raw)
select u.id, i.year::int, i.selection_stage_code, i.selection_track_code,
       nullif(i.stage_label_raw,''), nullif(i.track_label_raw,''), nullif(i.selection_scope_raw,''), nullif(i.population_scope_raw,''),
       i.scope_key, i.map_role_code, i.is_ratio_comparable::boolean,
       nullif(i.capacity,'')::int, nullif(i.applicants,'')::int, nullif(i.examinees,'')::int, nullif(i.admitted,'')::int,
       nullif(i.exam_scope_raw,'')
  from _adv2_stats i
  join schools s on ${schoolJoin()}
  join admission_recruitment_units u on u.school_id=s.id and u.unit_key=i.unit_key;`,
    '',
    `insert into school_admission_stat_exam_components (stat_id, component_code)
select st.id, c.code
  from _adv2_stats i
  cross join lateral regexp_split_to_table(nullif(i.exam_component_codes,''), '\\|') c(code)
  join schools s on ${schoolJoin()}
  join admission_recruitment_units u on u.school_id=s.id and u.unit_key=i.unit_key
  join school_admission_selection_stats st
    on st.recruitment_unit_id=u.id and st.year=i.year::int
   and st.selection_stage_code=i.selection_stage_code and st.selection_track_code=i.selection_track_code and st.scope_key=i.scope_key;`,
    '',
    `insert into school_admission_stat_sources
  (stat_id, fact_kind_code, official_url, doc_title, published_at, source_page_or_table,
   quoted_evidence, last_verified_at, last_http_status)
select st.id, i.fact_kind_code, i.official_url, i.doc_title, nullif(i.published_at,'')::date,
       i.source_page_or_table, nullif(i.quoted_evidence,''), nullif(i.last_verified_at,'')::date,
       nullif(i.last_http_status,'')::int
  from _adv2_sources i
  join schools s on ${schoolJoin()}
  join admission_recruitment_units u on u.school_id=s.id and u.unit_key=i.unit_key
  join school_admission_selection_stats st
    on st.recruitment_unit_id=u.id and st.year=i.year::int
   and st.selection_stage_code=i.selection_stage_code and st.selection_track_code=i.selection_track_code and st.scope_key=i.scope_key;`,
    '',
    `insert into school_admission_stat_quality_flags (stat_id, metric_code, reason_code, note)
select st.id, nullif(i.metric_code,''), i.reason_code, nullif(i.note,'')
  from _adv2_flags i
  join schools s on ${schoolJoin()}
  join admission_recruitment_units u on u.school_id=s.id and u.unit_key=i.unit_key
  join school_admission_selection_stats st
    on st.recruitment_unit_id=u.id and st.year=i.year::int
   and st.selection_stage_code=i.selection_stage_code and st.selection_track_code=i.selection_track_code and st.scope_key=i.scope_key;`,
    '',
    `insert into school_admission_stat_legacy_links (stat_id, legacy_stat_id)
select distinct st.id, legacy.id
  from _adv2_stats i
  join schools s on ${schoolJoin()}
  join admission_recruitment_units u on u.school_id=s.id and u.unit_key=i.unit_key
  join school_admission_selection_stats st
    on st.recruitment_unit_id=u.id and st.year=i.year::int
   and st.selection_stage_code=i.selection_stage_code and st.selection_track_code=i.selection_track_code and st.scope_key=i.scope_key
  left join admission_recruitment_unit_departments ud on ud.unit_id=u.id
  join school_admission_stats legacy
    on legacy.school_id=s.id and legacy.year=st.year
   and legacy.department_id is not distinct from ud.department_id;`,
    '',
    `do $$
declare n int;
begin
  select count(*) into n
    from school_admission_selection_stats st
    join admission_recruitment_units u on u.id=st.recruitment_unit_id
    join schools s on s.id=u.school_id
   where s.prefecture=${sqlRequired(pref)} and st.is_ratio_comparable
     and (st.capacity is null or st.capacity <= 0 or st.applicants is null);
  if n > 0 then raise exception 'CSV v2: 比較可能行の数値制約違反 %件', n; end if;
end $$;`,
    '',
    'commit;',
    '',
  ]
  return lines.join('\n')
}

function parseArgs(argv) {
  const args = { dir: '', out: '', validateOnly: false }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir') args.dir = argv[++i] ?? ''
    else if (argv[i] === '--out') args.out = argv[++i] ?? ''
    else if (argv[i] === '--validate-only') args.validateOnly = true
    else if (argv[i] === '--help' || argv[i] === '-h') args.help = true
    else throw new Error(`不明な引数: ${argv[i]}`)
  }
  return args
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args.dir || (!args.validateOnly && !args.out)) {
    console.error('使い方: node scripts/admission/gen-admission-v2.mjs --dir <bundle-dir> (--out <sql> | --validate-only)')
    process.exit(args.help ? 0 : 2)
  }
  const bundle = loadBundle(args.dir)
  console.error(`検査成功: ${bundle.pref} / units=${bundle.units.length} stats=${bundle.stats.length} sources=${bundle.sources.length} flags=${bundle.flags.length}`)
  if (!args.validateOnly) {
    writeFileSync(args.out, generateSql(bundle, args.dir), 'utf8')
    console.error(`SQLを書き出しました: ${args.out}`)
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try { main() } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
