// 地図・一覧用の全国データ（`/schools-map-<hash>.json.gz`）を作る共有ロジック。
//
// React 側（hooks/useSchools.ts が読む形）と Node ビルドスクリプト
// （scripts/gen-schools-json.mjs が .ts のまま import する。tsx 起動・
// erasableSyntaxOnly）で共有される。フォーク禁止 —
// 「地図に載る値」と「詳細シートに出る値」が食い違う事故を防ぐ。
// 依存を持たない純関数だけを置くこと（値 import は同じ src/lib の .ts のみ）。
//
// 背景（docs/local/plan_data-usage-audit.md C2）:
// 全件 JSON（`/schools-<hash>.json.gz`）は入試履歴と出典で 3.79MB あり、
// `/map` へ入るたびに毎回落ちていた。ところが地図・お気に入り・比較・マイページ・
// 統合検索が実際に読むのはピンと一覧に出る列だけで、入試履歴の本体（出典・品質フラグ・
// 年度別の内訳）は詳細シートでしか使わない。詳細シートは学校単体 JSON
// （`/school-data/<id>.json`）で補えるので、全国データからは落とす。
//
// ただし地図の「倍率」チップと、ピンに出る最新年度の倍率は全校ぶん必要なので、
// **同じ primaryAdmissionTrend を使ってビルド時に畳んだ 1 組の値だけ**を載せる。

import { flattenRecruitmentUnits, type AdmissionRecruitmentUnitRow } from './admissionUnits.ts'
import { primaryAdmissionTrend } from './admission.ts'

/** 全件 JSON と同じ形（formatVersion / sourceCatalog / schools）で配るための版番号。 */
export const MAP_PAYLOAD_FORMAT_VERSION = 2

/** 地図 payload に載せた最新年度の一次募集倍率（ビルド時に畳んだ値）。 */
export interface LatestPrimaryAdmission {
  year: number
  ratio: number
}

/**
 * 全件 JSON の行からそのまま写す列。
 *
 * **ここに無い列は地図 payload に載らない。** 追加するときは
 * 「詳細シート以外の画面がその列を読むか」を先に確かめること
 * （詳細シートは単体 JSON で補うので、シートのためだけの列は載せない）。
 */
export const MAP_SCHOOL_COLUMNS = [
  'id',
  'record_key',
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
  'lifecycle_status_code',
  'recruitment_status_code',
  'legally_established_on',
  'opened_on',
  'recruitment_ended_on',
  'closed_on',
  'status_official_url',
  'course_times',
  'main_school_name',
  'campus_type',
  'total_students',
  'enrollment_year',
  'male_ratio',
] as const

/** 学科行のうち地図 payload に載せる列（id は マイページの学科別メモが key に使う）。 */
export const MAP_DEPARTMENT_COLUMNS = ['id', 'school_id', 'name', 'course_type', 'ui_group'] as const

/** 偏差値行のうち地図 payload に載せる列。 */
export const MAP_DEVIATION_COLUMNS = ['department_id', 'value', 'is_active'] as const

type Row = Record<string, unknown>

interface SourceRow extends Row {
  school_departments?: Row[] | null
  school_deviation_values?: Row[] | null
  admission_recruitment_units?: AdmissionRecruitmentUnitRow[] | null
}

function pick(row: Row, columns: readonly string[]): Row {
  const out: Row = {}
  for (const column of columns) {
    if (row[column] !== undefined) out[column] = row[column]
  }
  return out
}

/**
 * 全件 JSON の行から、最新年度の一次募集倍率だけを畳む。
 *
 * 判定は地図・詳細シートと同じ primaryAdmissionTrend（比較可能と裁定された
 * 一次募集の全体行のみ・全日制優先）。ここで別の規則を書かないこと。
 */
export function latestPrimaryAdmissionOf(row: SourceRow): LatestPrimaryAdmission | null {
  const latest = primaryAdmissionTrend({
    admission_selections: flattenRecruitmentUnits(row.admission_recruitment_units),
  })?.annual[0]
  return latest == null ? null : { year: latest.year, ratio: latest.ratio }
}

/** 全件 JSON の 1 行を、地図・一覧用の軽い行へ写す。 */
export function toMapSchoolRow(row: SourceRow): Row {
  const out = pick(row, MAP_SCHOOL_COLUMNS)
  out.school_departments = (row.school_departments ?? []).map((department) =>
    pick(department, MAP_DEPARTMENT_COLUMNS),
  )
  out.school_deviation_values = (row.school_deviation_values ?? []).map((deviation) =>
    pick(deviation, MAP_DEVIATION_COLUMNS),
  )
  const latest = latestPrimaryAdmissionOf(row)
  if (latest != null) out.latest_primary_admission = latest
  return out
}

/**
 * 地図・一覧用の全国 payload を作る。
 * 形は全件 JSON と同じ（fetch 側の分岐を増やさないため sourceCatalog は空配列で置く）。
 */
export function buildMapPayload(rows: readonly SourceRow[]): {
  formatVersion: number
  sourceCatalog: never[]
  schools: Row[]
} {
  return {
    formatVersion: MAP_PAYLOAD_FORMAT_VERSION,
    sourceCatalog: [],
    schools: rows.map(toMapSchoolRow),
  }
}
