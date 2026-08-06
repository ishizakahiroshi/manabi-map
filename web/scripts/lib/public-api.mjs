import { readFileSync } from 'node:fs'

const datasetClaims = JSON.parse(
  readFileSync(new URL('../../data/dataset-claims.json', import.meta.url), 'utf8'),
)

const BASIC_FIELDS = [
  'id',
  'record_key',
  'name',
  'name_kana',
  'type',
  'ownership',
  'gender_type',
  'prefecture',
  'city',
  'address',
  'postal_code',
  'latitude',
  'longitude',
  'official_url',
  'course_times',
  'campus_type',
]

const SOURCED_SCHOOL_FIELDS = [
  ['total_students', 'schools.total_students'],
  ['enrollment_year', 'schools.enrollment_year'],
  ['male_ratio', 'schools.male_ratio'],
]

const BASIC_FIELD_SOURCE_CODES = [
  ['latitude', 'schools.latitude'],
  ['longitude', 'schools.longitude'],
  ['course_times', 'schools.course_times'],
  ['campus_type', 'schools.campus_type'],
]

const ADMISSION_METRICS = ['capacity', 'applicants', 'examinees', 'admitted']

export const DATASET_CLAIM = datasetClaims.claim
export const DATASET_LICENSE_URL = datasetClaims.licenseUrl
export const DATASET_ATTRIBUTION = datasetClaims.attribution

/** 公開県数が正典の全県数と一致するときだけ「全国」を名乗る。 */
export function formatDatasetCoverage(prefectureCount, schoolCount, nationwidePrefectureCount) {
  const prefix = prefectureCount === nationwidePrefectureCount ? '全国 ' : ''
  return (
    `${prefix}${Number(prefectureCount).toLocaleString('en-US')} 都道府県・` +
    `${Number(schoolCount).toLocaleString('en-US')} 校`
  )
}

function isHttpUrl(value) {
  if (typeof value !== 'string') return false
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'https:' || parsed.protocol === 'http:'
  } catch {
    return false
  }
}

function copyFields(object, fields) {
  return Object.fromEntries(fields.map((field) => [field, object?.[field] ?? null]))
}

function normalizeFieldSource(source) {
  if (!source || source.is_official_source !== true || !isHttpUrl(source.official_url)) return null
  return {
    field_name: source.field_name,
    official_url: source.official_url,
    doc_title: source.doc_title ?? null,
    published_at: source.published_at ?? null,
    source_page_or_table: source.source_page_or_table ?? null,
    last_verified_at: source.last_verified_at ?? null,
    last_http_status: source.last_http_status ?? null,
  }
}

function normalizeAdmissionSource(source) {
  if (!source || !isHttpUrl(source.official_url)) return null
  return {
    fact_kind_code: source.fact_kind_code,
    official_url: source.official_url,
    doc_title: source.doc_title ?? null,
    published_at: source.published_at ?? null,
    source_page_or_table: source.source_page_or_table ?? null,
    last_verified_at: source.last_verified_at ?? null,
  }
}

function resolveAdmissionSources(stat, sourceCatalog) {
  return (stat?.school_admission_stat_sources ?? [])
    .map((ref) => typeof ref === 'number' ? sourceCatalog?.[ref] : ref)
    .map(normalizeAdmissionSource)
    .filter(Boolean)
}

function publicAdmissionStat(stat, sourceCatalog) {
  if ((stat?.school_admission_stat_quality_flags ?? []).length > 0) return null
  const sources = resolveAdmissionSources(stat, sourceCatalog)
  if (sources.length === 0) return null

  const sourceKinds = new Set(sources.map((source) => source.fact_kind_code))
  const metrics = Object.fromEntries(
    ADMISSION_METRICS
      .filter((metric) => stat?.[metric] != null && sourceKinds.has(metric))
      .map((metric) => [metric, stat[metric]]),
  )
  if (Object.keys(metrics).length === 0) return null

  return {
    year: stat.year,
    selection_stage_code: stat.selection_stage_code ?? null,
    selection_track_code: stat.selection_track_code ?? null,
    stage_label_raw: stat.stage_label_raw ?? null,
    track_label_raw: stat.track_label_raw ?? null,
    selection_scope_raw: stat.selection_scope_raw ?? null,
    population_scope_raw: stat.population_scope_raw ?? null,
    scope_key: stat.scope_key ?? null,
    map_role_code: stat.map_role_code ?? null,
    is_ratio_comparable: stat.is_ratio_comparable ?? null,
    ...metrics,
    sources,
  }
}

function publicAdmissionUnits(row, sourceCatalog) {
  return (row?.admission_recruitment_units ?? [])
    .map((unit) => {
      const statistics = (unit.school_admission_selection_stats ?? [])
        .map((stat) => publicAdmissionStat(stat, sourceCatalog))
        .filter(Boolean)
      if (statistics.length === 0) return null
      return {
        unit_key: unit.unit_key,
        unit_kind_code: unit.unit_kind_code,
        label: unit.label,
        course_time: unit.course_time ?? null,
        valid_from_year: unit.valid_from_year ?? null,
        valid_to_year: unit.valid_to_year ?? null,
        statistics,
      }
    })
    .filter(Boolean)
}

/** 公開 API に学校レコードを載せられるかを判定する唯一のゲート。 */
export function isPublicSchoolRecord(row) {
  return row?.is_active === true && isHttpUrl(row.official_url)
}

/**
 * アプリ用 JSON から、公開を明示的に許可した項目だけを別 payload へ写す。
 * 未知の列はコピーされないため、DB 列追加時にも意図せず公開されない。
 */
export function toPublicSchoolRecord(row, sourceCatalog, builtAt) {
  if (!isPublicSchoolRecord(row)) return null

  const fieldSources = (row.school_field_sources ?? []).map(normalizeFieldSource).filter(Boolean)
  const sourcedFields = new Set(fieldSources.map((source) => source.field_name))
  const nonOfficialFields = new Set(
    (row.school_field_sources ?? [])
      .filter((source) => source?.is_official_source === false)
      .map((source) => source.field_name),
  )
  const record = {
    ...copyFields(row, BASIC_FIELDS),
    provenance: {
      official_url: row.official_url,
      last_built_at: builtAt,
      field_sources: fieldSources,
    },
  }

  // 一次資料でないことが既知の項目は、「基本項目」側からも漏らさない。
  // 後から一次資料が併記された場合は true 側を優先して公開へ昇格する。
  for (const [column, sourceCode] of BASIC_FIELD_SOURCE_CODES) {
    if (nonOfficialFields.has(sourceCode) && !sourcedFields.has(sourceCode)) delete record[column]
  }

  for (const [column, sourceCode] of SOURCED_SCHOOL_FIELDS) {
    if (row[column] != null && sourcedFields.has(sourceCode)) record[column] = row[column]
  }

  if (sourcedFields.has('school_departments.name')) {
    record.departments = (row.school_departments ?? []).map((department) => ({
      name: department.name,
      ...(sourcedFields.has('school_departments.course_type')
        ? { course_type: department.course_type ?? null }
        : {}),
    }))
  }

  if (isHttpUrl(row.status_official_url)) {
    record.lifecycle = {
      lifecycle_status_code: row.lifecycle_status_code ?? null,
      recruitment_status_code: row.recruitment_status_code ?? null,
      opened_on: row.opened_on ?? null,
      closed_on: row.closed_on ?? null,
      recruitment_ended_on: row.recruitment_ended_on ?? null,
      status_official_url: row.status_official_url,
    }
  }

  const admissionUnits = publicAdmissionUnits(row, sourceCatalog)
  if (admissionUnits.length > 0) record.admission_recruitment_units = admissionUnits
  return record
}

export function buildPublicSchoolRecords(rows, sourceCatalog, builtAt) {
  return rows.map((row) => toPublicSchoolRecord(row, sourceCatalog, builtAt)).filter(Boolean)
}
