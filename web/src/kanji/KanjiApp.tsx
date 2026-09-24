// 画面の骨組み（C6・子 plan「作業内容」1）。
// ProfileProvider（C5）→ I18nProvider（C4）→ FuriganaProvider（C3）→ ルート、の順に包む。
// ルートは routing.ts の ROUTE_TABLE（KanjiApp.tsx と components/KanjiLayout.tsx が同じ表を見る。
// C6 レビュー should 2・9）から組み立て、KanjiLayout を共通の枠（.stage/.phone・ヘッダー・帯・
// 下のタブ）として使う（react-router のレイアウトルート・Outlet）。問題・漢字データ・学習の画面は
// まだ無いので、/practice・/map・/stats は「準備中」の同じ中身のまま。/about は C7 で AboutPage
// （pages/AboutPage.tsx）、/welcome・/profiles・/profiles/new・/profiles/:id は C8 で
// WelcomePage・ProfilesPage・ProfileEditPage（pages/）に差し替えた（子 plan「作業内容」5）。
//
// このファイルは KanjiApp（コンポーネント）だけを export する（react/only-export-components 対策。
// C6 レビュー should 9）。redirectFor・ルートの表・ヘッダーの判定は routing.ts、フォントの適用は
// lib/applyFonts.ts、言語の遅延読み込みの失敗対策は lib/langLoading.ts に分けてある。

import { useCallback, useEffect, useState } from 'react'
import { Link, Navigate, Route, Routes, useLocation } from 'react-router-dom'
import { KanjiLayout } from './components/KanjiLayout'
import { FuriganaProvider } from './i18n/MarkupView'
import type { FuriganaSetting } from './i18n/markup'
import { I18nProvider, useI18n } from './i18n/I18nProvider'
import { LANGUAGES, type UiDict } from './i18n/packs'
import { loadUiSafely, mergeUiByLang } from './lib/langLoading'
import type { KanjiStore } from './lib/store'
import { AboutPage } from './pages/AboutPage'
import { ProfileEditPage } from './pages/ProfileEditPage'
import { ProfilesPage } from './pages/ProfilesPage'
import { WelcomePage } from './pages/WelcomePage'
import { ROUTE_TABLE, ROUTES, redirectFor, resolveLang, type PageKind } from './routing'
import { ProfileProvider, useCurrentProfile, useProfiles } from './state/ProfileProvider'
import type { LearnerProfile } from './types'

export interface KanjiAppProps {
  store: KanjiStore
  /** 起動処理（main.tsx）が KanjiStore.listProfiles() で読んだ初期値 */
  initialProfiles: LearnerProfile[]
  /** 起動処理が pickInitialCurrent（state/profileState.ts）で決めた初期値 */
  initialCurrentId: string | null
  initialUiLang: string
  /** 起動処理があらかじめ読み込んだ言語（いまの言語と英語）。読み込みに失敗した言語は {} が入っている */
  uiByLang: Record<string, UiDict | undefined>
  /**
   * 言語を読み込む関数。失敗した・パックが無い場合も必ず UiDict を返す（{} で表す。C4「作業内容」3
   * の約束を main.tsx 側の loadLang が引き受けている）。それでも reject する呼び出し側が来ても
   * 画面が壊れないよう、ここでは loadUiSafely 経由でしか呼ばない（C6 レビュー should 4）。
   */
  loadUi: (code: string) => Promise<UiDict>
}

/**
 * 学習者がまだいない・級が決まっていないときの既定のふりがな設定（MarkupView.tsx の
 * DEFAULT_FURIGANA_SETTING と同じ考え方）。漢字ごとの級のデータができるまで levelOf は
 * 常に undefined を返す（親 plan C3。子 plan「作業内容」2 のコメント指示）。
 */
const DEFAULT_FURIGANA: FuriganaSetting = { mode: 'all', level: '10', levelOf: () => undefined }

/**
 * 接続が閉じられた（版を上げる別タブが開いた等）かどうかを、なるべく早く（KanjiApp が描かれた
 * 直後から）購読する。redirectFor によるページ切り替えで KanjiLayout が一度アンマウントされても
 * （例: いまの学習者が居なくなって /welcome へ移る等）帯の状態が消えないよう、KanjiLayout より
 * 上の・常にマウントされている段でこの状態を持つ（C6 レビュー should 3）。
 */
function useStoreClosed(store: KanjiStore): boolean {
  const [closed, setClosed] = useState(false)
  useEffect(() => store.onClose(() => setClosed(true)), [store])
  return closed
}

export function KanjiApp({ store, initialProfiles, initialCurrentId, initialUiLang, uiByLang, loadUi }: KanjiAppProps) {
  const closed = useStoreClosed(store)
  return (
    <ProfileProvider
      store={store}
      initialProfiles={initialProfiles}
      initialCurrentId={initialCurrentId}
      initialUiLang={initialUiLang}
    >
      <KanjiAppShell uiByLang={uiByLang} loadUi={loadUi} closed={closed} store={store} />
    </ProfileProvider>
  )
}

function KanjiAppShell({
  uiByLang: initialUiByLang,
  loadUi,
  closed,
  store,
}: {
  uiByLang: Record<string, UiDict | undefined>
  loadUi: (code: string) => Promise<UiDict>
  closed: boolean
  store: KanjiStore
}) {
  // 読み込み済みの言語。I18nProvider の onNeedLang で新しい言語が要ると分かったら足す
  // （子 plan「作業内容」1・C4「作業内容」4）。
  const [uiByLang, setUiByLang] = useState(initialUiByLang)
  const { uiLang } = useProfiles()
  const currentProfile = useCurrentProfile()

  const handleNeedLang = useCallback(
    (code: string) => {
      loadUiSafely(loadUi, code).then((ui) => {
        setUiByLang((prev) => mergeUiByLang(prev, code, ui))
      })
    },
    [loadUi],
  )

  // 言語は、いまの学習者の lang、いなければ画面の言語（uiLang）。学習者の lang がまだパックに
  // 無い言語（今後の 12 言語ぶん等）なら uiLang（起動時に main.tsx が同じ resolveLang で決めた、
  // 実在するパックの言語）まで戻す。main.tsx の fallbackLang の判定と同じ関数を使うことで、画面が
  // 一瞬でも「パックに無い言語」のまま描かれてキーそのものや英語へ意図せず落ちるのを防ぐ
  // （2 巡目レビュー should 2）。
  const available = LANGUAGES.map((meta) => meta.code)
  const lang = resolveLang(currentProfile?.lang, uiLang, available)
  const display = currentProfile?.display ?? 'child'
  const furiganaSetting: FuriganaSetting = currentProfile
    ? { mode: currentProfile.furigana, level: currentProfile.level, levelOf: DEFAULT_FURIGANA.levelOf }
    : DEFAULT_FURIGANA

  return (
    <I18nProvider lang={lang} display={display} uiByLang={uiByLang} onNeedLang={handleNeedLang}>
      <FuriganaProvider value={furiganaSetting}>
        <KanjiRoutes closed={closed} store={store} />
      </FuriganaProvider>
    </I18nProvider>
  )
}

function KanjiRoutes({ closed, store }: { closed: boolean; store: KanjiStore }) {
  const location = useLocation()
  const { profiles, currentId } = useProfiles()
  const target = redirectFor(location.pathname, profiles.length > 0, currentId !== null)

  if (target) {
    return <Navigate to={target} replace />
  }

  return (
    <Routes>
      <Route element={<KanjiLayout closed={closed} />}>
        {ROUTE_TABLE.map((entry) => (
          <Route key={entry.path} path={entry.path} element={pageElementFor(entry.page, store)} />
        ))}
      </Route>
    </Routes>
  )
}

/**
 * C8・子 plan「作業内容」5: welcome・profiles・profileEdit を実画面に差し替えた。
 * ProfileEditPage だけ store を必要とする（保存後の requestPersistence。子 plan「作業内容」4）ので
 * ここで渡す。KanjiApp.tsx が受け取った store をそのまま下ろすだけで、state/ProfileProvider.tsx
 * （C5）には手を入れない（子 plan「守ること」）。
 */
function pageElementFor(kind: PageKind, store: KanjiStore) {
  switch (kind) {
    case 'home':
      return <HomePage />
    case 'about':
      return <AboutPage />
    case 'notFound':
      return <NotFoundPage />
    case 'soon':
      return <SoonPage />
    case 'welcome':
      return <WelcomePage />
    case 'profiles':
      return <ProfilesPage />
    case 'profileEdit':
      return <ProfileEditPage store={store} />
  }
}

/** ホームの仮の中身。「{name}さん、こんにちは」と準備中の文（子 plan「作業内容」1） */
function HomePage() {
  const { t } = useI18n()
  const profile = useCurrentProfile()
  return (
    <div className="box center">
      <h1>{t('home.hello', { name: profile?.nickname ?? '' })}</h1>
      <p className="muted">{t('soon.body')}</p>
    </div>
  )
}

/** 中身がまだ無い画面の共通の見た目 */
function SoonPage() {
  const { t } = useI18n()
  return (
    <div className="box center">
      <h1>{t('common.soon')}</h1>
      <p className="muted">{t('soon.body')}</p>
    </div>
  )
}

function NotFoundPage() {
  const { t } = useI18n()
  return (
    <div className="box center">
      <h1>{t('notfound.title')}</h1>
      <p>
        <Link className="link-btn" to={ROUTES.home}>
          {t('notfound.home')}
        </Link>
      </p>
    </div>
  )
}
