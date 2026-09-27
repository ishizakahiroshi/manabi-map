// School input only: importing this module never reads env, connects, or emits artifacts.
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { GENERATOR_SCHOOL_SELECT } from '../../src/lib/school-select.ts'

const columns = (text) => text.split(', ')
export const SNAPSHOT_COLUMNS = {
  schools: GENERATOR_SCHOOL_SELECT.split(', school_field_sources(')[0].split(', '),
  school_departments: columns('id, school_id, name, course_type, ui_group'),
  school_deviation_values: columns('school_id, department_id, value, is_active'),
  school_admission_stats: columns('school_id, id, department_id, year, capacity, applicants, examinees, admitted, note, source_url'),
  school_field_sources: columns('school_id, field_name, official_url, doc_title, published_at, source_page_or_table, last_verified_at, last_http_status, is_official_source'),
  school_relationships: columns('predecessor_school_id, successor_school_id, id, relationship_type_code, effective_on, official_url, notes'),
  school_name_history: columns('school_id, id, name, name_kana, valid_from, valid_to, official_url, notes'),
  admission_recruitment_units: columns('school_id, id, unit_key, unit_kind_code, label, course_time, valid_from_year, valid_to_year'),
  admission_recruitment_unit_departments: columns('unit_id, department_id'),
  school_admission_selection_stats: columns('recruitment_unit_id, id, year, selection_stage_code, selection_track_code, stage_label_raw, track_label_raw, selection_scope_raw, population_scope_raw, scope_key, map_role_code, is_ratio_comparable, capacity, applicants, examinees, admitted, exam_scope_raw'),
  school_admission_stat_exam_components: columns('stat_id, component_code'),
  school_admission_stat_quality_flags: columns('stat_id, metric_code, reason_code, note'),
  school_admission_stat_sources: columns('stat_id, fact_kind_code, official_url, doc_title, published_at, source_page_or_table, quoted_evidence, last_verified_at, last_http_status'),
}
export const SOURCE_TABLES = [
  ...Object.keys(SNAPSHOT_COLUMNS), 'school_admission_stat_legacy_links',
  'course_type_master', 'school_lifecycle_status_master', 'school_recruitment_status_master',
  'school_relationship_type_master', 'school_field_source_field_master',
  'admission_recruitment_unit_kind_master', 'admission_selection_stage_master',
  'admission_selection_track_master', 'admission_map_role_master',
  'admission_exam_component_master', 'admission_quality_reason_master',
]
// Keep identical to store_school.CODE_FILES; the integration test compares them.
export const REQUIRED_CODE_FILES = [
  'scripts/local-data/store.py', 'scripts/local-data/store_core.py',
  'scripts/local-data/schema-core.sql', 'scripts/local-data/store_school.py',
  'scripts/local-data/school_history.py', 'scripts/local-data/schema-history.sql',
  'scripts/local-data/school_admission.py', 'scripts/local-data/schema-admission.sql',
  'web/scripts/lib/school-source.mjs', 'web/scripts/gen-schools-json.mjs',
  'web/src/lib/school-select.ts', 'web/scripts/lib/public-api.mjs',
  'web/src/lib/mapPayload.ts', 'web/src/lib/admissionUnits.ts', 'web/src/lib/admission.ts',
]
// The live exporter is an explicit additional code identity, never a reason to
// relax the original synthetic parser or its exact manifest inventory.
export const LIVE_CODE_FILES = [...REQUIRED_CODE_FILES, 'scripts/local-data/school_live_source.py'].sort()

function requireValue(condition, message) {
  if (!condition) throw new Error(`Invalid school source: ${message}`)
}
function exactKeys(value, keys, label) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value), `${label} object required`)
  requireValue(JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()), `${label} columns differ`)
}
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex')
const isHash = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)

// Hash wire format: sorted object keys, preserved arrays, plain finite numbers.
// The only noninteger source numbers are coordinates (at most seven decimals).
export function canonicalSchoolSourceJSON(value) {
  if (typeof value === 'number') {
    requireValue(Number.isFinite(value) && (Number.isInteger(value) ? Number.isSafeInteger(value) : Number(value.toFixed(7)) === value), 'unsupported number precision')
    return Number.isInteger(value) ? String(value) : value.toFixed(7).replace(/0+$/, '').replace(/\.$/, '')
  }
  if (Array.isArray(value)) return `[${value.map(canonicalSchoolSourceJSON).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalSchoolSourceJSON(value[key])}`).join(',')}}`
  return JSON.stringify(value)
}

function parseStrictJSON(bytes) {
  const text = bytes.toString()
  const result = JSON.parse(text)
  // JSON.parse accepts repeated object keys. Check the already syntax-validated
  // token stream too, so Python and JS reject the same ambiguous envelopes.
  const tokens = text.match(/"(?:\\[\s\S]|[^"\\])*"|[{}[\]:,]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g)
  let cursor = 0
  function visit() {
    const token = tokens[cursor++]
    if (token === '{') {
      const keys = new Set()
      while (tokens[cursor] !== '}') {
        const key = JSON.parse(tokens[cursor++])
        requireValue(!keys.has(key), 'duplicate JSON key')
        keys.add(key)
        cursor++ // colon
        visit()
        if (tokens[cursor] === ',') cursor++
      }
      cursor++
    } else if (token === '[') {
      while (tokens[cursor] !== ']') {
        visit()
        if (tokens[cursor] === ',') cursor++
      }
      cursor++
    }
  }
  visit()
  return result
}

const BOOLEAN_COLUMNS = new Set(['is_integrated', 'is_active', 'is_recruiting', 'is_official_source', 'is_ratio_comparable'])
const INTEGER_COLUMNS = new Set(['year', 'value', 'capacity', 'applicants', 'examinees', 'admitted', 'total_students', 'enrollment_year', 'male_ratio', 'recruitment_ended_year', 'valid_from_year', 'valid_to_year', 'last_http_status'])
function validateProjectedValue(column, value) {
  if (BOOLEAN_COLUMNS.has(column)) requireValue(typeof value === 'boolean', `${column} boolean`)
  else if (column === 'course_times') requireValue(Array.isArray(value) && value.length > 0 && value.every((item) => ['fulltime', 'parttime', 'correspondence'].includes(item)), 'course_times')
  else if (value === null) return
  else if (column === 'latitude' || column === 'longitude') {
    // Preserve PostgreSQL numeric(10,7), including non-geographic boundary values.
    // The source contract does not impose geographic latitude/longitude checks.
    requireValue(typeof value === 'number' && Number.isFinite(value) && Math.abs(value) < 1000 && Number(value.toFixed(7)) === value, `${column} numeric coordinate`)
  } else if (INTEGER_COLUMNS.has(column)) requireValue(Number.isSafeInteger(value), `${column} integer`)
  else requireValue(typeof value === 'string', `${column} string`)
}

/** Validate the complete pair before exposing any rows. No fallback on failure. */
export function parseSchoolSnapshot(snapshotBytes, manifestBytes) {
  return parseSnapshotPair(snapshotBytes, manifestBytes, true, REQUIRED_CODE_FILES)
}

/** Explicit live-source contract. This label is not proof of production origin. */
export function parseObservedSchoolSnapshot(snapshotBytes, manifestBytes) {
  return parseSnapshotPair(snapshotBytes, manifestBytes, false, LIVE_CODE_FILES)
}

function parseSnapshotPair(snapshotBytes, manifestBytes, synthetic, requiredCodeFiles) {
  const snapshot = parseStrictJSON(snapshotBytes)
  const manifest = parseStrictJSON(manifestBytes)
  exactKeys(snapshot, ['format', 'format_version', 'schema_version', 'synthetic', 'dataset_version', 'source_version', 'tables'], 'snapshot')
  exactKeys(manifest, ['format', 'format_version', 'schema_version', 'synthetic', 'dataset_version', 'source_version', 'created_at', 'table_counts', 'content_sha256', 'snapshot_sha256', 'code'], 'manifest')
  requireValue(snapshot.format === 'school-source-snapshot' && manifest.format === 'school-source-manifest', 'format')
  for (const object of [snapshot, manifest]) {
    requireValue(object.format_version === 1 && object.schema_version === 3 && object.synthetic === synthetic, 'version or synthetic scope')
    for (const key of ['dataset_version', 'source_version']) {
      requireValue(typeof object[key] === 'string' && object[key].trim().length > 0, key)
      requireValue(object[key] === snapshot[key], `${key} mismatch`)
    }
  }
  requireValue(isHash(manifest.snapshot_sha256) && digest(snapshotBytes) === manifest.snapshot_sha256, 'snapshot hash')
  requireValue(isHash(manifest.content_sha256) && digest(canonicalSchoolSourceJSON(snapshot)) === manifest.content_sha256, 'content hash')
  requireValue(typeof manifest.created_at === 'string' && Number.isFinite(Date.parse(manifest.created_at)), 'created_at')
  requireValue(manifest.code?.identity === 'sha256' && Array.isArray(manifest.code.files) && manifest.code.files.length > 0, 'code identity')
  exactKeys(manifest.code, ['identity', 'files', 'sha256'], 'code')
  const codePaths = new Set()
  for (const file of manifest.code.files) {
    exactKeys(file, ['path', 'sha256'], 'code file')
    requireValue(typeof file.path === 'string' && /^[a-zA-Z0-9_./-]+$/.test(file.path) && !file.path.startsWith('/') && !file.path.split('/').includes('..') && isHash(file.sha256), 'code file identity')
    requireValue(!codePaths.has(file.path), 'duplicate code file')
    codePaths.add(file.path)
  }
  requireValue(codePaths.size === requiredCodeFiles.length && requiredCodeFiles.every((path) => codePaths.has(path)), 'code files differ')
  requireValue(isHash(manifest.code.sha256) && digest(canonicalSchoolSourceJSON(manifest.code.files)) === manifest.code.sha256, 'code hash')
  exactKeys(manifest.table_counts, SOURCE_TABLES, 'table_counts')
  for (const count of Object.values(manifest.table_counts)) requireValue(Number.isSafeInteger(count) && count >= 0, 'table count')
  exactKeys(snapshot.tables, Object.keys(SNAPSHOT_COLUMNS), 'tables')
  for (const [table, allowed] of Object.entries(SNAPSHOT_COLUMNS)) {
    const rows = snapshot.tables[table]
    requireValue(Array.isArray(rows) && rows.length === manifest.table_counts[table], `${table} count`)
    for (const row of rows) {
      exactKeys(row, allowed, table)
      for (const [column, value] of Object.entries(row)) validateProjectedValue(column, value)
    }
  }
  return snapshot
}

const pick = (row, keys) => Object.fromEntries(keys.map((key) => [key, row[key]]))
const omit = (row, keys) => Object.fromEntries(Object.entries(row).filter(([key]) => !keys.includes(key)))
const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0

// Sort relations by stable keys, preserve scalar arrays (notably course_times).
function canonical(value) {
  if (Array.isArray(value)) {
    const result = value.map(canonical)
    if (result.every((item) => item && typeof item === 'object')) {
      result.sort((a, b) => compareText(a.id ?? '', b.id ?? '') || compareText(JSON.stringify(a), JSON.stringify(b)))
    }
    return result
  }
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
  return value
}
export function canonicalizeGeneratorRows(rows) {
  return rows.map(canonical).sort((a, b) => compareText(a.prefecture, b.prefecture) || compareText(a.name, b.name) || compareText(a.id, b.id))
}

/** Restore PostgREST's nested projection, retaining inactive predecessors. */
export function snapshotToGeneratorRows(snapshot) {
  const t = snapshot.tables
  function index(table) {
    const result = new Map()
    for (const row of t[table]) {
      requireValue(typeof row.id === 'string' && !result.has(row.id), `${table} duplicate/missing id`)
      result.set(row.id, row)
    }
    return result
  }
  const schools = index('schools')
  const departments = index('school_departments')
  const units = index('admission_recruitment_units')
  const stats = index('school_admission_selection_stats')
  const groups = new Map()
  function group(table, foreignKey, parents) {
    const result = new Map()
    for (const row of t[table]) {
      requireValue(parents.has(row[foreignKey]), `${table} orphan ${foreignKey}`)
      const children = result.get(row[foreignKey]) ?? []
      children.push(row)
      result.set(row[foreignKey], children)
    }
    groups.set(table, { result, foreignKey })
  }
  for (const table of ['school_departments', 'school_deviation_values', 'school_admission_stats', 'school_field_sources', 'school_name_history', 'admission_recruitment_units']) group(table, 'school_id', schools)
  group('school_relationships', 'successor_school_id', schools)
  group('admission_recruitment_unit_departments', 'unit_id', units)
  group('school_admission_selection_stats', 'recruitment_unit_id', units)
  for (const table of ['school_admission_stat_exam_components', 'school_admission_stat_quality_flags', 'school_admission_stat_sources']) group(table, 'stat_id', stats)
  for (const row of t.admission_recruitment_unit_departments) {
    requireValue(departments.has(row.department_id) && departments.get(row.department_id).school_id === units.get(row.unit_id).school_id, 'membership school mismatch')
  }
  for (const table of ['school_deviation_values', 'school_admission_stats']) {
    for (const row of t[table]) requireValue(row.department_id === null || departments.has(row.department_id), `${table} department missing`)
  }
  const children = (table, id, keepParent = false) => {
    const { result, foreignKey } = groups.get(table)
    return (result.get(id) ?? []).map((row) => keepParent ? { ...row } : omit(row, [foreignKey]))
  }
  const getUnits = (id) => children('admission_recruitment_units', id, true).map((unit) => ({
    ...unit,
    admission_recruitment_unit_departments: children('admission_recruitment_unit_departments', unit.id),
    school_admission_selection_stats: children('school_admission_selection_stats', unit.id).map((stat) => ({
      ...stat,
      school_admission_stat_exam_components: children('school_admission_stat_exam_components', stat.id),
      school_admission_stat_quality_flags: children('school_admission_stat_quality_flags', stat.id),
      school_admission_stat_sources: children('school_admission_stat_sources', stat.id),
    })),
  }))
  // Validate even relationships belonging to schools that will not be emitted.
  for (const relation of t.school_relationships) requireValue(schools.has(relation.predecessor_school_id) && relation.predecessor_school_id !== relation.successor_school_id, 'invalid predecessor')
  for (const school of t.schools) requireValue(typeof school.is_active === 'boolean', 'is_active boolean')
  return canonicalizeGeneratorRows(t.schools.filter((school) => school.is_active).map((school) => ({
    ...school,
    school_departments: children('school_departments', school.id, true),
    school_deviation_values: children('school_deviation_values', school.id),
    school_admission_stats: children('school_admission_stats', school.id),
    school_field_sources: children('school_field_sources', school.id),
    school_name_history: children('school_name_history', school.id),
    admission_recruitment_units: getUnits(school.id),
    predecessor_relationships: children('school_relationships', school.id).map((relation) => ({
      ...omit(relation, ['predecessor_school_id']),
      predecessor: {
        ...pick(schools.get(relation.predecessor_school_id), columns('id, record_key, name, lifecycle_status_code, closed_on')),
        admission_recruitment_units: getUnits(relation.predecessor_school_id),
      },
    })),
  })))
}

export function parseSchoolSourceArgs(args) {
  const options = {}
  for (const arg of args) {
    const match = /^--(school-source|snapshot|snapshot-manifest)=(.+)$/.exec(arg)
    requireValue(match && !Object.hasOwn(options, match[1]), 'unknown, empty or duplicate argument')
    options[match[1]] = match[2]
  }
  const source = options['school-source']
  requireValue(['snapshot', 'sqlite-snapshot', 'supabase'].includes(source), 'explicit --school-source required')
  if (source !== 'supabase') requireValue(options.snapshot && options['snapshot-manifest'], 'snapshot pair required')
  else requireValue(!options.snapshot && !options['snapshot-manifest'], 'snapshot paths with supabase')
  return { source, snapshotPath: options.snapshot, manifestPath: options['snapshot-manifest'] }
}

export async function loadSchoolSource({ source, snapshotPath, manifestPath, fetchSupabase }) {
  if (source === 'snapshot') {
    requireValue(snapshotPath && manifestPath, 'snapshot pair required')
    const [snapshot, manifest] = await Promise.all([readFile(snapshotPath), readFile(manifestPath)])
    return snapshotToGeneratorRows(parseSchoolSnapshot(snapshot, manifest))
  }
  requireValue(source === 'supabase' && typeof fetchSupabase === 'function' && !snapshotPath && !manifestPath, 'explicit source required')
  return canonicalizeGeneratorRows(await fetchSupabase())
}

/** Same catalog compaction as the generator, without mutation of the input. */
export function buildSchoolPayload(inputRows) {
  const schools = structuredClone(inputRows)
  const sourceCatalog = []
  const sourceIndex = new Map()
  function compact(units) {
    for (const unit of units ?? []) for (const stat of unit.school_admission_selection_stats ?? []) {
      stat.school_admission_stat_sources = (stat.school_admission_stat_sources ?? []).map((source) => {
        if (typeof source === 'number') return source
        const key = JSON.stringify(source)
        let index = sourceIndex.get(key)
        if (index == null) {
          index = sourceCatalog.length
          sourceCatalog.push(source)
          sourceIndex.set(key, index)
        }
        return index
      })
    }
  }
  for (const row of schools) {
    compact(row.admission_recruitment_units)
    for (const relation of row.predecessor_relationships ?? []) compact(relation.predecessor?.admission_recruitment_units)
  }
  return { formatVersion: 2, sourceCatalog, schools }
}
