import { readFileSync } from 'node:fs'

const datasetClaims = JSON.parse(
  readFileSync(new URL('../../data/dataset-claims.json', import.meta.url), 'utf8'),
)

// gen-dataset-fields.mjs が DATA.md のフィールド定義を作るために import する。
// 値を複製させないため export する（複製すると公開 API と説明書がずれる）。
export const BASIC_FIELDS = [
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
  // 中高一貫かどうかは学校選びの一次情報。type（高校 / 高専）とは別軸で、
  // これが無いと併設型・中等教育学校を利用者側で見分けられない。
  'is_integrated',
  // サテライト校地・連携校がどの本校に属するかは campus_type だけでは分からない。
  'main_school_name',
  // 法的設立日。lifecycle.opened_on（開校日）とは別概念。
  'legally_established_on',
  // レコードの最終更新時刻。provenance.last_built_at はビルド時刻なので、
  // 学校ごとの鮮度はこちらでしか分からない。
  'updated_at',
]

export const SOURCED_SCHOOL_FIELDS = [
  ['total_students', 'schools.total_students'],
  ['enrollment_year', 'schools.enrollment_year'],
  ['male_ratio', 'schools.male_ratio'],
  ['status_description', 'schools.status_description'],
]

export const BASIC_FIELD_SOURCE_CODES = [
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
      recruitment_ended_year: row.recruitment_ended_year ?? null,
      // status_note は公開しない。収集作業の作業記録として書かれた自由記述で、
      // 工程の段階名（S1/S2/S3）や未確認の断り書きが同居しており、散文の中に
      // Wikipedia 参照が 14 件混ざっている（構造化された出典ゲートを素通りする）。
      // 公開用の説明は出典管理に乗せた status_description として別途用意する。
      // docs/local/plan_status-description-and-source-hygiene.md
      status_official_url: row.status_official_url,
    }
  }

  // 旧校名の履歴。改称前の名前で持っている外部データと突き合わせるために要る。
  const nameHistory = (row.school_name_history ?? [])
    .filter((entry) => entry?.name)
    .map((entry) => ({
      name: entry.name,
      name_kana: entry.name_kana ?? null,
      valid_from: entry.valid_from ?? null,
      valid_to: entry.valid_to ?? null,
      official_url: isHttpUrl(entry.official_url) ? entry.official_url : null,
      notes: entry.notes ?? null,
    }))
  if (nameHistory.length > 0) record.name_history = nameHistory

  // 前身校。アプリ側の行には前身校の入試実績まで入れ子で載っているが、
  // そのまま出すとレコードが重複して肥大するので識別子と関係だけに絞る。
  // 後継校側は record_key で逆引きできる。
  const predecessors = (row.predecessor_relationships ?? [])
    .filter((relation) => relation?.predecessor?.record_key)
    .map((relation) => ({
      relationship_type_code: relation.relationship_type_code ?? null,
      effective_on: relation.effective_on ?? null,
      official_url: isHttpUrl(relation.official_url) ? relation.official_url : null,
      notes: relation.notes ?? null,
      predecessor: {
        record_key: relation.predecessor.record_key,
        name: relation.predecessor.name ?? null,
        closed_on: relation.predecessor.closed_on ?? null,
        lifecycle_status_code: relation.predecessor.lifecycle_status_code ?? null,
      },
    }))
  if (predecessors.length > 0) record.predecessors = predecessors

  const admissionUnits = publicAdmissionUnits(row, sourceCatalog)
  if (admissionUnits.length > 0) record.admission_recruitment_units = admissionUnits
  return record
}

export function buildPublicSchoolRecords(rows, sourceCatalog, builtAt) {
  return rows.map((row) => toPublicSchoolRecord(row, sourceCatalog, builtAt)).filter(Boolean)
}

export const DATASET_ORIGIN = 'https://manabi-map.app'
export const DATASET_FIELDS_DOC_URL =
  'https://github.com/ishizakahiroshi/manabi-map/blob/main/DATA.md'

/**
 * 公開 API の「呼び方の契約」（OpenAPI 3.1）。
 *
 * dataset.json が「何が入っているか」を、これが「どう呼ぶか」を持つ。
 * 外部クライアント（AI エージェント含む）が 1 ファイルで呼び出し方を掴めるようにするためのもの。
 *
 * レコードの全フィールド定義はここに複製しない。正典は DATA.md（gen-dataset-fields.mjs が
 * このファイルの定数から生成する）で、複製すると必ず片方が古くなる。ここに書くのは
 * 「どの学校にも必ずある項目」だけとし、残りは additionalProperties で許して
 * externalDocs から DATA.md へ送る。宣言した必須項目が実データと食い違えば
 * verify-static-output.mjs が build を落とす。
 */
export function buildOpenApiDocument({ version, prefectureSlugs, origin = DATASET_ORIGIN }) {
  const collectionProperties = {
    api_version: { type: 'string', const: 'v1' },
    generated_at: { type: 'string', format: 'date-time', description: 'この JSON を生成した時刻。' },
    count: { type: 'integer', minimum: 0, description: 'schools の要素数。' },
    schools: { type: 'array', items: { $ref: '#/components/schemas/School' } },
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Manabi Map 学校基本情報 API',
      version,
      summary: '出典を追跡できる日本の高等学校・高等専門学校の基本情報。',
      description: [
        `収録方針: ${DATASET_CLAIM}`,
        '',
        '認証は不要で、CORS は全 origin に開いています。実体は固定 URL の静的 JSON なので、',
        '検索・絞り込みのパラメータはありません。全件または都道府県別に取得して、',
        '利用側で絞り込んでください。',
        '',
        `再配布・改変には出典表記が必要です（CC BY-SA 4.0）。表記例: ${DATASET_ATTRIBUTION}`,
        '',
        '偏差値の編集推計と、出典 URL を確認できない項目は、この API には含めません。',
        '学校を序列化する用途（順位づけ・合否可能性の判定）には使えません。',
      ].join('\n'),
      license: { name: 'CC BY-SA 4.0', url: DATASET_LICENSE_URL },
      contact: { name: 'Manabi Map', url: `${origin}/data/`, email: 'hello@manabi-map.app' },
    },
    externalDocs: {
      description: 'フィールド定義（全項目の型と収録条件）',
      url: DATASET_FIELDS_DOC_URL,
    },
    servers: [{ url: origin }],
    paths: {
      '/api/v1/dataset.json': {
        get: {
          operationId: 'getDataset',
          summary: 'データセットの収録範囲・ライセンス・配布先を取得する',
          description: '収録件数と都道府県別の内訳。最初にこれを読むと、どの県が使えるか分かります。',
          responses: {
            200: {
              description: 'データセットのメタデータ',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/DatasetMetadata' } },
              },
            },
          },
        },
      },
      '/api/v1/schools.json': {
        get: {
          operationId: 'listAllSchools',
          summary: '収録校を全件取得する',
          description: '全都道府県ぶんを 1 ファイルで返します。県が決まっているなら県別の方が軽量です。',
          responses: {
            200: {
              description: '収録校の全件',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/SchoolCollection' } },
              },
            },
          },
        },
      },
      '/api/v1/schools/{prefecture}.json': {
        get: {
          operationId: 'listSchoolsByPrefecture',
          summary: '都道府県を指定して収録校を取得する',
          parameters: [
            {
              name: 'prefecture',
              in: 'path',
              required: true,
              description: '都道府県のローマ字 slug（例: gunma）。収録済みの県のみ。',
              schema: { type: 'string', enum: prefectureSlugs },
            },
          ],
          responses: {
            200: {
              description: '指定した都道府県の収録校',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/PrefectureSchoolCollection' },
                },
              },
            },
            404: { description: '未収録の都道府県' },
          },
        },
      },
    },
    components: {
      schemas: {
        DatasetMetadata: {
          type: 'object',
          required: [
            'api_version',
            'generated_at',
            'school_count',
            'prefecture_count',
            'prefectures',
            'license',
          ],
          properties: {
            api_version: { type: 'string', const: 'v1' },
            generated_at: { type: 'string', format: 'date-time' },
            school_count: { type: 'integer', minimum: 0 },
            prefecture_count: { type: 'integer', minimum: 0 },
            prefectures: {
              type: 'object',
              description: '都道府県 slug をキー、収録校数を値とする対応表。',
              additionalProperties: { type: 'integer', minimum: 0 },
            },
            license: { type: 'string' },
            license_url: { type: 'string', format: 'uri' },
            attribution: { type: 'string', description: '再配布時に添える出典表記。' },
            provenance_policy: { type: 'string' },
            inclusion_policy: { type: 'string' },
            exclusion_policy: { type: 'string' },
          },
          additionalProperties: true,
        },
        SchoolCollection: {
          type: 'object',
          required: ['api_version', 'generated_at', 'count', 'schools'],
          properties: collectionProperties,
          additionalProperties: true,
        },
        PrefectureSchoolCollection: {
          type: 'object',
          required: ['api_version', 'generated_at', 'prefecture', 'count', 'schools'],
          properties: {
            ...collectionProperties,
            prefecture: { type: 'string', description: '都道府県名（例: 群馬県）。' },
          },
          additionalProperties: true,
        },
        School: {
          type: 'object',
          description:
            'どの学校にも必ずある項目だけを定義しています。学科・入試統計・前身校などは' +
            '出典が確認できた学校にだけ現れるため、全項目の型と収録条件は externalDocs を参照してください。',
          externalDocs: { description: '全フィールドの定義', url: DATASET_FIELDS_DOC_URL },
          required: ['id', 'record_key', 'name', 'prefecture', 'official_url', 'provenance'],
          properties: {
            id: { type: 'string', format: 'uuid', description: '内部 ID。外部参照には record_key を推奨。' },
            record_key: { type: 'string', description: 'school-<uuid> 形式の安定キー。' },
            name: { type: 'string', description: '学校名（正式名称）。' },
            prefecture: { type: 'string', description: '所在の都道府県名。' },
            official_url: {
              type: 'string',
              format: 'uri',
              description: '学校公式サイト。これを確認できない学校は収録しません。',
            },
            provenance: {
              type: 'object',
              description: '出典情報。項目単位の出典は field_sources に入ります。',
              required: ['official_url', 'last_built_at', 'field_sources'],
              properties: {
                official_url: { type: 'string', format: 'uri' },
                last_built_at: { type: 'string', format: 'date-time' },
                field_sources: { type: 'array', items: { type: 'object', additionalProperties: true } },
              },
              additionalProperties: true,
            },
          },
          additionalProperties: true,
        },
      },
    },
  }
}
