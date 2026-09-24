import type { UserKind } from '../contexts/AuthContext'
import type { SiteMoveConfig } from '../data/site-move'

/**
 * 学校サイトの住所の移転のお知らせを、どれ出すか決める（plan_school-subdomain-move.md C2）。
 *
 * - `guest-before`   = 予告 1: 旧住所・切替日まで・ゲストでお気に入りかメモか私の記録を持つ人。
 *                      マイページとお気に入りの上に出す。閉じられない（見逃すとデータを失うため）
 * - `account-before` = 予告 2: 旧住所・切替日まで・LINE / Google でログインしている人。閉じたら出さない
 * - `after`          = お知らせ 3: 新住所・切替日から設定の日数だけ・全員。閉じたら出さない
 * - `none`           = 出さない（localhost・プレビュー・切替日が未設定のときも）
 *
 * 画面の初回描画（プリレンダーと hydration）では呼ばない。ホスト名・時刻・localStorage・
 * ログイン状態で答えが変わるので、呼ぶのはマウント後（web/src/hooks/useSiteMoveNotice.ts）。
 */
export type SiteMoveNotice = 'guest-before' | 'account-before' | 'after' | 'none'
export type ActiveSiteMoveNotice = Exclude<SiteMoveNotice, 'none'>
/** 閉じられるお知らせ */
export type DismissibleSiteMoveNotice = 'account-before' | 'after'

/** 閉じた記録を置く localStorage のキー。値は閉じたときの切替日（切替日が変わったら、また出す） */
export const SITE_MOVE_DISMISS_KEYS: Record<DismissibleSiteMoveNotice, string> = {
  'account-before': 'mm.site_move_before_dismissed',
  after: 'mm.site_move_after_dismissed',
}

/** 閉じた記録。どちらも「閉じたときの切替日」か null */
export interface SiteMoveDismissals {
  accountBefore: string | null
  after: string | null
}

export interface SiteMoveNoticeInput {
  /** `location.hostname` */
  hostname: string
  nowMs: number
  config: Pick<SiteMoveConfig, 'oldHost' | 'newHost' | 'switchDate' | 'noticeDays'>
  /** AuthContext の kind（null = 未ログイン、または読み込み中） */
  userKind: UserKind
  /** お気に入り・メモ・私の記録を 1 件以上持つか（予告 1 だけが見る） */
  hasUserData: boolean
  dismissals: SiteMoveDismissals
  /**
   * 開発時だけ使う強制表示。ホスト名・日時・利用者の種類・データの有無を見ずにこの種類を返す。
   * 閉じた記録は見る（閉じたら次に開いても出ないことを確かめられるように）。
   */
  force?: ActiveSiteMoveNotice | null
}

const DAY_MS = 24 * 60 * 60 * 1000
const JST_OFFSET_MS = 9 * 60 * 60 * 1000
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/** 時刻を日本時間の日付 `YYYY-MM-DD` にする */
export function toJstDate(ms: number): string {
  return new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 10)
}

/** 切替日（日本時間の `YYYY-MM-DD`）の 0:00 の時刻。形式が違う・実在しない日付は null */
export function switchStartMs(switchDate: string | null): number | null {
  if (!switchDate || !DATE_RE.test(switchDate)) return null
  const ms = Date.parse(`${switchDate}T00:00:00+09:00`)
  if (!Number.isFinite(ms)) return null
  // 2026-02-30 のような日付を翌月へ繰り上げて受け取る実装があるので、戻して一致するかを見る
  if (toJstDate(ms) !== switchDate) return null
  return ms
}

function normalizeHost(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/\.$/, '')
}

export function isSiteMoveNoticeDismissed(
  notice: SiteMoveNotice,
  dismissals: SiteMoveDismissals,
  switchDate: string | null,
): boolean {
  if (!switchDate) return false
  if (notice === 'account-before') return dismissals.accountBefore === switchDate
  if (notice === 'after') return dismissals.after === switchDate
  return false
}

export function decideSiteMoveNotice(input: SiteMoveNoticeInput): SiteMoveNotice {
  const { config, dismissals, force } = input
  const start = switchStartMs(config.switchDate)
  if (start === null) return 'none'

  if (force) return isSiteMoveNoticeDismissed(force, dismissals, config.switchDate) ? 'none' : force

  const host = normalizeHost(input.hostname)

  if (host === normalizeHost(config.oldHost)) {
    // 切替日の終わりまで出す。転送が入ったあとは旧住所の画面そのものが開かれない
    if (input.nowMs >= start + DAY_MS) return 'none'
    if (input.userKind === 'anon') return input.hasUserData ? 'guest-before' : 'none'
    if (input.userKind === 'google' || input.userKind === 'line') {
      return isSiteMoveNoticeDismissed('account-before', dismissals, config.switchDate) ? 'none' : 'account-before'
    }
    return 'none'
  }

  if (host === normalizeHost(config.newHost)) {
    if (!Number.isFinite(config.noticeDays) || config.noticeDays <= 0) return 'none'
    if (input.nowMs < start || input.nowMs >= start + config.noticeDays * DAY_MS) return 'none'
    return isSiteMoveNoticeDismissed('after', dismissals, config.switchDate) ? 'none' : 'after'
  }

  return 'none'
}

const EN_MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

/** 文言に出す切替日。ja は「10月15日」、en は「October 15」 */
export function formatSwitchDateLabel(switchDate: string, locale: 'ja' | 'en'): string {
  if (switchStartMs(switchDate) === null) return switchDate
  const month = Number(switchDate.slice(5, 7))
  const day = Number(switchDate.slice(8, 10))
  return locale === 'en' ? `${EN_MONTHS[month - 1]} ${day}` : `${month}月${day}日`
}

// --- 開発時の強制表示 ------------------------------------------------------------
//
// `import.meta.env.DEV` のときだけ web/src/hooks/useSiteMoveNotice.ts が呼ぶ。本番のビルドでは
// 呼び出しごと消える。
//
//   ?siteMoveNotice=1|2|3      予告 1 / 予告 2 / お知らせ 3 を強制表示（閉じた記録は見る）
//   ?siteMoveHost=old|new      ホスト名を旧住所 / 新住所に見立てる（ログイン状態などは実物で判定）
//   ?siteMoveSwitch=YYYY-MM-DD 切替日に見立てる日付
//   ?siteMoveReset=1           閉じた記録を消してから判定する
//
// 設定の切替日が null で siteMoveSwitch も無いときは、新住所・お知らせ 3 なら今日、
// それ以外は今日から 14 日後を切替日に見立てる。

const FORCE_BY_PARAM: Record<string, ActiveSiteMoveNotice> = {
  '1': 'guest-before',
  '2': 'account-before',
  '3': 'after',
}

export interface SiteMoveDevEnv {
  /** 見立てるホスト名（null = 実物のまま） */
  hostname: string | null
  /** 見立てる切替日 */
  switchDate: string
  force: ActiveSiteMoveNotice | null
  reset: boolean
}

export function resolveSiteMoveDevEnv(
  search: string,
  config: Pick<SiteMoveConfig, 'oldHost' | 'newHost' | 'switchDate'>,
  nowMs: number,
): SiteMoveDevEnv | null {
  const params = new URLSearchParams(search)
  const force = FORCE_BY_PARAM[params.get('siteMoveNotice') ?? ''] ?? null
  const hostParam = params.get('siteMoveHost')
  const host = hostParam === 'old' || hostParam === 'new' ? hostParam : null
  const switchParam = params.get('siteMoveSwitch')
  const reset = params.get('siteMoveReset') === '1'
  if (!force && !host && !switchParam && !reset) return null

  const simulatedToday = force === 'after' || (!force && host === 'new')
  const switchDate =
    (switchParam && switchStartMs(switchParam) !== null ? switchParam : null) ??
    config.switchDate ??
    toJstDate(simulatedToday ? nowMs : nowMs + 14 * DAY_MS)

  return {
    hostname: host === 'old' ? config.oldHost : host === 'new' ? config.newHost : null,
    switchDate,
    force,
    reset,
  }
}
