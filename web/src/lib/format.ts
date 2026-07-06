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
 * 地図ピン・一覧カード用の短縮校名。設置者情報は §7.7 の運営コード（県/市/国/私/組）で
 * 併記されるため、名称からは冗長な設置者接頭辞と「高等学校」を落とす。
 * 例: 群馬県立前橋高等学校 → 前橋高校 / 群馬工業高等専門学校 → 群馬工業高専
 */
export function shortSchoolName(name: string): string {
  return name
    .replace(/^群馬県立/, '')
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

export function enrollmentLabel(s: School): string {
  if (s.total_students == null || s.enrollment_year == null) return '情報募集中'
  return `約 ${s.total_students.toLocaleString()} 人（${s.enrollment_year} 年）`
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

