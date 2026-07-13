import type { School } from '../types/school'

/** §7.7 学校表示規約 */
export const OWN_LABEL: Record<string, string> = {
  prefectural: '県', municipal: '市', national: '国', private: '私', union: '組',
}
export const GEN_LABEL: Record<string, string> = { coed: '共', boys: '男', girls: '女' }
export const OWN_FULL: Record<string, string> = {
  prefectural: '県立', municipal: '市立', national: '国立', private: '私立', union: '組合立',
}
export const GEN_FULL: Record<string, string> = { coed: '共学', boys: '男子校', girls: '女子校' }
export const TYPE_FULL: Record<string, string> = {
  high_school: '高等学校', kosen: '高等専門学校（5年制）',
}
export const COURSE_TIME_FULL: Record<string, string> = {
  fulltime: '全日制',
  parttime: '定時制',
  correspondence: '通信制',
}
export const CAMPUS_TYPE_FULL: Record<string, string> = {
  main: '本校',
  partner_school: '連携校',
  satellite_campus: 'サテライト',
  support_school: 'サポート校',
}

/**
 * 公立の正式名称に「立」を含めない都道府県（北海道◯◯高等学校 / 宮城県◯◯高等学校 /
 * 長野県◯◯高等学校 形式）。この 3 道県は接頭辞を正規表現（[都道府県]立）で判別できないため、
 * 設置者が prefectural と分かる場合のみ都道府県名そのものを剥がす。
 * 「立」を機械的に剥がさないのは「長野県立科高等学校」型（地名の立科）を守るため。
 */
const PREF_WITHOUT_RITSU = new Set(['北海道', '宮城県', '長野県'])

/**
 * 地図ピン・一覧カード用の短縮校名。設置者情報は §7.7 の運営コード（県/市/国/私/組）で
 * 併記されるため、名称からは冗長な設置者接頭辞と「高等学校」を落とす。
 * 例: 群馬県立前橋高等学校 → 前橋高校 / 群馬工業高等専門学校 → 群馬工業高専
 *
 * school（ownership + prefecture）を渡すと、「立」を含まない公立正式名
 * （例: 北海道札幌南高等学校 → 札幌南高校）も短縮できる。私立の「北海道◯◯」等の
 * 校名ブランドを誤って剥がさないよう、public 判定できない場合は接頭辞に触れない。
 */
export function shortSchoolName(
  name: string,
  school?: Pick<School, 'ownership' | 'prefecture'>,
): string {
  if (
    school?.ownership === 'prefectural' &&
    PREF_WITHOUT_RITSU.has(school.prefecture) &&
    name.startsWith(school.prefecture)
  ) {
    name = name.slice(school.prefecture.length)
  }
  return name
    // 都道府県名 + 都/道/府/県 + 立（例: 群馬県立 / 埼玉県立 / 東京都立 / 北海道立 / 大阪府立）
    .replace(/^.+?[都道府県]立/, '')
    // 都道府県名なしの「都立」「県立」等（念のため）
    .replace(/^(?:都立|道立|府立|県立)/, '')
    // 「N市立N…」= 前橋市立前橋 / 太田市立太田 / 高崎市立高崎経済… は市名 N まで剥がす
    .replace(/^([^\s]{2,4})市立\1/, '$1')
    // 「N市立X…」（X ≠ N）= 桐生市立商業 / 伊勢崎市立四ツ葉学園 等は「市立」だけ剥がし
    // 市名 N は残す（残さないと「商業高校」のようにどの市か分からなくなる）
    .replace(/^([^\s]{2,4})市立/, '$1')
    .replace(/^国立/, '')
    .replace(/高等専門学校$/, '高専')
    .replace(/高等学校$/, '高校')
    .replace(/中等教育学校$/, '中等')
}

/**
 * Leaflet divIcon 等、innerHTML に連結する箇所向けの HTML エスケープ。
 * schools への書込は service_role 限定だが、外部提供データが混入した場合の
 * stored XSS を防ぐ多層防御として、DB 由来テキストは必ずこれを通す。
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function band(dev: number): 70 | 60 | 50 | 40 | 30 {
  if (dev >= 70) return 70
  if (dev >= 60) return 60
  if (dev >= 50) return 50
  if (dev >= 40) return 40
  return 30
}

function devValues(s: School): number[] {
  return s.departments.map((d) => d.deviation).filter((v): v is number => v != null)
}

export function topDev(s: School): number | null {
  const vs = devValues(s)
  return vs.length ? Math.max(...vs) : null
}

export function botDev(s: School): number | null {
  const vs = devValues(s)
  return vs.length ? Math.min(...vs) : null
}

/** 偏差値レンジ表記。未確定は「−」（§7.7.5: 0 や null を数値で見せない） */
export function devLabel(s: School): string {
  const t = topDev(s)
  const b = botDev(s)
  if (t == null || b == null) return '−'
  return t === b ? `${t}` : `${b}〜${t}`
}

/**
 * 設立主体の短縮表記（1 文字）。
 * prefectural + 東京都 → '都'、北海道 → '道'、大阪府/京都府 → '府'、他 → '県'
 * それ以外は OWN_LABEL 準拠（市/国/私/組）。
 */
export function ownershipShort(s: School): string {
  if (s.ownership === 'prefectural') {
    if (s.prefecture === '東京都') return '都'
    if (s.prefecture === '北海道') return '道'
    if (s.prefecture === '大阪府' || s.prefecture === '京都府') return '府'
    return '県'
  }
  return OWN_LABEL[s.ownership] ?? ''
}

/**
 * 設立主体のフル表記（2 文字）。
 * prefectural + 東京都 → '都立'、北海道 → '道立'、大阪府/京都府 → '府立'、他 → '県立'
 * それ以外は OWN_FULL 準拠（市立/国立/私立/組合立）。
 */
export function ownershipFull(s: School): string {
  if (s.ownership === 'prefectural') {
    if (s.prefecture === '東京都') return '都立'
    if (s.prefecture === '北海道') return '道立'
    if (s.prefecture === '大阪府' || s.prefecture === '京都府') return '府立'
    return '県立'
  }
  return OWN_FULL[s.ownership] ?? ''
}

export function displayCode(s: School): string {
  return ownershipShort(s) + (GEN_LABEL[s.gender_type] ?? '')
}

export function courseTimeLabel(s: School): string {
  const labels = s.course_times.map((c) => COURSE_TIME_FULL[c]).filter((v): v is string => Boolean(v))
  return labels.length ? labels.join('・') : '情報募集中'
}

export type ScaleBand = 'small' | 'medium' | 'large'

const SCALE_BAND_LABEL: Record<ScaleBand, string> = {
  small: '小規模',
  medium: '中規模',
  large: '大規模',
}

/**
 * admission_stats の最新年から 1 学年あたり募集定員を学校単位で合算する。
 * 学科行がある年は学科行のみ合算し、学校全体行（department_id = null）との二重計上を避ける。
 * 前期/後期分割の県では capacity が後期枠のみのことがあり過小になり得る（バンドは目安表記で吸収）。
 */
export function gradeCapacity(s: School): number | null {
  const byYear = new Map<number, { dept: number; wide: number; hasDept: boolean; hasWide: boolean }>()
  for (const stat of s.admission_stats) {
    if (stat.capacity == null || stat.capacity <= 0) continue
    const e = byYear.get(stat.year) ?? { dept: 0, wide: 0, hasDept: false, hasWide: false }
    if (stat.department_id == null) {
      e.wide += stat.capacity
      e.hasWide = true
    } else {
      e.dept += stat.capacity
      e.hasDept = true
    }
    byYear.set(stat.year, e)
  }
  if (byYear.size === 0) return null
  const latest = Math.max(...byYear.keys())
  const e = byYear.get(latest)!
  return e.hasDept ? e.dept : e.hasWide ? e.wide : null
}

/** 1 学年募集定員から規模バンドを導出（小=〜120 / 中=121〜240 / 大=241〜） */
export function scaleBand(s: School): ScaleBand | null {
  const cap = gradeCapacity(s)
  if (cap == null) return null
  if (cap <= 120) return 'small'
  if (cap <= 240) return 'medium'
  return 'large'
}

export function enrollmentLabel(s: School): string {
  if (s.total_students != null && s.enrollment_year != null) {
    return `約 ${s.total_students.toLocaleString()} 人（${s.enrollment_year} 年）`
  }
  const band = scaleBand(s)
  if (band) return `${SCALE_BAND_LABEL[band]}（募集定員ベースの目安）`
  return '情報募集中'
}

export function genderRatioLabel(s: School): string | null {
  if (s.male_ratio == null) return null
  const source = s.enrollment_year != null ? `${s.enrollment_year} 年・学校基本調査ベース` : '学校公表情報ベース'
  return `男 ${s.male_ratio}% / 女 ${100 - s.male_ratio}%（${source}）`
}

export function extraBadge(s: School): string {
  if (s.type === 'kosen') return ' [5年制]'
  if (s.is_integrated) return ' [中高一貫]'
  return ''
}

/** 校名（[運営][性別]：偏差値）+ 特殊バッジ */
export function displayName(s: School): string {
  const recruiting = s.is_recruiting ? '' : '[募集停止] '
  return `${recruiting}${s.name}（${displayCode(s)}：${devLabel(s)}）${extraBadge(s)}`
}

/** テスト用: displayName の関数を、指定 ownership/prefecture の School で組む fixture */

