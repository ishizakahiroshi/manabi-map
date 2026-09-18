/**
 * メンテナンスモード（アプリ内の読み取り専用モード）
 *
 * Cloudflare Pages Functions の `_middleware.ts` によるハード遮断（全 URL を maintenance.html に
 * 差し替え）とは別レイヤーの、より柔らかい降格モード。
 *
 * ON にすると:
 * - 全ページ header に <MaintenanceBanner/> を表示
 * - 書き込み系 mutation（お気に入り追加/削除・メモ保存・私の記録保存・admin override 等）を
 *   早期 return + トースト通知
 * - 読み取り系（地図・詳細閲覧・お気に入り一覧の閲覧）は動作させる
 * - 認証状態は維持する（ログイン画面も動作）
 *
 * フラグ方式: env var `VITE_MAINTENANCE_MODE=1` は DB に到達できない場合の
 * 緊急保険として残し、通常運用では app_config の runtime フラグを使う。
 * env var を保険として残す理由:
 * 1. DB 復元中のシナリオでも DB 参照なしで判定できる（plan の DB 非依存原則）
 * 2. Cloudflare Pages のダッシュボードで env var を差し替え → Retry deploy（数分）で切替可能
 * 3. 新規テーブル・migration が未適用でも緊急遮断できる
 *
 * ローカル開発では `web/.env.local` に `VITE_MAINTENANCE_MODE=1` を追加すると動作を確認できる。
 */
export const MAINTENANCE_MODE: boolean =
  (import.meta.env.VITE_MAINTENANCE_MODE as string | undefined) === '1'

/**
 * app_config.value から書込ブロックの有無を読む純粋関数。
 * 形が違う値（null・文字列・別の鍵）は OFF に倒す。
 */
export function readMaintenanceOn(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  return (value as { on?: unknown }).on === true
}

/*
 * runtime フラグの伝達（plan_security-audit-remediation.md C6）
 *
 * 既に開いているタブへ切替を伝える手段は realtime の購読 1 本しか無い。購読は黙って切れるので、
 * 状態を受け取らずに呼ぶと「切替が届かなかった」と「OFF のまま」が区別できない。
 * 読み直す機会は「購読の状態が変わった時」と「画面に戻った時」の 2 つだけにする。
 * 常時ポーリングは要求数がそのまま費用になるので入れない。
 */

/** 購読が成立している状態（supabase-js の REALTIME_SUBSCRIBE_STATES と同じ文字列）。 */
const LIVE_CHANNEL_STATUS = 'SUBSCRIBED'
/** 購読が切れた・張れなかった状態。ここに来た時点で以降の切替は届かない。 */
const BROKEN_CHANNEL_STATUSES = ['CHANNEL_ERROR', 'TIMED_OUT', 'CLOSED']

export function isMaintenanceChannelLive(status: string): boolean {
  return status === LIVE_CHANNEL_STATUS
}

export function isMaintenanceChannelBroken(status: string): boolean {
  return BROKEN_CHANNEL_STATUSES.includes(status)
}

/**
 * 購読状態が変わった時に読み直すか。
 * 成立時も読み直す（張り直しが済むまでの間に起きた切替を、ここで 1 回だけ拾う）。
 */
export function shouldRefetchForChannelStatus(status: string): boolean {
  return isMaintenanceChannelLive(status) || isMaintenanceChannelBroken(status)
}

/**
 * 読み直しの最小間隔。切断時は supabase 側が再接続を繰り返すので、
 * 状態変化のたびに問い合わせると事実上のポーリングになる。その下限だけを決める。
 */
export const MAINTENANCE_REFETCH_MIN_INTERVAL_MS = 10_000

/** 直近の読み込みからの経過で、いま読み直してよいかを決める純粋関数。 */
export function shouldRefetchNow(lastFetchedAt: number | null, now: number): boolean {
  if (lastFetchedAt === null) return true
  return now - lastFetchedAt >= MAINTENANCE_REFETCH_MIN_INTERVAL_MS
}
