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
 * runtime フラグの伝達（plan_free-tier-headroom.md C2）
 *
 * 既に開いているタブへは、app_config を読み直して切替を届ける。realtime の購読は使わない。
 * 購読はタブごとに同時接続を 1 本ずつ使い、Supabase 無料枠の同時接続（200）で頭打ちになるため。
 *
 * 読み直すのは次の 4 つだけ。画面の移動では読まない（1 PV あたりの問い合わせを増やさない）。
 * - 最初の読み込み
 * - タブが見えている間、直近の読み込みから MAINTENANCE_REFETCH_INTERVAL_MS が経った時
 * - タブが見える状態に戻った時
 * - 回線が戻った時（タブが見えている場合。見えていないタブは、見えた時点で読む）
 * 読み込み中に次のきっかけが来ても、重ねて読まない。
 */

/**
 * タブが見えている間の読み直し間隔。
 * 保守モードの切替が、開いている画面へ届くまでの最大の遅れになる。
 */
export const MAINTENANCE_REFETCH_INTERVAL_MS = 5 * 60 * 1000

/** 読み直し 1 回の結果。読めなかったときは値を持たせず、OFF と区別する。 */
export type MaintenanceReadResult = { failed: false; on: boolean } | { failed: true }

/** 監視が待ち受けるイベントの発生元（document / window。テストでは EventTarget で代用する）。 */
interface ListenerTarget {
  addEventListener(type: string, listener: () => void): void
  removeEventListener(type: string, listener: () => void): void
}

export interface MaintenanceWatchOptions {
  /** app_config の runtime フラグを 1 回読む。読めなかったときは throw する。 */
  fetchOn: () => Promise<boolean>
  /** 読み込みが終わるたびに呼ぶ。止めた後に終わった読み込みの結果は渡さない。 */
  onRead: (result: MaintenanceReadResult) => void
  /** タブがいま見えているか。 */
  isVisible: () => boolean
  doc: ListenerTarget
  win: ListenerTarget
}

/**
 * runtime フラグの監視を始め、止める関数を返す。
 *
 * 読めなかったときは failed だけを渡し、値は渡さない。どちらに倒すかは呼び出し側が決める
 * （Provider は直前に読めた値を保つ。保守中に読み直しが 1 回失敗しただけで書込ブロックが外れないため）。
 */
export function watchMaintenanceFlag(options: MaintenanceWatchOptions): () => void {
  const { fetchOn, onRead, isVisible, doc, win } = options
  let stopped = false
  let inFlight = false
  let timer: ReturnType<typeof setTimeout> | null = null

  const clearTimer = () => {
    if (timer === null) return
    clearTimeout(timer)
    timer = null
  }

  // 次の間隔の読み直しは、直近の読み込みが終わった時点から数える。見えていないタブでは予約しない。
  const scheduleNext = () => {
    clearTimer()
    if (stopped || !isVisible()) return
    timer = setTimeout(() => {
      timer = null
      void read()
    }, MAINTENANCE_REFETCH_INTERVAL_MS)
  }

  const read = async () => {
    if (stopped || inFlight) return
    inFlight = true
    clearTimer()
    let result: MaintenanceReadResult
    try {
      result = { failed: false, on: await fetchOn() }
    } catch {
      result = { failed: true }
    }
    inFlight = false
    if (stopped) return
    onRead(result)
    scheduleNext()
  }

  const onVisibilityChange = () => {
    if (isVisible()) void read()
    else clearTimer()
  }
  const onOnline = () => {
    if (isVisible()) void read()
  }

  doc.addEventListener('visibilitychange', onVisibilityChange)
  win.addEventListener('online', onOnline)
  void read()

  return () => {
    stopped = true
    clearTimer()
    doc.removeEventListener('visibilitychange', onVisibilityChange)
    win.removeEventListener('online', onOnline)
  }
}
