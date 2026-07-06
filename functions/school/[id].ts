// Cloudflare Pages Functions — 学校詳細の動的 OGP（/school/:id）
//
// 目的: 学校ごとの共有 URL（https://manabi-map.app/school/<uuid>）を X / LINE 等に
// 貼ったとき、校名 + 基本情報入りの OGP カードが出るようにする。
//
// 動作:
// - クローラー（bot User-Agent）からのリクエストのみ、ビルド済み index.html の
//   <title> / OGP / Twitter Card メタを該当校の内容へ書き換えて返す。
// - 人間のブラウザは next() で素通し → _redirects の SPA フォールバックにより
//   通常どおり index.html（React 側は /school/:id ルートで詳細シートを開く）。
// - 学校データは Supabase REST（anon key・RLS 公開読み取りの schools テーブル）から
//   取得する。接続情報は Pages の環境変数 SUPABASE_URL / SUPABASE_ANON_KEY で受ける
//   （コードに実値を書かない。未設定・取得失敗・校が見つからない場合は素通し）。
// - OGP 画像は第一段階として静的 og-hero.png を継続使用し、og:title / og:description /
//   og:url / twitter:* のみ動的化する（Workers での画像生成は satori 等の重依存が
//   必要になるため見送り。拡張する場合は本ファイルの buildMeta の og:image を
//   画像生成エンドポイントへ差し替えるだけでよい設計にしてある）。
//
// 併存: functions/_middleware.ts（メンテモード）が先に走る。メンテ中は本関数まで
// 到達しないため干渉しない。
//
// 検証手順・環境変数の設定手順の正典: docs/local/plan_v0.2.0-release_c10_app-features.md §C8

interface Env {
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
  ASSETS: { fetch: (input: Request | string | URL) => Promise<Response> };
}

interface Context {
  request: Request;
  env: Env;
  params: { id: string };
  next: () => Promise<Response>;
}

interface SchoolRow {
  name: string;
  prefecture: string | null;
  city: string | null;
  ownership: string | null;
  type: string | null;
  is_active: boolean;
  school_departments?: { name: string }[] | null;
}

/** OGP を取りに来る主要クローラー。LINE は facebookexternalhit 系 UA で来る */
const BOT_UA =
  /bot|crawl|spider|slurp|bingpreview|facebookexternalhit|twitterbot|discordbot|telegrambot|whatsapp|skypeuripreview|linkedinbot|pinterest|embedly|vkshare|redditbot|applebot|line-poker/i;

const OWNERSHIP_LABEL: Record<string, string> = {
  prefectural: "県立",
  municipal: "市立",
  national: "国立",
  private: "私立",
  union: "組合立",
};

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** <meta property|name="key" content="..."> の content を置換（属性順は index.html の記述に依存） */
function setMeta(html: string, attr: "property" | "name", key: string, value: string): string {
  const re = new RegExp(`(<meta\\s+${attr}="${key}"\\s+content=")[^"]*(")`);
  return html.replace(re, `$1${escapeAttr(value)}$2`);
}

async function fetchSchool(env: Env, id: string): Promise<SchoolRow | null> {
  if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) return null;
  const url =
    `${env.SUPABASE_URL}/rest/v1/schools` +
    `?id=eq.${encodeURIComponent(id)}` +
    `&select=name,prefecture,city,ownership,type,is_active,school_departments(name)` +
    `&limit=1`;
  const res = await fetch(url, {
    headers: {
      apikey: env.SUPABASE_ANON_KEY,
      authorization: `Bearer ${env.SUPABASE_ANON_KEY}`,
    },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) return null;
  const rows = (await res.json()) as SchoolRow[];
  const row = rows[0];
  return row && row.is_active ? row : null;
}

function buildDescription(s: SchoolRow): string {
  const loc = `${s.prefecture ?? ""}${s.city ?? ""}`;
  const own = s.ownership ? (OWNERSHIP_LABEL[s.ownership] ?? "") : "";
  const kind = s.type === "kosen" ? "高専" : "高校";
  const depts = (s.school_departments ?? [])
    .map((d) => d.name)
    .filter(Boolean)
    .slice(0, 6)
    .join("・");
  const head = `${loc}の${own}${kind}。`;
  const deptPart = depts ? `学科: ${depts}。` : "";
  return `${head}${deptPart}地図で場所と通学時間を確認して、親子のメモを残せます。 — Manabi Map`;
}

export const onRequest = async (context: Context): Promise<Response> => {
  const { request, env, params, next } = context;

  const ua = request.headers.get("user-agent") ?? "";
  if (!BOT_UA.test(ua)) return next();

  const id = params.id;
  // uuid 以外（パストラバーサル等）は素通し
  if (!/^[0-9a-fA-F-]{8,64}$/.test(id)) return next();

  try {
    const school = await fetchSchool(env, id);
    if (!school) return next();

    const assetRes = await env.ASSETS.fetch(new URL("/index.html", request.url));
    let html = await assetRes.text();

    const title = `${school.name} | Manabi Map`;
    const description = buildDescription(school);
    const pageUrl = `${new URL(request.url).origin}/school/${id}`;

    html = html.replace(/<title>[^<]*<\/title>/, `<title>${escapeAttr(title)}</title>`);
    html = setMeta(html, "name", "description", description);
    html = setMeta(html, "property", "og:title", title);
    html = setMeta(html, "property", "og:description", description);
    html = setMeta(html, "property", "og:url", pageUrl);
    html = setMeta(html, "property", "og:image:alt", title);
    html = setMeta(html, "name", "twitter:title", title);
    html = setMeta(html, "name", "twitter:description", description);
    html = setMeta(html, "name", "twitter:image:alt", title);

    return new Response(html, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        // クローラー向け。校名等の変更が 1 時間で反映されれば十分
        "cache-control": "public, max-age=3600",
      },
    });
  } catch {
    // Supabase 障害・タイムアウト等では共有カードが既定 OGP になるだけ（致命ではない）
    return next();
  }
};
