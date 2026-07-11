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
 * フラグ方式: **env var `VITE_MAINTENANCE_MODE=1`**。理由:
 * 1. DB 復元中のシナリオでも DB 参照なしで判定できる（plan の DB 非依存原則）
 * 2. Cloudflare Pages のダッシュボードで env var を差し替え → Retry deploy（数分）で切替可能
 * 3. 新規テーブル・migration 不要（app_config 案は将来 DB 依存の運用が増えた時に検討）
 *
 * ローカル開発では `web/.env.local` に `VITE_MAINTENANCE_MODE=1` を追加すると動作を確認できる。
 */
export const MAINTENANCE_MODE: boolean =
  (import.meta.env.VITE_MAINTENANCE_MODE as string | undefined) === '1'
