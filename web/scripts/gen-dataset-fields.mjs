// 公開 API（/api/v1/）のフィールド定義を Markdown で生成する。
//
//   node scripts/gen-dataset-fields.mjs            # 標準出力へ
//   node scripts/gen-dataset-fields.mjs --write    # DATA.md のマーカー間を置換
//
// 生成元（すべて repo 内。DB 接続は不要）:
//   - どのフィールドが出るか  … scripts/lib/public-api.mjs の定数を import
//   - 列挙値                  … src/types/school.ts の union 型をテキスト抽出
//   - 各項目・各値の説明      … 本ファイル下部の FIELD_DOCS / VALUE_DOCS
//
// 説明の抜けは黙って通さない。フィールドや列挙値を増やしたのに説明を書いていなければ
// throw して生成を落とす（空欄のまま公開 API の説明書が出る事故を防ぐ）。
//
// docs/local/plan_dataset-field-reference.md C1

import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BASIC_FIELDS,
  SOURCED_SCHOOL_FIELDS,
  BASIC_FIELD_SOURCE_CODES,
} from './lib/public-api.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const webRoot = join(here, '..')
const repoRoot = join(webRoot, '..')
const TYPES_PATH = join(webRoot, 'src', 'types', 'school.ts')
const DATA_MD_PATH = join(repoRoot, 'DATA.md')

const BEGIN_MARKER = '<!-- BEGIN GENERATED: dataset-fields -->'
const END_MARKER = '<!-- END GENERATED: dataset-fields -->'

// --- 列挙値の抽出 -----------------------------------------------------------

/**
 * `export type Foo = 'a' | 'b'` 形式の union をテキストから抜く。
 * 型はランタイムに残らないので import できない。書式が変わったら
 * マッチ 0 件で throw し、空の表を黙って出さない。
 */
function extractUnion(source, typeName) {
  const pattern = new RegExp(`export type ${typeName}\\s*=\\s*([^;]+?)(?=\\nexport |\\n/\\*\\*|$)`, 's')
  const matched = source.match(pattern)
  if (!matched) {
    throw new Error(
      `gen-dataset-fields: ${typeName} の union を src/types/school.ts から抽出できない。` +
      '型定義の書式が変わった可能性がある',
    )
  }
  const values = [...matched[1].matchAll(/'([^']+)'/g)].map((m) => m[1])
  if (values.length === 0) {
    throw new Error(`gen-dataset-fields: ${typeName} から値を 1 つも抽出できない`)
  }
  return values
}

// --- 説明の辞書（ここが唯一の手書き箇所）------------------------------------

/** フィールドの説明。BASIC_FIELDS 等に足したらここも埋めないと生成が落ちる。 */
const FIELD_DOCS = {
  id: ['string (uuid)', '必須', '学校の内部 ID。安定しているが、外部参照には `record_key` を推奨'],
  record_key: ['string', '必須', '`school-<uuid>` 形式の安定キー。再生成しても変わらない。外部システムとの突き合わせに使う'],
  name: ['string', '必須', '学校名（正式名称）'],
  name_kana: ['string | null', '任意', '学校名のふりがな。未収集の学校は null'],
  type: ['string (enum)', '必須', '学校種。値は下記「学校種（type）」'],
  ownership: ['string (enum)', '必須', '設置者。値は下記「設置者（ownership）」'],
  gender_type: ['string (enum)', '必須', '共学・別学の区分。値は下記「共学別学（gender_type）」'],
  prefecture: ['string', '必須', '所在の都道府県名（例: 群馬県）'],
  city: ['string | null', '任意', '所在の市区町村名。総務省 全国地方公共団体コードで正規化'],
  address: ['string | null', '任意', '所在地（都道府県から始まる表記）'],
  postal_code: ['string | null', '任意', '郵便番号（ハイフンあり）'],
  latitude: ['number | null', '任意', '緯度（10 進度）。出典が確認できた学校のみ'],
  longitude: ['number | null', '任意', '経度（10 進度）。出典が確認できた学校のみ'],
  official_url: ['string', '必須', '学校公式サイトの URL。**これが確認できない学校は公開 API に収録しない**'],
  course_times: ['string[] | null', '任意', '課程。値は下記「課程（course_times）」。複数持つ学校がある'],
  campus_type: ['string (enum) | null', '任意', '校地の種別。値は下記「校地種別（campus_type）」'],
  is_integrated: ['boolean', '必須', '中高一貫かどうか。`type`（高校 / 高専）とは別軸の属性。**true でも高校段階の外部募集を行う学校（併設型）はある**ので、募集の有無は `lifecycle.recruitment_status_code` で確認する'],
  main_school_name: ['string | null', '任意', '本校の名称。`campus_type` が `main` 以外（サテライト校地・連携校・サポート校）のとき、どの本校に属するかを示す'],
  legally_established_on: ['string (date) | null', '任意', '法的な設置日。`lifecycle.opened_on`（開校日）とは別概念で、学校再編では設置日が先行することがある'],
  updated_at: ['string (ISO 8601) | null', '任意', 'このレコードの最終更新時刻。`provenance.last_built_at` はビルド全体の時刻なので、学校ごとの鮮度はこちらで見る'],
  total_students: ['number | null', '出典があるときのみ', '全校生徒数。出典が登録された学校だけに出る'],
  enrollment_year: ['number | null', '出典があるときのみ', '`total_students` / `male_ratio` の基準年度'],
  male_ratio: ['number | null', '出典があるときのみ', '男子比率（0〜1）。出典が登録された学校だけに出る'],
  status_description: ['string | null', '出典があるときのみ', '一次資料で確認した学校状態の公開用説明。収集作業の内部記録である `status_note` とは別で、出典が登録された学校だけに出る'],
}

/**
 * レコード直下のオブジェクト・配列項目。
 * `toPublicSchoolRecord` が条件付きで足すキーを含む。
 * ここに書き漏らすと説明の無いキーが公開されるため、
 * verify-static-output.test.mjs が実際の出力キーと突き合わせて検出する。
 */
const OBJECT_DOCS = [
  ['provenance', 'object', '必須', '出典情報。読み方は下記「provenance の読み方」'],
  ['lifecycle', 'object', '`status_official_url` があるときのみ', '学校の状態。読み方は下記「lifecycle の読み方」'],
  ['departments', 'object[]', '学科名の出典があるときのみ', '学科の一覧。読み方は下記「departments の読み方」'],
  ['admission_recruitment_units', 'object[]', '出典つきの入試統計があるときのみ', '募集単位ごとの入試統計。読み方は下記「admission_recruitment_units の読み方」'],
  ['name_history', 'object[]', '旧校名があるときのみ', '改称の履歴。読み方は下記「name_history の読み方」'],
  ['predecessors', 'object[]', '前身校があるときのみ', '統合・改組の前身校。読み方は下記「predecessors の読み方」'],
]

/** 列挙値の説明。型に値を足したらここも埋めないと生成が落ちる。 */
const VALUE_DOCS = {
  SchoolType: {
    high_school: '高等学校',
    kosen: '高等専門学校（5 年制）',
  },
  Ownership: {
    prefectural: '都道府県立',
    municipal: '市区町村立',
    national: '国立',
    private: '私立',
    union: '組合立（複数自治体による一部事務組合が設置）',
  },
  GenderType: {
    coed: '共学',
    boys: '男子校',
    girls: '女子校',
  },
  CourseTime: {
    fulltime: '全日制',
    parttime: '定時制',
    correspondence: '通信制',
  },
  CampusType: {
    main: '本校',
    partner_school: '連携校（通信制の学習等支援を行う提携先）',
    satellite_campus: 'サテライト校地（本校とは別の校地）',
    support_school: 'サポート校',
  },
  SchoolLifecycleStatus: {
    planned: '開校予定（設置認可済みで開校前）',
    active: '在校（通常運営）',
    closing: '在校生のみ（募集を終えたが在校生がいる）',
    closed: '閉校',
  },
  SchoolRecruitmentStatus: {
    unknown: '未確認（一次資料で確認できていない）',
    not_started: '募集開始前',
    recruiting: '募集中',
    no_external_high_school_intake: '高校段階の外部募集なし（中高一貫の内部進学のみ等）',
    stopped: '募集終了',
  },
}

/** 列挙型 → 出力時の見出しと、対応するフィールド名。 */
const ENUM_SECTIONS = [
  ['SchoolType', '学校種（type）'],
  ['Ownership', '設置者（ownership）'],
  ['GenderType', '共学別学（gender_type）'],
  ['CourseTime', '課程（course_times）'],
  ['CampusType', '校地種別（campus_type）'],
  ['SchoolLifecycleStatus', '学校状態（lifecycle.lifecycle_status_code）'],
  ['SchoolRecruitmentStatus', '募集状態（lifecycle.recruitment_status_code）'],
]

// --- 生成 -------------------------------------------------------------------

function assertNoMissingFieldDocs(fieldNames) {
  const missing = fieldNames.filter((name) => !FIELD_DOCS[name])
  if (missing.length > 0) {
    throw new Error(
      `gen-dataset-fields: 説明の無いフィールドがある: ${missing.join(', ')}。` +
      'FIELD_DOCS に追記してから再実行する',
    )
  }
}

function assertNoMissingValueDocs(typeName, values) {
  const docs = VALUE_DOCS[typeName] ?? {}
  const missing = values.filter((value) => !docs[value])
  if (missing.length > 0) {
    throw new Error(
      `gen-dataset-fields: ${typeName} に説明の無い値がある: ${missing.join(', ')}。` +
      'VALUE_DOCS に追記してから再実行する',
    )
  }
  const stale = Object.keys(docs).filter((value) => !values.includes(value))
  if (stale.length > 0) {
    throw new Error(
      `gen-dataset-fields: ${typeName} に型へ存在しない説明が残っている: ${stale.join(', ')}。` +
      'VALUE_DOCS から削除する',
    )
  }
}

/** 型表記の `|`（union）は Markdown 表の区切りと衝突するのでエスケープする。 */
function escapeCell(value) {
  return String(value).replaceAll('|', '\\|')
}

function renderFieldTable(fieldNames) {
  const rows = fieldNames.map((name) => {
    const [type, nullable, description] = FIELD_DOCS[name]
    return `| \`${name}\` | ${escapeCell(type)} | ${nullable} | ${description} |`
  })
  const objectRows = OBJECT_DOCS.map(
    ([name, type, nullable, description]) =>
      `| \`${name}\` | ${escapeCell(type)} | ${nullable} | ${description} |`,
  )
  return [
    '| フィールド | 型 | 収録条件 | 説明 |',
    '|---|---|---|---|',
    ...rows,
    ...objectRows,
  ].join('\n')
}

function renderEnumSections(typeSource) {
  const blocks = []
  for (const [typeName, heading] of ENUM_SECTIONS) {
    const values = extractUnion(typeSource, typeName)
    assertNoMissingValueDocs(typeName, values)
    const rows = values.map((value) => `| \`${value}\` | ${VALUE_DOCS[typeName][value]} |`)
    blocks.push([`#### ${heading}`, '', '| 値 | 意味 |', '|---|---|', ...rows].join('\n'))
  }
  return blocks.join('\n\n')
}

function renderProvenanceSection() {
  const sourcedNames = SOURCED_SCHOOL_FIELDS.map(([column]) => `\`${column}\``).join(' / ')
  const basicSourcedNames = BASIC_FIELD_SOURCE_CODES.map(([column]) => `\`${column}\``).join(' / ')
  return [
    '#### `provenance` の読み方',
    '',
    '| キー | 説明 |',
    '|---|---|',
    '| `official_url` | その学校の公式サイト URL。レコード直下の `official_url` と同じ値 |',
    '| `last_built_at` | この JSON を生成した時刻（ISO 8601・UTC） |',
    '| `field_sources` | 項目単位の出典。配列の各要素が 1 つの資料を表す |',
    '',
    '`field_sources` の各要素:',
    '',
    '| キー | 説明 |',
    '|---|---|',
    '| `field_name` | 出典が紐づく項目。`テーブル名.列名` 形式（例: `schools.official_url`） |',
    '| `official_url` | 元資料の URL |',
    '| `doc_title` | 元資料の題名 |',
    '| `published_at` | 元資料の公表日（不明なら null） |',
    '| `source_page_or_table` | 元資料内の位置（ページ番号・表番号など） |',
    '| `last_verified_at` | 最後に到達を確認した時刻 |',
    '| `last_http_status` | 最後に確認したときの HTTP ステータス。404 でも行は消さず、到達できなかった状態として残す |',
    '',
    `**\`field_sources\` が空配列のとき**は「項目単位の出典が登録されていない」を意味する。` +
      `データが誤っているという意味ではない。${basicSourcedNames} は出典が登録されていれば値を出し、` +
      `${sourcedNames} は**出典が登録された学校にだけフィールド自体が現れる**。`,
    '',
    '出典が一次資料でないと判定された項目（`is_official_source` が false）は、公開 API に値を出さない。',
  ].join('\n')
}

function renderDepartmentsSection() {
  return [
    '#### `departments` の読み方',
    '',
    '学科名の出典（`school_departments.name`）が登録されている学校にだけ現れる配列。',
    '',
    '| キー | 説明 |',
    '|---|---|',
    '| `name` | 学科名（学校が公表している表記） |',
    '| `course_type` | 学科分類。**分類の出典（`school_departments.course_type`）が別途登録されている場合にだけ現れる** |',
  ].join('\n')
}

function renderAdmissionSection() {
  return [
    '#### `admission_recruitment_units` の読み方',
    '',
    '募集単位ごとの入試統計。**出典が確認できた統計が 1 件以上ある学校にだけ現れる**。',
    '品質フラグが立っている統計は除外する。',
    '',
    '| キー | 説明 |',
    '|---|---|',
    '| `unit_key` | 募集単位の安定キー |',
    '| `unit_kind_code` | 募集単位の種別 |',
    '| `label` | 募集単位の表示名 |',
    '| `course_time` | 対象の課程 |',
    '| `valid_from_year` / `valid_to_year` | この募集単位が有効な年度の範囲 |',
    '| `statistics` | 年度ごとの統計。下表 |',
    '',
    '`statistics` の各要素:',
    '',
    '| キー | 説明 |',
    '|---|---|',
    '| `year` | 年度 |',
    '| `selection_stage_code` / `selection_track_code` | 選抜の段階・区分 |',
    '| `stage_label_raw` / `track_label_raw` | 一次資料での表記そのまま |',
    '| `selection_scope_raw` / `population_scope_raw` / `scope_key` | 集計範囲 |',
    '| `map_role_code` | 地図・一覧で代表値として使う役割 |',
    '| `is_ratio_comparable` | 倍率として他年度と比較してよいか |',
    '| `capacity` / `applicants` / `examinees` / `admitted` | 募集人員 / 志願者 / 受検者 / 合格者。**その指標の出典があるものだけ現れる** |',
    '| `sources` | この統計の出典。`fact_kind_code` が対応する指標を示す |',
  ].join('\n')
}

function renderNotIncludedSection() {
  return [
    '### 収録しない項目',
    '',
    '| 項目 | 理由 |',
    '|---|---|',
    '| 偏差値の編集推計 | 数値だけを切り出した序列化を避けるため。方法と限界の説明とあわせてアプリ上でのみ扱う |',
    '| 出典を確認できない項目 | 収録基準のとおり。値があっても公開側へは出さない |',
  ].join('\n')
}

function renderLifecycleSection() {
  return [
    '#### `lifecycle` の読み方',
    '',
    '| キー | 説明 |',
    '|---|---|',
    '| `lifecycle_status_code` | 学校の状態。値は上記「学校状態」 |',
    '| `recruitment_status_code` | 募集の状態。値は上記「募集状態」 |',
    '| `opened_on` | 開校日（不明なら null） |',
    '| `closed_on` | 閉校日（不明なら null） |',
    '| `recruitment_ended_on` | 募集終了日（不明なら null） |',
    '| `recruitment_ended_year` | 募集終了年度。日付まで特定できない資料のときはこちらだけ入る |',
    '| `status_official_url` | 状態の根拠にした一次資料の URL |',
  ].join('\n')
}

function renderNameHistorySection() {
  return [
    '#### `name_history` の読み方',
    '',
    '改称の履歴。旧校名で持っている外部データと突き合わせるために使う。**旧校名がある学校にだけ現れる**。',
    '',
    '| キー | 説明 |',
    '|---|---|',
    '| `name` | そのときの学校名 |',
    '| `name_kana` | ふりがな（不明なら null） |',
    '| `valid_from` / `valid_to` | その名称が有効だった期間 |',
    '| `official_url` | 改称の根拠にした一次資料の URL |',
    '| `notes` | 補足 |',
  ].join('\n')
}

function renderPredecessorsSection() {
  return [
    '#### `predecessors` の読み方',
    '',
    '統合・改組の前身校。**前身校がある学校にだけ現れる**。',
    '学校統合では前身校と後継校を法的に別の学校として扱うため、過年度の入試実績を',
    '現行校の倍率へ混ぜないよう分離している。前身校側の詳細は `predecessor.record_key` で引く。',
    '',
    '| キー | 説明 |',
    '|---|---|',
    '| `relationship_type_code` | 関係の種別（改称 / 統合 / 分割 / 改組 / 承継） |',
    '| `effective_on` | その関係が発生した日 |',
    '| `official_url` | 関係の根拠にした一次資料の URL |',
    '| `notes` | 補足 |',
    '| `predecessor` | 前身校の識別情報。下 4 行 |',
    '| `predecessor.record_key` | 前身校の安定キー。データセット内の別レコードを指す |',
    '| `predecessor.name` | 前身校の名称 |',
    '| `predecessor.closed_on` | 前身校の閉校日 |',
    '| `predecessor.lifecycle_status_code` | 前身校の状態 |',
  ].join('\n')
}

async function buildMarkdown() {
  const typeSource = await readFile(TYPES_PATH, 'utf8')
  const fieldNames = [...BASIC_FIELDS, ...SOURCED_SCHOOL_FIELDS.map(([column]) => column)]
  assertNoMissingFieldDocs(fieldNames)

  return [
    'この節は `web/scripts/gen-dataset-fields.mjs` が生成する。**手で編集しない。**',
    '列挙値の実体は `web/src/types/school.ts`、収録フィールドの実体は',
    '`web/scripts/lib/public-api.mjs` にある。',
    '',
    '### 学校レコードのフィールド',
    '',
    renderFieldTable(fieldNames),
    '',
    '### 列挙値',
    '',
    renderEnumSections(typeSource),
    '',
    '### ネストした項目',
    '',
    renderProvenanceSection(),
    '',
    renderLifecycleSection(),
    '',
    renderDepartmentsSection(),
    '',
    renderAdmissionSection(),
    '',
    renderNameHistorySection(),
    '',
    renderPredecessorsSection(),
    '',
    renderNotIncludedSection(),
  ].join('\n')
}

async function writeIntoDataMd(markdown) {
  const original = await readFile(DATA_MD_PATH, 'utf8')
  const beginIndex = original.indexOf(BEGIN_MARKER)
  const endIndex = original.indexOf(END_MARKER)
  // String.replace はマッチしなくても元の文字列を返す（＝無言で失敗する）。
  // gen-seo-pages.mjs の replaceOrThrow と同じ作法で、不発ならビルドを落とす。
  if (beginIndex < 0 || endIndex < 0 || endIndex < beginIndex) {
    throw new Error(
      `gen-dataset-fields: DATA.md に生成マーカーが無い（${BEGIN_MARKER} / ${END_MARKER}）。` +
      '差し込み先が消えている可能性がある',
    )
  }
  const next =
    original.slice(0, beginIndex + BEGIN_MARKER.length) +
    '\n\n' + markdown + '\n\n' +
    original.slice(endIndex)
  await writeFile(DATA_MD_PATH, next)
  return next
}

const markdown = await buildMarkdown()

if (process.argv.includes('--write')) {
  await writeIntoDataMd(markdown)
  process.stderr.write(`OK: DATA.md のフィールド定義を更新しました\n`)
} else {
  process.stdout.write(markdown + '\n')
}

export { buildMarkdown, BEGIN_MARKER, END_MARKER, DATA_MD_PATH }
