import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  SNAPSHOT_COLUMNS, SOURCE_TABLES, REQUIRED_CODE_FILES, buildSchoolPayload, canonicalizeGeneratorRows,
  canonicalSchoolSourceJSON, loadSchoolSource, parseSchoolSnapshot,
  parseSchoolSourceArgs, snapshotToGeneratorRows,
} from './school-source.mjs'
import { buildPublicSchoolRecords } from './public-api.mjs'
import { buildMapPayload } from '../../src/lib/mapPayload.ts'
import { flattenRecruitmentUnits } from '../../src/lib/admissionUnits.ts'
import { mapSchoolRows, hydrateAdmissionSourceRefs } from '../../src/hooks/useSchools.ts'

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
function parseSchoolsPayload(payload) {
  hydrateAdmissionSourceRefs(payload.schools, payload.sourceCatalog)
  return payload.schools
}
function row(table, values) {
  return Object.assign(Object.fromEntries(SNAPSHOT_COLUMNS[table].map((key) => [key, null])), values)
}
function fixture() {
  const tables = Object.fromEntries(Object.keys(SNAPSHOT_COLUMNS).map((table) => [table, []]))
  tables.schools = [1, 2, 3, 4].map((n) => row('schools', {
    id: id(n), record_key: `school-${id(n)}`, name: n < 3 ? '合成同名校' : `合成校${n}`,
    name_kana: 'ゴウセイコウ', type: 'high_school', ownership: 'public', gender_type: 'coed',
    prefecture: '合成県', city: '合成市', address: '合成住所', latitude: n === 4 ? null : 35.1234567,
    longitude: 139.0000001, is_active: n !== 3, is_recruiting: n !== 3, is_integrated: false,
    official_url: n === 2 ? null : 'https://school.example.test/', course_times: ['parttime', 'fulltime'],
    lifecycle_status_code: n === 3 ? 'closed' : 'active', closed_on: n === 3 ? '2020-03-31' : null,
    recruitment_status_code: n === 3 ? 'ended' : 'recruiting', campus_type: 'main', total_students: 123,
  }))
  tables.school_departments = [row('school_departments', { id: id(10), school_id: id(1), name: '合成学科', course_type: 'general', ui_group: 'general' })]
  tables.school_deviation_values = [row('school_deviation_values', { school_id: id(1), department_id: id(10), value: 55, is_active: true })]
  tables.school_admission_stats = [row('school_admission_stats', { id: id(20), school_id: id(1), year: 2025, capacity: 999, applicants: 999, note: '合成旧統計注記' })]
  tables.school_field_sources = [row('school_field_sources', { school_id: id(1), field_name: 'schools.total_students', official_url: 'https://school.example.test/facts', is_official_source: true })]
  tables.school_name_history = [row('school_name_history', { id: id(30), school_id: id(1), name: '合成旧校名', valid_from: '2010-04-01', valid_to: null, notes: '合成沿革' })]
  tables.school_relationships = [1, 2].map((n) => row('school_relationships', { id: id(40 + n), predecessor_school_id: id(3), successor_school_id: id(n), relationship_type_code: 'merged', effective_on: '2020-04-01', official_url: 'https://school.example.test/history' }))
  tables.admission_recruitment_units = [1, 3].map((n) => row('admission_recruitment_units', { id: id(50 + n), school_id: id(n), unit_key: 'whole', unit_kind_code: 'school_total', label: '合成募集単位', course_time: 'fulltime' }))
  tables.admission_recruitment_unit_departments = [row('admission_recruitment_unit_departments', { unit_id: id(51), department_id: id(10) })]
  tables.school_admission_selection_stats = [1, 3].map((n) => row('school_admission_selection_stats', { id: id(60 + n), recruitment_unit_id: id(50 + n), year: 2025, selection_stage_code: 'primary', selection_track_code: 'general', scope_key: 'total', map_role_code: 'primary_total', is_ratio_comparable: true, capacity: 100, applicants: 120 }))
  tables.school_admission_stat_exam_components = [row('school_admission_stat_exam_components', { stat_id: id(61), component_code: 'academic_test' })]
  tables.school_admission_stat_quality_flags = [row('school_admission_stat_quality_flags', { stat_id: id(63), metric_code: null, reason_code: 'unknown', note: '合成確認待ち' })]
  tables.school_admission_stat_sources = [1, 3].flatMap((n) => ['capacity', 'applicants'].map((metric) => row('school_admission_stat_sources', { stat_id: id(60 + n), fact_kind_code: metric, official_url: 'https://school.example.test/admission', quoted_evidence: '合成引用', last_http_status: 200 })))
  return { format: 'school-source-snapshot', format_version: 1, schema_version: 3, synthetic: true, dataset_version: 'synthetic-v1', source_version: 'synthetic-source-v1', tables }
}
function pair(snapshot) {
  const bytes = Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`)
  const files = REQUIRED_CODE_FILES.map((path) => ({ path, sha256: hash('synthetic-code') }))
  const manifest = {
    format: 'school-source-manifest', format_version: 1, schema_version: 3, synthetic: true,
    dataset_version: snapshot.dataset_version, source_version: snapshot.source_version,
    created_at: '2026-09-27T00:00:00+00:00',
    table_counts: Object.fromEntries(SOURCE_TABLES.map((table) => [table, snapshot.tables[table]?.length ?? 0])),
    content_sha256: hash(canonicalSchoolSourceJSON(snapshot)), snapshot_sha256: hash(bytes),
    code: { identity: 'sha256', files, sha256: hash(canonicalSchoolSourceJSON(files)) },
  }
  return { bytes, manifest, manifestBytes: Buffer.from(JSON.stringify(manifest)) }
}
const without = (object, ...keys) => Object.fromEntries(Object.entries(object).filter(([key]) => !keys.includes(key)))

// Independent model of the two existing Supabase responses + their school_id join.
function nestedSupabaseFixture(t) {
  const units = t.admission_recruitment_units.map((unit) => ({ ...unit,
    admission_recruitment_unit_departments: t.admission_recruitment_unit_departments.filter((x) => x.unit_id === unit.id).map((x) => ({ department_id: x.department_id })),
    school_admission_selection_stats: t.school_admission_selection_stats.filter((x) => x.recruitment_unit_id === unit.id).map((stat) => ({ ...without(stat, 'recruitment_unit_id'),
      ...Object.fromEntries(['school_admission_stat_sources', 'school_admission_stat_quality_flags', 'school_admission_stat_exam_components'].map((table) => [table, t[table].filter((x) => x.stat_id === stat.id).map((x) => without(x, 'stat_id'))])),
    })),
  }))
  return t.schools.filter((school) => school.is_active).map((school) => ({ ...school,
    ...Object.fromEntries(['school_departments', 'school_deviation_values', 'school_admission_stats', 'school_field_sources', 'school_name_history'].map((table) => [table, t[table].filter((x) => x.school_id === school.id).map((x) => table === 'school_departments' ? x : without(x, 'school_id'))])),
    admission_recruitment_units: units.filter((x) => x.school_id === school.id),
    predecessor_relationships: t.school_relationships.filter((x) => x.successor_school_id === school.id).map((relation) => {
      const predecessor = t.schools.find((x) => x.id === relation.predecessor_school_id)
      return { ...without(relation, 'successor_school_id', 'predecessor_school_id'), predecessor: {
        id: predecessor.id, record_key: predecessor.record_key, name: predecessor.name,
        lifecycle_status_code: predecessor.lifecycle_status_code, closed_on: predecessor.closed_on,
        admission_recruitment_units: units.filter((x) => x.school_id === predecessor.id),
      } }
    }),
  }))
}

test('snapshot and Supabase-shaped synthetic input agree through rows, app, map and public API', async () => {
  const snapshot = fixture()
  const { bytes, manifestBytes } = pair(snapshot)
  const local = snapshotToGeneratorRows(parseSchoolSnapshot(bytes, manifestBytes))
  const remote = await loadSchoolSource({ source: 'supabase', fetchSupabase: async () => nestedSupabaseFixture(snapshot.tables).reverse() })
  assert.deepEqual(local, remote)
  assert.deepEqual(local.map((x) => x.id), [id(1), id(2), id(4)])
  assert.deepEqual(local[0].course_times, ['parttime', 'fulltime'])
  assert.deepEqual(local[0].school_name_history[0].valid_to, null)
  assert.equal(local[0].predecessor_relationships[0].predecessor.id, id(3))
  assert.equal(Object.keys(local[0].predecessor_relationships[0].predecessor).length, 6)
  assert.equal(local[0].school_admission_stats[0].capacity, 999)
  const payload = buildSchoolPayload(local)
  const other = buildSchoolPayload(remote)
  assert.deepEqual(payload, other)
  assert.equal(payload.sourceCatalog.length, 2)
  assert.deepEqual(mapSchoolRows(parseSchoolsPayload(structuredClone(payload))), mapSchoolRows(parseSchoolsPayload(structuredClone(other))))
  assert.equal(mapSchoolRows(parseSchoolsPayload(structuredClone(payload))).length, 2)
  assert.deepEqual(buildMapPayload(payload.schools), buildMapPayload(other.schools))
  assert.deepEqual(flattenRecruitmentUnits(local[0].admission_recruitment_units), flattenRecruitmentUnits(remote[0].admission_recruitment_units))
  const api = buildPublicSchoolRecords(payload.schools, payload.sourceCatalog, 'fixed')
  assert.deepEqual(api, buildPublicSchoolRecords(other.schools, other.sourceCatalog, 'fixed'))
  assert.deepEqual(api.map((x) => x.id), [id(1), id(4)])
  assert.equal(api[0].total_students, 123)
  assert.equal(api[1].total_students, undefined)
  assert.equal(JSON.stringify(api).includes('quoted_evidence'), false)
  assert.equal(JSON.stringify(api).includes('合成旧統計注記'), false)
  assert.equal(JSON.stringify(api).includes('school_deviation_values'), false)
  assert.equal(local[0].admission_recruitment_units[0].school_admission_selection_stats[0].school_admission_stat_sources[0].quoted_evidence, '合成引用')
})

test('explicit source parsing rejects ambiguity, missing pair, duplicates and unknown arguments', () => {
  for (const args of [[], ['--school-source=other'], ['--school-source=snapshot'], ['--school-source=supabase', '--snapshot=a'], ['--school-source=supabase', '--school-source=supabase'], ['--school-source=supabase', '--unknown=x']]) assert.throws(() => parseSchoolSourceArgs(args))
  assert.equal(parseSchoolSourceArgs(['--school-source=supabase']).source, 'supabase')
  assert.equal(parseSchoolSourceArgs(['--school-source=snapshot', '--snapshot=a', '--snapshot-manifest=b']).snapshotPath, 'a')
})

test('local input and failed local input never invoke a network/env loader', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'school-source-synthetic-'))
  try {
    const { bytes, manifestBytes } = pair(fixture())
    const snapshotPath = join(directory, 'snapshot.json')
    const manifestPath = join(directory, 'manifest.json')
    await writeFile(snapshotPath, bytes)
    await writeFile(manifestPath, manifestBytes)
    const fetchSupabase = () => { throw new Error('network/env loader was invoked') }
    assert.equal((await loadSchoolSource({ source: 'snapshot', snapshotPath, manifestPath, fetchSupabase })).length, 3)
    await writeFile(snapshotPath, '{}')
    await assert.rejects(loadSchoolSource({ source: 'snapshot', snapshotPath, manifestPath, fetchSupabase }), /Invalid school source/)
    await assert.rejects(loadSchoolSource({ source: 'snapshot', snapshotPath: join(directory, 'missing'), manifestPath, fetchSupabase }), /ENOENT/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('manifest rejects corrupted bytes, versions, hashes, counts and private code paths', () => {
  const { bytes, manifest } = pair(fixture())
  assert.throws(() => parseSchoolSnapshot(Buffer.concat([bytes, Buffer.from(' ')]), Buffer.from(JSON.stringify(manifest))), /snapshot hash/)
  for (const update of [{ schema_version: 2 }, { synthetic: false }, { source_version: 'different' }, { content_sha256: '0'.repeat(64) }, { table_counts: { schools: 4 } }, { code: { identity: 'sha256', files: [{ path: 'C:/private.py', sha256: hash('x') }] } }]) {
    assert.throws(() => parseSchoolSnapshot(bytes, Buffer.from(JSON.stringify({ ...manifest, ...update }))))
  }
})

test('snapshot rejects additional private columns, missing columns and unrecognized tables', () => {
  for (const change of [(s) => { s.tables.schools[0].status_note = 'private' }, (s) => { delete s.tables.schools[0].name }, (s) => { s.tables.auth_users = [] }]) {
    const snapshot = fixture()
    change(snapshot)
    const { bytes, manifestBytes } = pair(snapshot)
    assert.throws(() => parseSchoolSnapshot(bytes, manifestBytes), /columns differ/)
  }
})

test('strict pair parsing rejects duplicate JSON keys, envelope extensions and scalar coercion', () => {
  const good = pair(fixture())
  const duplicate = good.bytes.toString().replace('"schema_version": 3', '"schema_version": 2, "schema_version": 3')
  assert.throws(() => parseSchoolSnapshot(Buffer.from(duplicate), good.manifestBytes), /duplicate JSON key/)
  for (const change of [
    (s) => { s.private_path = '/private/source' },
    (s) => { s.tables.schools[0].latitude = true },
    (s) => { s.tables.schools[0].is_active = 1 },
    (s) => { s.tables.schools[0].total_students = '123' },
    (s) => { s.tables.schools[0].course_times = ['other'] },
  ]) {
    const snapshot = fixture()
    change(snapshot)
    const { bytes, manifestBytes } = pair(snapshot)
    assert.throws(() => parseSchoolSnapshot(bytes, manifestBytes), /Invalid school source/)
  }
})

test('numeric(10,7) coordinate boundaries match the source storage contract', () => {
  for (const value of [999.9999999, -999, 0.0000001]) {
    const snapshot = fixture()
    snapshot.tables.schools[0].latitude = value
    snapshot.tables.schools[0].longitude = value
    const { bytes, manifestBytes } = pair(snapshot)
    const parsed = parseSchoolSnapshot(bytes, manifestBytes)
    assert.equal(parsed.tables.schools[0].latitude, value)
    assert.equal(parsed.tables.schools[0].longitude, value)
  }
  for (const value of [1000, -1000]) {
    const snapshot = fixture()
    snapshot.tables.schools[0].latitude = value
    const { bytes, manifestBytes } = pair(snapshot)
    assert.throws(() => parseSchoolSnapshot(bytes, manifestBytes), /numeric coordinate/)
  }
})

test('code identity requires every exporter and transformer exactly once', () => {
  for (const mutate of [
    (files) => files.slice(1),
    (files) => [...files, { path: 'unknown.py', sha256: hash('synthetic-code') }],
    (files) => [...files.slice(1), files[1]],
  ]) {
    const { bytes, manifest } = pair(fixture())
    manifest.code.files = mutate(manifest.code.files)
    manifest.code.sha256 = hash(canonicalSchoolSourceJSON(manifest.code.files))
    assert.throws(() => parseSchoolSnapshot(bytes, Buffer.from(JSON.stringify(manifest))), /code file/)
  }
})

test('orphan relationships, child FK, cross-school membership and duplicate ids fail closed', () => {
  for (const change of [(t) => { t.school_relationships[0].predecessor_school_id = id(999) }, (t) => { t.school_admission_stat_sources[0].stat_id = id(999) }, (t) => { t.admission_recruitment_unit_departments[0].unit_id = id(53) }, (t) => { t.schools.push(t.schools[0]) }, (t) => { t.schools[0].is_active = 1 }]) {
    const snapshot = fixture()
    change(snapshot.tables)
    assert.throws(() => snapshotToGeneratorRows(snapshot), /Invalid school source/)
  }
})

test('normalization and content hash are stable without changing course-time order or input objects', () => {
  const snapshot = fixture()
  const original = structuredClone(snapshot)
  const expected = snapshotToGeneratorRows(snapshot)
  for (const rows of Object.values(snapshot.tables)) rows.reverse()
  assert.deepEqual(snapshotToGeneratorRows(snapshot), expected)
  buildSchoolPayload(expected)
  assert.deepEqual(canonicalizeGeneratorRows(nestedSupabaseFixture(original.tables)), expected)
  assert.equal(canonicalSchoolSourceJSON({ z: -0, a: 0.0000001, b: 35.1234567 }), '{"a":0.0000001,"b":35.1234567,"z":0}')
  assert.throws(() => canonicalSchoolSourceJSON(0.12345678), /precision/)
  assert.throws(() => canonicalSchoolSourceJSON(Infinity), /precision/)
})

test('shared map calculation ignores legacy aggregate and public API keeps source and quality gates', () => {
  const snapshot = fixture()
  let rows = snapshotToGeneratorRows(snapshot)
  assert.deepEqual(buildMapPayload(rows).schools[0].latest_primary_admission, { year: 2025, ratio: 1.2 })
  snapshot.tables.school_field_sources.push(row('school_field_sources', {
    school_id: id(1), field_name: 'schools.latitude', official_url: 'https://unofficial.example.test/', is_official_source: false,
  }))
  snapshot.tables.school_admission_stat_quality_flags.push(row('school_admission_stat_quality_flags', {
    stat_id: id(61), metric_code: null, reason_code: 'unknown', note: '合成確認待ち',
  }))
  rows = snapshotToGeneratorRows(snapshot)
  const payload = buildSchoolPayload(rows)
  const api = buildPublicSchoolRecords(payload.schools, payload.sourceCatalog, 'fixed')[0]
  assert.equal(api.latitude, undefined)
  assert.equal(api.admission_recruitment_units, undefined)
  assert.equal(rows[0].latitude, 35.1234567)
  assert.equal(rows[0].admission_recruitment_units.length, 1)
})

test('generator chooses source before loading env and reuses the tested pure payload function', async () => {
  const source = await readFile(new URL('../gen-schools-json.mjs', import.meta.url), 'utf8')
  assert.ok(source.indexOf('parseSchoolSourceArgs(process.argv.slice(2))') < source.indexOf('async function fetchSupabaseRows()'))
  assert.ok(source.indexOf('async function fetchSupabaseRows()') < source.indexOf("await readEnvFile(join(envDir, '.env'))"))
  assert.match(source, /const payload = buildSchoolPayload\(inputRows\)/)
})
