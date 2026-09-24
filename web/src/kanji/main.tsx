import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import '../index.css'
import './kanji.css'
import { KanjiApp } from './KanjiApp'
import { detectLang, LANGUAGES, loadUi as loadPackUi, type UiDict } from './i18n/packs'
import { applyAllFonts } from './lib/applyFonts'
import { openKanjiStore } from './lib/store'
import { getPreferredLanguages } from './platform/browser'
import { resolveLang } from './routing'
import { pickInitialCurrent } from './state/profileState'

// 漢字アプリの起動処理（C6: main.tsx を最小の描画から置き換える。子 plan「作業内容」4、
// および C6 レビュー should 1・5 の直し）。学校サイトの main.tsx（SSR のプリレンダーを hydrate
// する分岐を持つ）は使わない。漢字アプリはサーバーを持たないので createRoot だけで描く。
// top-level await は使わず、async 関数（start）を呼ぶ形にする。

const FALLBACK_MESSAGE =
  '読み込めませんでした。ページを開き直してください。 / Failed to load. Please reload the page.'

/**
 * パックが無い・読み込みに失敗した言語は必ず {} を返す（C4「作業内容」3 の約束。呼んだ側が
 * uiByLang[code] = {} を入れる）。この関数を KanjiApp の loadUi にもそのまま渡す。
 */
async function loadLang(code: string): Promise<UiDict> {
  try {
    return (await loadPackUi(code)) ?? {}
  } catch {
    return {}
  }
}

async function start(container: HTMLElement): Promise<void> {
  // 描画の前にフォントを適用する（should 1）。いまの ja・en はどちらも font: null なので、
  // 現時点では何もしない（後の C で font を持つ言語パックが増えたときに効く）。
  applyAllFonts()

  const store = await openKanjiStore()
  const [profiles, lastProfileId, uiLangMeta] = await Promise.all([
    store.listProfiles(),
    store.getMeta('lastProfileId'),
    store.getMeta('uiLang'),
  ])

  const initialCurrentId = pickInitialCurrent(profiles, lastProfileId)
  const currentProfile = profiles.find((p) => p.id === initialCurrentId) ?? null

  // 言語を決める: いまの学習者の lang → uiLang（端末に残っている画面の言語）→
  // detectLang（端末の言語から選ぶ）。resolveLang（routing.ts）が「実在するパックか」を確かめて
  // から使う判定を担う。KanjiApp.tsx の KanjiAppShell も同じ resolveLang を使うので、学習者の lang
  // がまだパックに無い言語でも、ここで読み込んだ言語（fallbackLang）と画面側の判定がずれない
  // （2 巡目レビュー should 2）。学習者がいないときの画面の言語（initialUiLang）は
  // 「uiLang → detectLang」の結果（fallbackLang）をそのまま使う。
  const available = LANGUAGES.map((meta) => meta.code)
  const fallbackLang = resolveLang(uiLangMeta, detectLang(getPreferredLanguages(), available), available)
  const lang = resolveLang(currentProfile?.lang, fallbackLang, available)

  // その言語と英語の ui を同時に読み込む（失敗した言語は {} を入れる。C4 の約束。should 5c:
  // 直列の await 2 回ではなく Promise.all で並行に読む）。
  const [langUi, enUi] = await Promise.all([loadLang(lang), lang === 'en' ? Promise.resolve(undefined) : loadLang('en')])
  const uiByLang: Record<string, UiDict | undefined> = { [lang]: langUi }
  if (lang !== 'en') uiByLang.en = enUi

  createRoot(container, {
    // should 5a: 初回描画の後に起きた、どのコンポーネントも捕まえていない例外（Error Boundary を
    // 置いていないため）でも、案内文を出す。start() の catch は初回描画までの失敗だけを拾うため、
    // これで描画後の失敗もカバーする。2 巡目レビュー should 1: 案内文だけ出すと例外の中身がどこにも
    // 残らないので、console.error で先に残してから案内文を出す。
    onUncaughtError: (error) => {
      console.error(error)
      container.textContent = FALLBACK_MESSAGE
    },
  }).render(
    <StrictMode>
      <BrowserRouter>
        <KanjiApp
          store={store}
          initialProfiles={profiles}
          initialCurrentId={initialCurrentId}
          initialUiLang={fallbackLang}
          uiByLang={uiByLang}
          loadUi={loadLang}
        />
      </BrowserRouter>
    </StrictMode>,
  )
}

const container = document.getElementById('root')
if (container) {
  start(container).catch((error: unknown) => {
    // 起動そのものが失敗した（IndexedDB もメモリ保存も作れない・言語パックの形が壊れている等）
    // ときは、日本語と英語で開き直しを促す。textContent で入れる（dangerouslySetInnerHTML は使わない）。
    // 2 巡目レビュー should 1: onUncaughtError と同じく、案内文の前に console.error で例外を残す。
    console.error(error)
    container.textContent = FALLBACK_MESSAGE
  })
}
