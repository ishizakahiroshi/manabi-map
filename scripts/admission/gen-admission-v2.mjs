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

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const FILES = {
  units: 'admission-recruitment-units-v2.csv',
  stats: 'admission-selection-stats-v2.csv',
  sources: 'admission-selection-sources-v2.csv',
  flags: 'admission-selection-quality-flags-v2.csv',
  scope: 'replacement-scope.csv',
}

const HEADERS = {
  units: ['pref', 'school_name', 'school_record_key', 'unit_key', 'unit_kind_code', 'unit_label', 'course_time', 'valid_from_year', 'valid_to_year', 'department_names', 'department_record_keys'],
  stats: ['pref', 'school_name', 'school_record_key', 'unit_key', 'year', 'selection_stage_code', 'selection_track_code', 'stage_label_raw', 'track_label_raw', 'selection_scope_raw', 'population_scope_raw', 'scope_key', 'map_role_code', 'is_ratio_comparable', 'capacity', 'applicants', 'examinees', 'admitted', 'exam_scope_raw', 'exam_component_codes'],
  sources: ['pref', 'school_name', 'school_record_key', 'unit_key', 'year', 'selection_stage_code', 'selection_track_code', 'scope_key', 'fact_kind_code', 'official_url', 'doc_title', 'published_at', 'source_page_or_table', 'quoted_evidence', 'last_verified_at', 'last_http_status'],
  flags: ['pref', 'school_name', 'school_record_key', 'unit_key', 'year', 'selection_stage_code', 'selection_track_code', 'scope_key', 'metric_code', 'reason_code', 'note'],
  scope: ['pref', 'school_name', 'school_record_key', 'complete_school_snapshot'],
}

const PREVIOUS_HEADERS = Object.fromEntries(
  Object.entries(HEADERS).map(([kind, header]) => [kind, header.filter((name) => name !== 'department_record_keys')]),
)
const LEGACY_HEADERS = Object.fromEntries(
  Object.entries(PREVIOUS_HEADERS).map(([kind, header]) => [kind, header.filter((name) => name !== 'school_record_key')]),
)

export const CODES = {
  unitKinds: new Set(['department', 'department_group', 'school', 'course_group', 'time_division', 'other', 'unknown']),
  courseTimes: new Set(['fulltime', 'parttime', 'correspondence']),
  stages: new Set(['primary', 'secondary', 'supplemental', 'unknown']),
  tracks: new Set(['general', 'recommendation', 'special', 'combined', 'other', 'unknown']),
  mapRoles: new Set(['primary_total', 'component_only', 'additional_stage', 'detail_only', 'unknown']),
  reasons: new Set(['missing_capacity', 'missing_applicants', 'metric_not_published', 'stage_unknown', 'track_scope_mismatch', 'metric_scope_mismatch', 'recruitment_unit_mismatch', 'overlapping_unit', 'mixed_population', 'source_conflict', 'source_unreachable', 'scheme_changed']),
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
  ['徳島県', ['pref.tokushima.lg.jp', 'nyuushi.tokushima-ec.ed.jp', 'tokushima-ec.ed.jp', 'kosen-k.go.jp', 'anan-nct.ac.jp', 'kamiyama.ac.jp']],
  ['香川県', ['pref.kagawa.lg.jp', 'taka-ichi-h.ed.jp', 'kagawa-nct.ac.jp', 'fujii.ed.jp', 'sangawa.ed.jp']],
  ['高知県', ['pref.kochi.lg.jp', 'city.kochi.kochi.jp', 'kochi-ct.ac.jp', 'kosen-k.go.jp', 'mext.go.jp', 'daiichigakuin.ed.jp', 'hchs.ed.jp', 'kochigakuen.jp', 'tosa.ed.jp', 'tosajoshi-jh.ed.jp', 'seiwa-girl.ed.jp', 'kochi-gakugei.ed.jp', 'kochi-chuo.ed.jp', 'meitoku-gijuku.ed.jp', 'tosajuku.ed.jp', 'taiheiyo.ed.jp']],
  ['愛媛県', ['pref.ehime.jp', 'ehime-kyoiku.esnet.ed.jp', 'ehime-c.esnet.ed.jp', 'hi.ehime-u.ac.jp', 'niihama-nct.ac.jp', 'yuge.ac.jp']],
  ['鳥取県', ['pref.tottori.lg.jp']],
  ['島根県', ['pref.shimane.lg.jp', 'minamigaoka-girls-hs.matsue.ed.jp']],
  ['岡山県', ['pref.okayama.jp', 'edu.city.bizen.okayama.jp']],
  ['広島県', ['pref.hiroshima.lg.jp', 'city.hiroshima.lg.jp', 'city.onomichi.hiroshima.jp', 'city.fukuyama.hiroshima.jp', 'city.kure.lg.jp']],
  ['山口県', ['pref.yamaguchi.lg.jp']],
  ['岐阜県', ['pref.gifu.lg.jp', 'mext.go.jp', 'school.gifu-net.ed.jp', 'city.gifu.lg.jp', 'city.seki.lg.jp', 'city.nakatsugawa.lg.jp', 'gifu-nct.ac.jp']],
  ['静岡県', ['pref.shizuoka.jp', 'mext.go.jp', 'city.shizuoka.lg.jp', 'city.hamamatsu.shizuoka.jp', 'numazu-ct.ac.jp']],
  ['愛知県', ['pref.aichi.jp', 'mext.go.jp', 'city.nagoya.jp', 'toyota-ct.ac.jp', 'city.toyohashi.lg.jp']],
  ['三重県', ['pref.mie.lg.jp', 'mext.go.jp']],
  ['滋賀県', ['pref.shiga.lg.jp', 'mext.go.jp']],
  ['奈良県', ['pref.nara.lg.jp', 'mext.go.jp', 'nara-k.ac.jp', 'nwuss.nara-wu.ac.jp']],
  ['和歌山県', ['pref.wakayama.lg.jp', 'wave.pref.wakayama.lg.jp', 'mext.go.jp', 'wakayama-nct.ac.jp']],
  ['京都府', ['kyoto-be.ne.jp', 'pref.kyoto.jp', 'city.kyoto.lg.jp', 'kyokyo-u.ac.jp', 'maizuru-ct.ac.jp', 'kosen-k.go.jp', 'mext.go.jp']],
  ['大阪府', ['pref.osaka.lg.jp', 'city.osaka.lg.jp', 'city.higashiosaka.lg.jp', 'city.sakai.lg.jp', 'city.kishiwada.lg.jp', 'osaka-kyoiku.ac.jp', 'ct.omu.ac.jp', 'mext.go.jp']],
  // 兵庫県: 市立20校は神戸10/姫路4/尼崎3/西宮2/伊丹1/明石1。西宮市の公式は nishi.or.jp。
  // hyogo-c.ed.jp は県立の共通ホストで www2. / dmzcms. / www. すべて suffix 一致で通る。
  ['兵庫県', ['mext.go.jp', 'hyogo-c.ed.jp', 'pref.hyogo.lg.jp', 'city.kobe.lg.jp', 'city.amagasaki.hyogo.jp', 'city.himeji.lg.jp', 'nishi.or.jp', 'city.itami.lg.jp', 'city.akashi.lg.jp', 'kobe-kosen.ac.jp']],
  ['福岡県', ['mext.go.jp', 'pref.fukuoka.lg.jp', 'fku.ed.jp', 'city.fukuoka.lg.jp', 'city.kitakyushu.lg.jp', 'kita9.ed.jp', 'f-sigaku.com', 'ariake-nct.ac.jp', 'kct.ac.jp', 'kurume-nct.ac.jp']],
  ['佐賀県', ['mext.go.jp', 'pref.saga.lg.jp', 'saga-ed.jp', 'saga-high-school.jp', 'education.saga.jp', 'sy.pref.saga.lg.jp']],
  ['長崎県', ['mext.go.jp', 'pref.nagasaki.jp', 'news.ed.jp', 'city.nagasaki.lg.jp', 'nagasaki-city.ed.jp', 'city.sasebo.lg.jp', 'ed.city.sasebo.nagasaki.jp', 'sasebo-nct.ac.jp']],
  ['大分県', ['mext.go.jp', 'pref.oita.jp', 'oen.ed.jp', 'oita-ed.jp', 'city.oita.oita.jp', 'oita-ct.ac.jp']],
  // 熊本県: sh.higo.ed.jp は県立高校の共通ホスト（佐賀 education.saga.jp と同型のper-school経路）。
  // 末尾4件は県立高が独自ドメインで持つ学校公式（2026-07-21 に親がHTTP実測して追加）。
  // 八代清流は sites.google.com 上にあるが、共有ホストを許可すると任意のGoogle Sitesが通るため登録しない。
  ['熊本県', ['mext.go.jp', 'pref.kumamoto.jp', 'sh.higo.ed.jp', 'city.kumamoto.jp', 'kumamoto-kmm.ed.jp', 'kumamoto-pref-hs.jp', 'k-shigaku.com', 'kumamoto-nct.ac.jp', 'seiseiko-hs.ed.jp', 'kumamoto-kitako.ed.jp', 'kumamoto-d2hs.ed.jp', 'yatsushirohighschool.com']],
  // 鹿児島県: edu.pref.kagoshima.jp（県立per-school・<school>.edu.pref.kagoshima.jp 形式）は
  // pref.kagoshima.jp の suffix 一致で通るため個別登録しない。
  // keinet.com は「鹿児島市立学校ICT推進センター」が市立校の公式サイトを置くhost。
  // 商用受験サイトの keinet.ne.jp（河合塾Kei-Net）とは別物なので混同しないこと。
  ['鹿児島県', ['mext.go.jp', 'pref.kagoshima.jp', 'city.kagoshima.lg.jp', 'keinet.com', 'city.kanoya.lg.jp', 'kagoshima-ct.ac.jp']],
  // 宮崎県: 県は lg.jp（sun.pref.miyazaki.lg.jp も suffix 一致で通る）。
  ['宮崎県', ['mext.go.jp', 'pref.miyazaki.lg.jp', 'miyazaki-c.ed.jp', 'miyazaki-shigaku.jp', 'miyakonojo-nct.ac.jp']],
  // 沖縄県: pref.okinawa.lg.jp と pref.okinawa.jp は別hostとして両方使われる。
  // open.ed.jp は県立高の per-school ホスト。実働形は `www.<slug>-h.open.ed.jp`（**www. 必須**・
  // www 無しは DNS は引けるが HTTP 503）。2026-07-21 に親が実測して追加した。
  ['沖縄県', ['mext.go.jp', 'pref.okinawa.lg.jp', 'pref.okinawa.jp', 'okinawa-shigaku.jp', 'okinawa-ct.ac.jp', 'open.ed.jp']],
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
  const compatibleHeaders = legacyHeader == null ? [] : (Array.isArray(legacyHeader[0]) ? legacyHeader : [legacyHeader])
  const compatible = compatibleHeaders.find((candidate) => header.length === candidate.length && header.every((value, index) => value === candidate[index]))
  if (!isCurrent && !compatible) {
    throw new Error(`${basename(path)} の列が固定スキーマと一致しません\n期待: ${expectedHeader.join(',')}\n実際: ${header.join(',')}`)
  }
  return rows.slice(1).map((row, rowIndex) => {
    if (row.length !== header.length) throw new Error(`${basename(path)}:${rowIndex + 2} の列数が不正です`)
    const record = Object.fromEntries(header.map((name, index) => [name, (row[index] ?? '').trim()]))
    for (const field of expectedHeader) if (!(field in record)) record[field] = ''
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
  const { units, stats, sources, flags, replacementScope = [] } = bundle
  const prefs = new Set([...units, ...stats, ...sources, ...flags, ...replacementScope].map((row) => row.pref))
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
    const departmentRecordKeys = list(row.department_record_keys)
    if (row.unit_kind_code === 'department' && departments.length !== 1) throw new Error(`${label}: department は department_names を1件指定してください`)
    if (row.unit_kind_code === 'department_group' && departments.length < 2) throw new Error(`${label}: department_group は department_names を2件以上指定してください`)
    if (new Set(departments).size !== departments.length) throw new Error(`${label}: department_names が重複しています`)
    if (departmentRecordKeys.length > 0 && departmentRecordKeys.length !== departments.length) throw new Error(`${label}: department_names と department_record_keys の件数が一致しません`)
    if (new Set(departmentRecordKeys).size !== departmentRecordKeys.length) throw new Error(`${label}: department_record_keys が重複しています`)
    unitByKey.set(unitIdentity(row), { ...row, departments, departmentRecordKeys })
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
    if (url.username || url.password || url.port) throw new Error(`${label}: official_url にuserinfo・password・portは許可しません`)
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

  const scopeBySchool = new Map()
  for (const [index, row] of replacementScope.entries()) {
    const label = `replacement-scope:${index + 2}`
    requireText(row, ['pref', 'school_name', 'school_record_key', 'complete_school_snapshot'], label)
    if (boolean(row.complete_school_snapshot, `${label} complete_school_snapshot`) !== true) {
      throw new Error(`${label}: complete_school_snapshot=true の学校だけを置換できます`)
    }
    const key = schoolIdentity(row)
    if (scopeBySchool.has(key)) throw new Error(`${label}: school_record_key が重複しています`)
    scopeBySchool.set(key, row)
  }

  return { pref, units: [...unitByKey.values()], stats: [...statByKey.values()], sources, flags, replacementScope: [...scopeBySchool.values()] }
}

export function loadBundle(dir) {
  const scopePath = join(dir, FILES.scope)
  return validateBundle({
    units: readRecords(join(dir, FILES.units), HEADERS.units, { legacyHeader: [PREVIOUS_HEADERS.units, LEGACY_HEADERS.units] }),
    stats: readRecords(join(dir, FILES.stats), HEADERS.stats, { legacyHeader: LEGACY_HEADERS.stats }),
    sources: readRecords(join(dir, FILES.sources), HEADERS.sources, { legacyHeader: LEGACY_HEADERS.sources }),
    flags: readRecords(join(dir, FILES.flags), HEADERS.flags, { allowEmpty: true, legacyHeader: LEGACY_HEADERS.flags }),
    replacementScope: existsSync(scopePath) ? readRecords(scopePath, HEADERS.scope) : [],
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

export function generateSql(bundle, sourceDir = '', { inputSchoolsOnly = false, fragment = false } = {}) {
  const { pref, units, stats, sources, flags, replacementScope = [] } = bundle
  if (inputSchoolsOnly && units.some((row) => !row.school_record_key)) {
    throw new Error('対象校限定モードでは全募集単位にschool_record_keyが必要')
  }
  if (inputSchoolsOnly && replacementScope.length === 0) {
    throw new Error('対象校限定モードではreplacement-scope.csvが必要')
  }
  if (inputSchoolsOnly && units.some((row) => row.departments.length > 0 && row.departmentRecordKeys.length !== row.departments.length)) {
    throw new Error('対象校限定モードでは全学科にdepartment_record_keysが必要')
  }
  if (inputSchoolsOnly) {
    const unitSchools = new Set(units.map((row) => row.school_record_key))
    const scopeSchools = new Set(replacementScope.map((row) => row.school_record_key))
    if (unitSchools.size !== scopeSchools.size || [...unitSchools].some((key) => !scopeSchools.has(key))) {
      throw new Error('replacement-scope.csvと募集単位の学校集合が一致しません')
    }
  }
  const unitColumns = HEADERS.units
  const statColumns = HEADERS.stats
  const sourceColumns = HEADERS.sources
  const flagColumns = HEADERS.flags
  const scopeColumns = HEADERS.scope
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
  const departmentJoin = `(
    (nullif(split_part(i.department_record_keys,'|',d.ord::int),'') is not null
      and sd.record_key=split_part(i.department_record_keys,'|',d.ord::int)
      and sd.school_id=s.id
      and sd.name=d.name)
    or
    (nullif(split_part(i.department_record_keys,'|',d.ord::int),'') is null
      and sd.school_id=s.id
      and sd.name=d.name)
  )`
  const replacementWhere = inputSchoolsOnly
    ? `school_id in (select school_id from _adv2_target_schools)`
    : `school_id in (select id from schools where prefecture=${sqlRequired(pref)})`
  const validationScope = inputSchoolsOnly
    ? `and u.school_id in (select school_id from _adv2_target_schools)`
    : ''
  const expectedMemberships = units.reduce((sum, row) => sum + row.departments.length, 0)
  const expectedComponents = bundle.stats.reduce((sum, row) => sum + row.examComponents.length, 0)

  const lines = [
    ...(fragment ? [] : ['begin;', '']),
    `-- admission selection v2: ${pref}`,
    `-- generated from ${sqlComment(sourceDir || 'CSV v2 bundle')}; DBへの適用は別途承認が必要。`,
    `-- replacement scope: ${inputSchoolsOnly ? 'input school_record_keys only' : 'whole prefecture'}.`,
    `-- transaction owner: ${fragment ? 'outer apply-candidate.sql' : 'this generated file'}.`,
    '',
    `create temp table _adv2_units (${unitColumns.map((name) => `${name} text`).join(', ')}) on commit drop;`,
    `create temp table _adv2_stats (${statColumns.map((name) => `${name} text`).join(', ')}) on commit drop;`,
    `create temp table _adv2_sources (${sourceColumns.map((name) => `${name} text`).join(', ')}) on commit drop;`,
    `create temp table _adv2_flags (${flagColumns.map((name) => `${name} text`).join(', ')}) on commit drop;`,
    `create temp table _adv2_scope (${scopeColumns.map((name) => `${name} text`).join(', ')}) on commit drop;`,
    '',
    tempInsert('_adv2_units', unitColumns, units, textValue),
    tempInsert('_adv2_stats', statColumns, stats, textValue),
    tempInsert('_adv2_sources', sourceColumns, sources, textValue),
    tempInsert('_adv2_flags', flagColumns, flags, textValue),
    tempInsert('_adv2_scope', scopeColumns, replacementScope, textValue),
    '',
    `create temp table _adv2_target_schools (school_id uuid primary key) on commit drop;`,
    inputSchoolsOnly
      ? `insert into _adv2_target_schools (school_id)
select s.id
  from _adv2_scope i
  join schools s on ${schoolJoin()};`
      : `insert into _adv2_target_schools (school_id)
select id from schools where prefecture=${sqlRequired(pref)};`,
    '',
    `do $$
declare n int;
begin
  select count(*) into n from _adv2_target_schools;
  if n <> ${inputSchoolsOnly ? replacementScope.length : `(select count(*) from schools where prefecture=${sqlRequired(pref)})`} then
    raise exception 'CSV v2: replacement scopeの学校解決件数不一致 %件', n;
  end if;
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
    from _adv2_units i
    cross join lateral regexp_split_to_table(nullif(i.department_names,''), '\\|') with ordinality d(name, ord)
    join schools s on ${schoolJoin()}
   where (select count(*) from school_departments sd where ${departmentJoin}) <> 1;
  if n > 0 then raise exception 'CSV v2: school_departments未解決または曖昧 %件', n; end if;
end $$;`,
    '',
    `create temp view _adv2_outside_rows as
select 'admission_recruitment_units'::text table_name, u.id::text row_key, to_jsonb(u)::text row_value
  from admission_recruitment_units u where u.school_id not in (select school_id from _adv2_target_schools)
union all
select 'admission_recruitment_unit_departments', m.unit_id::text || ':' || m.department_id::text, to_jsonb(m)::text
  from admission_recruitment_unit_departments m
  join admission_recruitment_units u on u.id=m.unit_id
 where u.school_id not in (select school_id from _adv2_target_schools)
union all
select 'school_admission_selection_stats', st.id::text, to_jsonb(st)::text
  from school_admission_selection_stats st
  join admission_recruitment_units u on u.id=st.recruitment_unit_id
 where u.school_id not in (select school_id from _adv2_target_schools)
union all
select 'school_admission_stat_exam_components', c.stat_id::text || ':' || c.component_code, to_jsonb(c)::text
  from school_admission_stat_exam_components c
  join school_admission_selection_stats st on st.id=c.stat_id
  join admission_recruitment_units u on u.id=st.recruitment_unit_id
 where u.school_id not in (select school_id from _adv2_target_schools)
union all
select 'school_admission_stat_sources', so.stat_id::text || ':' || so.fact_kind_code, to_jsonb(so)::text
  from school_admission_stat_sources so
  join school_admission_selection_stats st on st.id=so.stat_id
  join admission_recruitment_units u on u.id=st.recruitment_unit_id
 where u.school_id not in (select school_id from _adv2_target_schools)
union all
select 'school_admission_stat_quality_flags', q.stat_id::text || ':' || coalesce(q.metric_code,'') || ':' || q.reason_code, to_jsonb(q)::text
  from school_admission_stat_quality_flags q
  join school_admission_selection_stats st on st.id=q.stat_id
  join admission_recruitment_units u on u.id=st.recruitment_unit_id
 where u.school_id not in (select school_id from _adv2_target_schools)
union all
select 'school_admission_stat_legacy_links', l.stat_id::text || ':' || l.legacy_stat_id::text, to_jsonb(l)::text
  from school_admission_stat_legacy_links l
  join school_admission_selection_stats st on st.id=l.stat_id
  join admission_recruitment_units u on u.id=st.recruitment_unit_id
 where u.school_id not in (select school_id from _adv2_target_schools);`,
    `create temp table _adv2_outside_baseline on commit drop as
select names.table_name,
       count(r.row_key)::bigint as row_count,
       encode(extensions.digest(coalesce(string_agg(r.row_value, E'\\n' order by r.row_key), ''), 'sha256'), 'hex') as digest
  from (values
    ('admission_recruitment_units'),
    ('admission_recruitment_unit_departments'),
    ('school_admission_selection_stats'),
    ('school_admission_stat_exam_components'),
    ('school_admission_stat_sources'),
    ('school_admission_stat_quality_flags'),
    ('school_admission_stat_legacy_links')
  ) names(table_name)
  left join _adv2_outside_rows r using (table_name)
 group by names.table_name;`,
    '',
    `delete from admission_recruitment_units
 where ${replacementWhere};`,
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
  cross join lateral regexp_split_to_table(nullif(i.department_names,''), '\\|') with ordinality d(name, ord)
  join schools s on ${schoolJoin()}
  join admission_recruitment_units u on u.school_id=s.id and u.unit_key=i.unit_key
  join school_departments sd on ${departmentJoin};`,
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
   where s.prefecture=${sqlRequired(pref)} ${validationScope} and st.is_ratio_comparable
     and (st.capacity is null or st.capacity <= 0 or st.applicants is null);
  if n > 0 then raise exception 'CSV v2: 比較可能行の数値制約違反 %件', n; end if;

  select count(*) into n from admission_recruitment_units
   where school_id in (select school_id from _adv2_target_schools);
  if n <> ${units.length} then raise exception 'CSV v2: target units件数不一致 expected=${units.length} actual=%', n; end if;

  select count(*) into n
    from admission_recruitment_unit_departments m
    join admission_recruitment_units u on u.id=m.unit_id
   where u.school_id in (select school_id from _adv2_target_schools);
  if n <> ${expectedMemberships} then raise exception 'CSV v2: target memberships件数不一致 expected=${expectedMemberships} actual=%', n; end if;

  select count(*) into n
    from school_admission_selection_stats st
    join admission_recruitment_units u on u.id=st.recruitment_unit_id
   where u.school_id in (select school_id from _adv2_target_schools);
  if n <> ${stats.length} then raise exception 'CSV v2: target stats件数不一致 expected=${stats.length} actual=%', n; end if;

  select count(*) into n
    from school_admission_stat_exam_components c
    join school_admission_selection_stats st on st.id=c.stat_id
    join admission_recruitment_units u on u.id=st.recruitment_unit_id
   where u.school_id in (select school_id from _adv2_target_schools);
  if n <> ${expectedComponents} then raise exception 'CSV v2: target components件数不一致 expected=${expectedComponents} actual=%', n; end if;

  select count(*) into n
    from school_admission_stat_sources so
    join school_admission_selection_stats st on st.id=so.stat_id
    join admission_recruitment_units u on u.id=st.recruitment_unit_id
   where u.school_id in (select school_id from _adv2_target_schools);
  if n <> ${sources.length} then raise exception 'CSV v2: target sources件数不一致 expected=${sources.length} actual=%', n; end if;

  select count(*) into n
    from school_admission_stat_quality_flags q
    join school_admission_selection_stats st on st.id=q.stat_id
    join admission_recruitment_units u on u.id=st.recruitment_unit_id
   where u.school_id in (select school_id from _adv2_target_schools);
  if n <> ${flags.length} then raise exception 'CSV v2: target flags件数不一致 expected=${flags.length} actual=%', n; end if;

  with actual as (
    select names.table_name,
           count(r.row_key)::bigint as row_count,
           encode(extensions.digest(coalesce(string_agg(r.row_value, E'\\n' order by r.row_key), ''), 'sha256'), 'hex') as digest
      from (values
        ('admission_recruitment_units'),
        ('admission_recruitment_unit_departments'),
        ('school_admission_selection_stats'),
        ('school_admission_stat_exam_components'),
        ('school_admission_stat_sources'),
        ('school_admission_stat_quality_flags'),
        ('school_admission_stat_legacy_links')
      ) names(table_name)
      left join _adv2_outside_rows r using (table_name)
     group by names.table_name
  )
  select count(*) into n
    from _adv2_outside_baseline b
    full join actual a using (table_name)
   where b.row_count is distinct from a.row_count or b.digest is distinct from a.digest;
  if n <> 0 then raise exception 'CSV v2: 対象外admission fingerprint差分 %表', n; end if;
end $$;`,
    '',
    ...(fragment ? [] : ['commit;', '']),
  ]
  return lines.join('\n')
}

function parseArgs(argv) {
  const args = { dir: '', out: '', validateOnly: false, inputSchoolsOnly: false, fragment: false }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dir') args.dir = argv[++i] ?? ''
    else if (argv[i] === '--out') args.out = argv[++i] ?? ''
    else if (argv[i] === '--validate-only') args.validateOnly = true
    else if (argv[i] === '--input-schools-only') args.inputSchoolsOnly = true
    else if (argv[i] === '--fragment') args.fragment = true
    else if (argv[i] === '--help' || argv[i] === '-h') args.help = true
    else throw new Error(`不明な引数: ${argv[i]}`)
  }
  return args
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args.dir || (!args.validateOnly && !args.out)) {
    console.error('使い方: node scripts/admission/gen-admission-v2.mjs --dir <bundle-dir> (--out <sql> | --validate-only) [--input-schools-only] [--fragment]')
    process.exit(args.help ? 0 : 2)
  }
  const bundle = loadBundle(args.dir)
  console.error(`検査成功: ${bundle.pref} / units=${bundle.units.length} stats=${bundle.stats.length} sources=${bundle.sources.length} flags=${bundle.flags.length}`)
  const sql = (args.inputSchoolsOnly || !args.validateOnly)
    ? generateSql(bundle, args.dir, { inputSchoolsOnly: args.inputSchoolsOnly, fragment: args.fragment })
    : null
  if (!args.validateOnly) {
    writeFileSync(args.out, sql, 'utf8')
    console.error(`SQLを書き出しました: ${args.out}`)
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try { main() } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
