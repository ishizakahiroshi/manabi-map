// ルートの表（C6 レビュー should 2・should 9、および 2 巡目レビュー should 2・4）。
// パスの一覧・どの画面か（page）・ヘッダーの見せ方（variant・titleKey）・下のタブのボタン（tab）・
// 学習者が居ない／いまの学習者が居なくても開けるか（allowWithoutProfile・allowWithoutCurrent）を
// 1 つの表にまとめ、KanjiApp.tsx（<Routes> の組み立て・redirectFor）と
// components/KanjiLayout.tsx（ヘッダーの中身・下のタブのボタン）の全部がこの表だけを見るようにする
// （表が複数に分かれて食い違う事故を防ぐ。2 巡目レビュー should 4: タブのボタンの定義と
// redirectFor の許可の一覧が表の外にあったのを、表の列に統合した）。
// redirectFor（子 plan「作業内容」1）・戻るボタンの判定（子 plan「作業内容」2・must 3）・
// 言語の決定（2 巡目レビュー should 2）も、コンポーネントを持たない純粋な関数としてここに置く
// （react/only-export-components 対策。KanjiApp.tsx・KanjiLayout.tsx はコンポーネントだけを
// export する）。

import { matchPath } from 'react-router-dom'

export type HeaderVariant = 'brand' | 'tab' | 'back'
// C8・子 plan「作業内容」5: welcome・profiles・profileEdit を足した（それぞれ
// pages/WelcomePage.tsx・pages/ProfilesPage.tsx・pages/ProfileEditPage.tsx に対応。/profiles/new と
// /profiles/:id はどちらも profileEdit で、id の有無で追加・編集を分ける。KanjiApp.tsx の
// pageElementFor を参照）。
export type PageKind = 'home' | 'soon' | 'notFound' | 'about' | 'welcome' | 'profiles' | 'profileEdit'

export interface TabInfo {
  icon: string
  labelKey: string
}

export interface RouteEntry {
  /** react-router の path パターン（:id 等を含んでよい） */
  path: string
  variant: HeaderVariant
  /** tab・back で使う画面名のキー。brand では使わない（brand は t('brand') 固定） */
  titleKey?: string
  /**
   * 下のタブのボタンにするときの見た目（無ければ下のタブの対象外）。この値がある行だけが
   * 下のタブを出す対象で、BottomTabs（KanjiLayout.tsx）のボタンの並びもこの表から作る
   * （2 巡目レビュー should 4）。
   */
  tab?: TabInfo
  /** 学習者が 1 人も居なくても開ける画面か（redirectFor が使う） */
  allowWithoutProfile: boolean
  /** 学習者は居るが、いまの学習者を選んでいなくても開ける画面か（redirectFor が使う） */
  allowWithoutCurrent: boolean
  page: PageKind
}

/**
 * 遷移先の URL 文字列（C10 N3・子 plan「作業内容」3・指示書 §5）。ROUTE_TABLE の path と、
 * 画面・部品側の Link の to・navigate の引数はここの値を使い、パスの文字列が routing.ts の外へ
 * 散らばらないようにする。動的な部分（/profiles/:id）は関数にする。react-router の path
 * パターン文字列（:id を含む）は表に無いのでこの中には持たず、下の PROFILE_EDIT_PATTERN に分ける。
 * '*'（見つからないの画面）は遷移先として使わない値なのでここには含めない。
 */
export const ROUTES = {
  home: '/',
  practice: '/practice',
  map: '/map',
  stats: '/stats',
  welcome: '/welcome',
  profiles: '/profiles',
  profileNew: '/profiles/new',
  about: '/about',
  /** /profiles/:id（学習者の設定）への実際の遷移先 */
  profileEdit: (id: string) => `/profiles/${id}`,
} as const

/** ROUTE_TABLE の /profiles/:id 行に使う react-router のパスパターン（:id はそのまま残す） */
const PROFILE_EDIT_PATTERN = `${ROUTES.profiles}/:id`

/**
 * ルートの表。静的なパス（/profiles/new 等）を動的なパス（/profiles/:id）より前に置く
 * （findRouteEntry は最初に一致した 1 件を返す素朴なループなので、react-router の <Routes> と
 * 違って優先度を自動で判断しない。並び順で担保する）。* は必ず最後。
 *
 * must 2（2026-09-24 レビュー）: /profiles を back から brand に直した。いまの学習者がいない
 * ときに開く画面（学習者の一覧・切り替え）なので、ことばのボタンが要る。戻るボタンを付けると
 * redirectFor によってまた /profiles へ戻されるだけで意味が無い。
 * C7・C8 で実画面に差し替えるときも、この表の該当行の path はそのまま・page だけ増やす
 * （子 plan 更新: 「ヘッダーはページでは描かず、ルートの表に登録する」）。
 */
export const ROUTE_TABLE: RouteEntry[] = [
  {
    path: ROUTES.home,
    variant: 'brand',
    tab: { icon: '🏠', labelKey: 'tab.home' },
    allowWithoutProfile: false,
    allowWithoutCurrent: false,
    page: 'home',
  },
  {
    path: ROUTES.practice,
    variant: 'tab',
    titleKey: 'tab.practice',
    tab: { icon: '✏️', labelKey: 'tab.practice' },
    allowWithoutProfile: false,
    allowWithoutCurrent: false,
    page: 'soon',
  },
  {
    path: ROUTES.map,
    variant: 'tab',
    titleKey: 'tab.map',
    tab: { icon: '🗺', labelKey: 'tab.map' },
    allowWithoutProfile: false,
    allowWithoutCurrent: false,
    page: 'soon',
  },
  {
    path: ROUTES.stats,
    variant: 'tab',
    titleKey: 'tab.stats',
    tab: { icon: '📊', labelKey: 'tab.stats' },
    allowWithoutProfile: false,
    allowWithoutCurrent: false,
    page: 'soon',
  },
  { path: ROUTES.welcome, variant: 'brand', allowWithoutProfile: true, allowWithoutCurrent: false, page: 'welcome' },
  { path: ROUTES.profiles, variant: 'brand', allowWithoutProfile: false, allowWithoutCurrent: true, page: 'profiles' },
  {
    path: ROUTES.profileNew,
    variant: 'back',
    titleKey: 'edit.titleNew',
    allowWithoutProfile: true,
    allowWithoutCurrent: true,
    page: 'profileEdit',
  },
  {
    // C7・子 plan「作業内容」5: AboutPage（pages/AboutPage.tsx）に差し替えた。
    // path・variant・titleKey は C6 のまま（ヘッダーは引き続きこの表から Layout が描く）。
    path: ROUTES.about,
    variant: 'back',
    titleKey: 'about.title',
    allowWithoutProfile: true,
    allowWithoutCurrent: true,
    page: 'about',
  },
  {
    path: PROFILE_EDIT_PATTERN,
    variant: 'back',
    titleKey: 'edit.titleEdit',
    allowWithoutProfile: false,
    allowWithoutCurrent: false,
    page: 'profileEdit',
  },
  {
    path: '*',
    variant: 'back',
    titleKey: 'notfound.title',
    allowWithoutProfile: false,
    allowWithoutCurrent: false,
    page: 'notFound',
  },
]

const NOT_FOUND_ENTRY = ROUTE_TABLE[ROUTE_TABLE.length - 1]!

/** 下のタブに出す行だけを、表の並び順のまま取り出したもの（2 巡目レビュー should 4） */
export const TAB_ENTRIES: (RouteEntry & { tab: TabInfo })[] = ROUTE_TABLE.filter(
  (entry): entry is RouteEntry & { tab: TabInfo } => entry.tab !== undefined,
)

/**
 * 比べる前に、末尾の / をそろえ（/practice/ でもタブと準備中の画面が出るように。should 2）、
 * 小文字にそろえる（/PRACTICE でも一致するように。2 巡目レビュー should 4）。
 * ルートそのもの（'/'）は削らない。
 */
export function normalizePath(pathname: string): string {
  const lower = pathname.toLowerCase()
  if (lower.length > 1 && lower.endsWith('/')) return lower.slice(0, -1)
  return lower
}

/**
 * pathname に一致するルートの表の行を返す。表に無い（どれにも一致しない）ときは '*' の行
 * （見つからないの画面）を返す（should 2）。
 */
export function findRouteEntry(pathname: string): RouteEntry {
  const normalized = normalizePath(pathname)
  for (const entry of ROUTE_TABLE) {
    if (entry.path === '*') continue
    if (matchPath({ path: entry.path, end: true }, normalized)) return entry
  }
  return NOT_FOUND_ENTRY
}

/**
 * いまの画面（path）が、学習者の有無・いまの学習者の有無に対して許された画面かを判断し、許されて
 * いなければ移動先を返す（許されていれば null）。<Navigate replace> で使う（子 plan「作業内容」1）。
 * 許可は決め打ちの一覧ではなく、findRouteEntry で引いたルートの表の行の
 * allowWithoutProfile・allowWithoutCurrent から判断する（2 巡目レビュー should 4: 許可の一覧が
 * 表の外にあると、表を直しても redirectFor が食い違ったままになりうるため統合した）。
 * 学習者がいない: その画面の allowWithoutProfile が true でなければ /welcome へ。
 * 学習者はいるが、いまの学習者がいない: allowWithoutCurrent が true でなければ /profiles へ。
 * いまの学習者がいる: /welcome は / へ。ほかは移動しない。
 */
export function redirectFor(path: string, hasProfiles: boolean, hasCurrent: boolean): string | null {
  const normalized = normalizePath(path)
  const entry = findRouteEntry(normalized)
  if (!hasProfiles) return entry.allowWithoutProfile ? null : ROUTES.welcome
  if (!hasCurrent) return entry.allowWithoutCurrent ? null : ROUTES.profiles
  if (normalized === ROUTES.welcome) return ROUTES.home
  return null
}

/**
 * 戻るボタンの判定（must 3）。学校サイトの web/src/hooks/useGoBack.ts と同じ考え方
 * （読むだけで import はしない。子 plan「このファイルを開いた AI へ」）。
 * history.state.idx が 0（最初のエントリ）または無ければ、戻る先が無いとみなして true
 * （呼ぶ側は navigate('/', { replace: true }) する）。それ以外は false（navigate(-1)）。
 */
export function shouldReplaceBack(idx: number | null | undefined): boolean {
  return idx === undefined || idx === null || idx === 0
}

/**
 * 言語の決定を 1 か所にまとめる（2 巡目レビュー should 2）。candidate（学習者の lang・保存されて
 * いる uiLang）が実在するパック（available）のどれかであればそれを使い、無ければ fallback を使う。
 * candidate は string 以外（undefined・壊れたデータ等）でもよい（呼び出し側が確かめずに渡せる
 * ように）。main.tsx（起動時に読む言語・学習者がいないときの画面の言語）と KanjiApp.tsx の
 * KanjiAppShell（I18nProvider に渡す言語）の両方がこの関数を使う。以前は main.tsx にだけこの
 * 確認があり、画面側は currentProfile?.lang をそのまま使っていたため、パックに無い lang を持つ
 * 学習者では、起動時に読み込んだ言語ではなく英語へ落ちる・key がそのまま出るといったズレが
 * 起きていた。
 */
export function resolveLang(candidate: unknown, fallback: string, available: readonly string[]): string {
  return typeof candidate === 'string' && available.includes(candidate) ? candidate : fallback
}
