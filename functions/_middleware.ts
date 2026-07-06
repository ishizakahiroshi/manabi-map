// Cloudflare Pages Functions middleware — メンテナンスモード切替
//
// 配置について: Pages Functions の `functions/` ディレクトリは「Pages プロジェクトの
// Root directory 直下」に置く仕様（build output dir の中ではない）。本プロジェクトの
// Pages 設定は Root directory 未指定(= リポジトリルート) / Build command
// `cd web && pnpm install && pnpm build` / Build output `web/dist` のため、
// リポジトリルート直下の本ディレクトリが正しい配置。
// 参照: https://developers.cloudflare.com/pages/functions/get-started/
//
// 動作:
// - 環境変数 MAINTENANCE_MODE=1 のとき、許可リスト以外の全リクエストを
//   /maintenance.html の内容で HTTP 200 応答する(503 は SEO 悪影響のため使わない)。
// - MAINTENANCE_MODE が "1" 以外(0 / 未設定)なら素通し。
// - /legal/* は SPA ルート(React が /legal/*.md を fetch して描画)のため、
//   index.html への SPA フォールバック(_redirects)と /assets/* の JS/CSS も
//   通す必要がある。/assets/* を許可しても index.html 本体は書き換え対象なので
//   アプリ画面(/ /map /favorites)がメンテ中に見えることはない。
//
// 切替手順の正典: docs/local/maintenance-mode-runbook.md
// 注意: Pages の環境変数変更は再デプロイ(最新デプロイの Retry で可)を伴う。

interface Env {
  MAINTENANCE_MODE?: string;
  ASSETS: { fetch: (input: Request | string | URL) => Promise<Response> };
}

interface Context {
  request: Request;
  env: Env;
  next: () => Promise<Response>;
}

/** メンテ中も素通しするパス(前方一致) */
const ALLOWED_PREFIXES = [
  "/legal/", // 法務ページ(SPA ルート + public/legal/*.md)は常時閲覧可能
  "/assets/", // Vite ビルドの JS/CSS(/legal/* の SPA 描画に必要)
];

/** メンテ中も素通しするパス(完全一致) — maintenance.html 自身と最小限の静的アセット */
const ALLOWED_PATHS = new Set([
  "/maintenance.html",
  "/favicon.ico",
  "/favicon.svg",
  "/favicon-16.png",
  "/favicon-32.png",
  "/favicon-48.png",
  "/apple-touch-icon.png",
  "/icon-192.png",
  "/icon-512.png",
  "/icon.svg",
  "/brand-mark.svg",
  "/manifest.webmanifest",
]);

export const onRequest = async (context: Context): Promise<Response> => {
  const { request, env, next } = context;

  if (env.MAINTENANCE_MODE !== "1") {
    return next();
  }

  const { pathname } = new URL(request.url);
  if (
    ALLOWED_PATHS.has(pathname) ||
    ALLOWED_PREFIXES.some((prefix) => pathname.startsWith(prefix))
  ) {
    return next();
  }

  const asset = await env.ASSETS.fetch(new URL("/maintenance.html", request.url));
  return new Response(asset.body, {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      // メンテ解除後に古い画面がキャッシュから出ないようにする
      "cache-control": "no-store",
    },
  });
};
