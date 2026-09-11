// Cloudflare Pages Functions middleware — メンテナンスモード切替 + SPA フォールバック
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
//   /maintenance.html の内容で HTTP 503 応答する。Retry-After と no-store を付ける。
//   メンテナンス判定は SPA フォールバックより先に走る（/map 等もメンテ中は 503）。
// - MAINTENANCE_MODE が "1" 以外(0 / 未設定)のとき、SPA_ROUTES に列挙したルートは
//   index.html の本文を HTTP 200 で返す（後述）。それ以外は素通し。
// - /legal/* は SPA ルート(React が /legal/*.md を fetch して描画)だが、build 時に
//   dist/legal/*/index.html を生成しているため静的配信される。メンテ中は /legal/* と
//   /assets/* の JS/CSS を通す必要がある。/legal/* の許可は SPA のハード遮断を
//   保証しないため、ハードメンテ時は VITE_MAINTENANCE_MODE も設定する。
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
  "/robots.txt",
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

// --- SPA フォールバック -------------------------------------------------------
//
// ★ SPA ルート列挙の正典はこのファイル。web/public/_redirects には書かない。
//
// 経緯 (docs/local/bugfix_map-direct-url-and-csp_2026-09-11.md §2-1 / §5-1 案 A):
// `_redirects` に `/map /index.html 200` と書く形の rewrite は、Cloudflare Pages が
// rewrite 先の `/index.html` を `/` へ 308 正規化するため、クライアントには
// 「308 → トップ」が届いていた（開こうとしたルートが失われる）。
// `/auth/*` `/family/*` のワイルドカード行は 404 になっていた。
// そこでルート列挙を middleware 側へ寄せ、ASSETS から直接 index.html の本文を
// 取って HTTP 200 で返す。
//
// 列挙外の URL は従来どおり next() へ流し、Pages が dist/404.html を HTTP 404 で
// 返す（2026-08-04 のソフト 404 解消の成果。
// docs/local/archive/plan_seo-growth-strategy_c5_static-routes.md C4）。
// `/`・`/school/*`・`/schools/`・`/pref/*`・`/legal/*`・`/press`・`/data`・`/guide/*` は
// build 時に静的 HTML(SSR プリレンダー)を生成しているので、ここで横取りしない。
//
// ルートを足すときは web/src/App.tsx の <Route> と対応させる。

/** index.html の本文を 200 で返すルート(末尾スラッシュは正規化して比較) */
const SPA_ROUTES = new Set([
  "/map",
  "/search",
  "/favorites",
  "/compare",
  "/mypage",
  "/dashboard",
  "/auth/callback", // OAuth の戻り先
  "/family/join", // 家族招待リンクの着地先
]);

// index.html は `/` として取得する。`/index.html` を直接 ASSETS から取ると
// Pages のアセット正規化で 308(`/` へ) が返り、本文が得られない。
const SPA_SHELL_PATH = "/";

/**
 * Cloudflare Pages は末尾スラッシュの有無で別 URL として扱うため、
 * web/src/App.tsx と同じ正規化(末尾スラッシュ除去)を通してから照合する。
 */
export const isSpaRoute = (pathname: string): boolean =>
  SPA_ROUTES.has(pathname.replace(/\/+$/, "") || "/");

export const onRequest = async (context: Context): Promise<Response> => {
  const { request, env, next } = context;
  const { pathname } = new URL(request.url);

  if (env.MAINTENANCE_MODE === "1") {
    // API は maintenance.html（200 + HTML）で汚さず、各 Function 自身の
    // 認証・認可・エラー応答を返す。admin 誤判定もここで防ぐ。
    if (pathname.startsWith("/api/")) {
      return next();
    }
    if (
      ALLOWED_PATHS.has(pathname) ||
      ALLOWED_PREFIXES.some((prefix) => pathname.startsWith(prefix))
    ) {
      return next();
    }

    const asset = await env.ASSETS.fetch(new URL("/maintenance.html", request.url));
    return new Response(asset.body, {
      status: 503,
      headers: {
        "content-type": "text/html; charset=utf-8",
        // 短時間の停止をクローラー・クライアントへ通知する
        "retry-after": "300",
        // メンテ解除後に古い画面がキャッシュから出ないようにする
        "cache-control": "no-store",
      },
    });
  }

  // GET / HEAD 以外(POST 等)を HTML 200 にすり替えない。
  const isReadRequest = request.method === "GET" || request.method === "HEAD";
  if (isReadRequest && isSpaRoute(pathname)) {
    const shell = await env.ASSETS.fetch(new URL(SPA_SHELL_PATH, request.url));
    // シェルが取れないときは従来どおりの応答へ落とす(勝手に 200 を作らない)。
    if (!shell.ok) {
      return next();
    }
    // _headers 由来のヘッダ(CSP 等)を落とさないよう、本文と一緒にそのまま引き継ぐ。
    const headers = new Headers(shell.headers);
    headers.set("content-type", "text/html; charset=utf-8");
    return new Response(shell.body, { status: 200, headers });
  }

  return next();
};
