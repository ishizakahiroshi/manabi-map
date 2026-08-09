/**
 * Supabase schools の公開クエリ列。
 *
 * `status_note` は収集作業用の内部メモなので、アプリの直接取得と
 * ビルド時の静的 JSON 生成のどちらにも含めない。列を `*` へ戻すと
 * DB 列追加だけで公開物へ流れ込むため、ここを列 allowlist の正典にする。
 */
const APP_SCHOOL_COLUMNS = [
  'id',
  'name',
  'name_kana',
  'type',
  'ownership',
  'gender_type',
  'is_integrated',
  'postal_code',
  'prefecture',
  'city',
  'address',
  'latitude',
  'longitude',
  'official_url',
  'is_active',
  'is_recruiting',
  'updated_at',
  'course_times',
  'main_school_name',
  'campus_type',
  'total_students',
  'enrollment_year',
  'male_ratio',
  'record_key',
  'lifecycle_status_code',
  'recruitment_status_code',
  'legally_established_on',
  'opened_on',
  'recruitment_ended_on',
  'closed_on',
  'status_official_url',
].join(', ')

const GENERATOR_SCHOOL_COLUMNS = [
  ...APP_SCHOOL_COLUMNS.split(', '),
  'recruitment_ended_year',
  'status_description',
].join(', ')

const RELATION_SELECT =
  'school_departments(id, school_id, name, course_type, ui_group), ' +
  'school_deviation_values(department_id, value, is_active), ' +
  'school_admission_stats(id, department_id, year, capacity, applicants, examinees, admitted, note, source_url), ' +
  'predecessor_relationships:school_relationships!school_relationships_successor_school_id_fkey(' +
  'id, relationship_type_code, effective_on, official_url, notes, ' +
  'predecessor:schools!school_relationships_predecessor_school_id_fkey(' +
  'id, record_key, name, lifecycle_status_code, closed_on)), ' +
  'school_name_history(id, name, name_kana, valid_from, valid_to, official_url, notes)'

export const APP_SCHOOL_SELECT = `${APP_SCHOOL_COLUMNS}, ${RELATION_SELECT}`

export const GENERATOR_SCHOOL_SELECT =
  `${GENERATOR_SCHOOL_COLUMNS}, ` +
  'school_field_sources(field_name, official_url, doc_title, published_at, source_page_or_table, ' +
  `last_verified_at, last_http_status, is_official_source), ${RELATION_SELECT}`
