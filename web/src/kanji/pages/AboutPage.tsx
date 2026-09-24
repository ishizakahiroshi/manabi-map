// 「このアプリについて」の画面（C7・子 plan「作業内容」4）。
// ヘッダーの .brand も同じ about.title を描くが（KanjiLayout.tsx の 'back' variant。C6 で決めた
// 「ヘッダーは 1 か所だけで描く」仕組み）、それは <div> で見出しの要素ではないため、本文側にも
// 見出し文書構造として <h1> を置く（C7 レビュー should 4）。
//
// 並び順は子 plan「作業内容」4 の文の順（本文 → 注記 → 使っているデータ → 版）のとおりにする
// （C7 レビュー should 4: 当初 about.body → about.credits → about.creditsSoon → more.version →
// notice.unofficial の順にしていたのを直した）。C9 でブランド行（about-brand）を見出しの直後に
// 足し、注記を 2 つ（notice.unofficial・notice.localOnly）に増やしたが、この並び順（本文 → 注記
// → 使っているデータ → 版）自体は変えていない。
//
// __APP_VERSION__ は web/src/globals.d.ts の ambient 宣言（プロジェクト全体で有効）をそのまま使う。
// 実体は Vite の gitVersion プラグインの define でしか入らず、vitest には無いので、この値を描く
// テスト（components/sheets.test.ts）は vi.stubGlobal で埋める（MoreDrawer.tsx と同じ理由）。
//
// 見出し・段落の大きさとすき間（C7 再レビュー should 2）: Tailwind の preflight が h1・h2・p の
// margin を 0 にし、見出しの font-size・font-weight も本文へ継承させてしまうため、このままでは
// 見出しと本文が同じ見た目になり、段落の間も詰まる。about-title・about-subtitle・about-body を
// kanji.css に足して、見出しの大きさ・太さと段落の下余白を house tokens（var(--ink) 等）で付けた。
// .notice はすでに独自の margin を持つので、このクラスは付けない。
//
// C9 指示書 §11「主要な初回接点では併記する」: 見出し（about.title 「このアプリについて」）は
// ブランド名そのものではないため、「見出し + brand.subtitle」の形が使えない。about-title の直後に
// brand.withSubtitle（「たねもじ — 漢字学習」）を 1 行添える（子 plan「作業内容」1）。

import { useI18n } from '../i18n/I18nProvider'

export function AboutPage() {
  const { t } = useI18n()
  return (
    <>
      <h1 className="about-title">{t('about.title')}</h1>
      <p className="about-brand">{t('brand.withSubtitle')}</p>
      <p className="about-body">{t('about.body')}</p>
      {/* 親 plan D-1: はじめての画面と「その他」に常に出す注記。ここは「その他」からたどり着く
          「このアプリについて」なので、この画面にも出す（子 plan「作業内容」4）。C9 で 2 つ
          （notice.unofficial・notice.localOnly）を続けて出すようにした（子 plan「作業内容」2）。 */}
      <p className="notice">{t('notice.unofficial')}</p>
      <p className="notice">{t('notice.localOnly')}</p>
      <h2 className="about-subtitle">{t('about.credits')}</h2>
      <p className="muted about-body">{t('about.creditsSoon')}</p>
      <p className="muted about-body">{t('more.version', { v: __APP_VERSION__ })}</p>
    </>
  )
}
