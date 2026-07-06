import type { School, Favorite, MineRecord, SchoolNote } from '../types/school'

/**
 * C1: マイデータエクスポート。
 * お気に入り + メモ + 個人偏差値記録を「ユーザー向け意味論」の JSON に整形する。
 * uuid や内部 FK は出力せず、学校は「校名 + 都道府県」、学科は学科名で表現する
 * （将来の import で内部 ID の張り替えに縛られないため）。
 */

export const EXPORT_FORMAT_VERSION = 1

interface UserDataSlice {
  favorites: Record<string, Favorite>
  notes: Record<string, SchoolNote>
  mine: Record<string, MineRecord>
}

interface ExportDeviationRecord {
  /** 学科名（学校単位メモは含まない） */
  department: string
  /** 本人が入力した偏差値（塾で聞いた値・模試など） */
  value: number
}

interface ExportSchoolEntry {
  school: string
  prefecture: string
  favorite: { priority: number; status: string } | null
  note: string | null
  commute_note: string | null
  my_deviation_records: ExportDeviationRecord[] | null
  my_deviation_note: string | null
  /** 個人偏差値記録の共有設定（ユーザー向け表現） */
  my_deviation_sharing: string | null
}

export interface MyDataExport {
  format_version: number
  service: string
  exported_at: string
  schools: ExportSchoolEntry[]
}

const STATUS_LABEL: Record<string, string> = {
  interested: '気になる',
}

const SHARING_LABEL: Record<string, string> = {
  private: '非公開（本人のみ）',
  submit_to_manabi: 'Manabi Map 参考値の改善に匿名で提供することに同意',
}

function hasMineContent(m: MineRecord | undefined): boolean {
  if (!m) return false
  return Object.keys(m.depts).length > 0 || m.note.trim() !== ''
}

function hasNoteContent(n: SchoolNote | undefined): boolean {
  if (!n) return false
  return n.note.trim() !== '' || n.commute_note.trim() !== ''
}

/** export 対象の school_id 一覧（お気に入り or メモあり or 個人記録あり） */
function targetSchoolIds(u: UserDataSlice): string[] {
  const ids = new Set<string>()
  for (const id of Object.keys(u.favorites)) ids.add(id)
  for (const [id, n] of Object.entries(u.notes)) if (hasNoteContent(n)) ids.add(id)
  for (const [id, m] of Object.entries(u.mine)) if (hasMineContent(m)) ids.add(id)
  return [...ids]
}

/** DL 対象データの件数（0 ならボタンを disabled にする） */
export function countMyData(u: UserDataSlice): number {
  return targetSchoolIds(u).length
}

export function buildMyData(schools: School[], u: UserDataSlice): MyDataExport {
  const byId = new Map(schools.map((s) => [s.id, s]))
  const entries: ExportSchoolEntry[] = []

  for (const id of targetSchoolIds(u)) {
    const school = byId.get(id)
    const fav = u.favorites[id]
    const note = u.notes[id]
    const mine = u.mine[id]

    let records: ExportDeviationRecord[] | null = null
    if (mine && Object.keys(mine.depts).length > 0) {
      const deptName = new Map((school?.departments ?? []).map((d) => [d.id, d.name]))
      records = Object.entries(mine.depts).map(([deptId, value]) => ({
        department: deptName.get(deptId) ?? '（学科情報を取得できませんでした）',
        value,
      }))
    }

    entries.push({
      // schools 一覧に無い学校（データ更新で非公開化された等）でも本人データは必ず出力する
      school: school?.name ?? '（学校情報を取得できませんでした）',
      prefecture: school?.prefecture ?? '',
      favorite: fav ? { priority: fav.priority, status: STATUS_LABEL[fav.status] ?? fav.status } : null,
      note: note?.note.trim() ? note.note : null,
      commute_note: note?.commute_note.trim() ? note.commute_note : null,
      my_deviation_records: records,
      my_deviation_note: mine?.note.trim() ? mine.note : null,
      my_deviation_sharing: hasMineContent(mine) ? (SHARING_LABEL[mine.visibility] ?? mine.visibility) : null,
    })
  }

  // 志望度の高い順 → 校名順で安定させる（人が読む JSON なので並びにも意味を持たせる）
  entries.sort((a, b) => {
    const pa = a.favorite?.priority ?? -1
    const pb = b.favorite?.priority ?? -1
    if (pa !== pb) return pb - pa
    return a.school.localeCompare(b.school, 'ja')
  })

  return {
    format_version: EXPORT_FORMAT_VERSION,
    service: 'Manabi Map (https://manabi-map.app)',
    exported_at: new Date().toISOString(),
    schools: entries,
  }
}

/** ローカル日付で manabi-map-mydata-YYYY-MM-DD.json のファイル名を作る */
export function exportFileName(now: Date = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `manabi-map-mydata-${y}-${m}-${d}.json`
}

/** Blob + a[download] で JSON をダウンロードさせる */
export function downloadMyData(schools: School[], u: UserDataSlice): void {
  const data = buildMyData(schools, u)
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = exportFileName()
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}
