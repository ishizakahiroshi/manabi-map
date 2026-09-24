// ルート・ヘッダー・下のタブ・帯の共通の枠（C6・子 plan「作業内容」2）。
// react-router のレイアウトルート（KanjiApp.tsx の <Route element={<KanjiLayout .../>}>）として使い、
// ページごとの中身は <Outlet /> に差し込まれる。ヘッダーの内容（variant・画面名）・下のタブを出すか
// は、どの画面がいま開いているか（location.pathname）を routing.ts の ROUTE_TABLE に照らして決める
// （KanjiApp.tsx の <Routes> と同じ表を見る。C6 レビュー should 2）。学校サイトの
// web/src/components/BottomTabBar.tsx・web/src/App.tsx 99〜147 行目・web/src/index.css の該当クラス・
// web/src/hooks/useGoBack.ts を見た目・戻るの判定の見本にしたが、コードは共有しない
// （子 plan「このファイルを開いた AI へ」）。

import { useState } from 'react'
import { Outlet, useLocation, useNavigate } from 'react-router-dom'
import { useI18n } from '../i18n/I18nProvider'
import { levelParts } from '../lib/levels'
import { getHistoryIndex, reloadApp } from '../platform/browser'
import { findRouteEntry, normalizePath, ROUTES, shouldReplaceBack, TAB_ENTRIES, type HeaderVariant } from '../routing'
import { useCurrentProfile, useProfiles } from '../state/ProfileProvider'
import type { LearnerProfile } from '../types'
import { LanguageSheet } from './LanguageSheet'
import { MoreDrawer } from './MoreDrawer'
import { ProfileSheet } from './ProfileSheet'

/**
 * 見本の const MARK（ブランドの印）を React の要素にしたもの（子 plan「作業内容」2）。
 * ブランド資産の色そのもの（house tokens の値と同じ #ff7a3d・#241f1a・#f7f3ea）を固定で使う。
 * 学校サイトが /brand-mark.svg という静的ファイルを使うのと同じ扱いで、テーマで変わる UI 色では
 * ないため、house tokens（var(--accent) 等）には差し替えない（must 4 は kanji.css の話で、この
 * ブランド資産そのものの色は対象外）。
 */
export function BrandMark() {
  return (
    <svg className="brand-icon" viewBox="96 66 320 384" aria-hidden="true">
      <path
        d="M256 72c-84 0-152 66-152 148 0 108 152 220 152 220s152-112 152-220c0-82-68-148-152-148z"
        fill="#ff7a3d"
        stroke="#241f1a"
        strokeWidth="12"
        strokeLinejoin="round"
      />
      <rect x="170" y="130" width="172" height="172" rx="20" fill="#f7f3ea" stroke="#241f1a" strokeWidth="11" />
      <path d="M256 142v148M182 216h148" stroke="#241f1a" strokeWidth="6" strokeDasharray="14 12" opacity=".3" />
      <text
        x="256"
        y="262"
        textAnchor="middle"
        fontSize="124"
        fontWeight="800"
        fill="#241f1a"
        fontFamily="system-ui,'Hiragino Sans','Yu Gothic UI',sans-serif"
      >
        漢
      </text>
    </svg>
  )
}

/**
 * 学習者のボタン（色の丸にニックネームの 1 文字目・ニックネーム・級の名前・▾。子 plan「作業内容」2）。
 * aria-label に見えている文字（ニックネームと級）を含める（should 6）。ニックネーム・級・▾ は
 * 1 つの <span className="hd-prof-label"> にまとめる（.hd-prof が inline-flex + gap なので、
 * まとめないと「10」と「級」が別々の flex アイテムになってすき間が空く。must 1 と同じ理由）。
 * 級の表記は level.nameEq / level.namePreEq（「○級相当」）を使う（指示書 §2 を C6 の決めより
 * 優先する。2026-09-24 C9 レビュー must 2）。className は、級の表記が長くなったぶんを
 * kanji.css の .hd-prof-label で省略記号（…）に倒すための目印（同レビュー must 2 の付帯対応）。
 */
function ProfileChip({ profile, onClick }: { profile: LearnerProfile; onClick: () => void }) {
  const { t, text } = useI18n()
  const parts = levelParts(profile.level)
  const initial = Array.from(profile.nickname)[0] ?? ''
  const levelKey = parts.pre ? 'level.namePreEq' : 'level.nameEq'
  const levelText = text(levelKey, { n: parts.n })
  // 2 巡目レビュー should 3: 区切りに全角の「：」「・」を直書きしていたのを、どの言語でも自然な
  // 半角スペース区切りにする。
  const ariaLabel = `${text('profiles.switch')} ${profile.nickname} ${levelText}`
  return (
    <button type="button" className="hd-prof" aria-label={ariaLabel} onClick={onClick}>
      <span className="avatar sm" style={{ background: profile.color }}>
        {initial}
      </span>
      <span className="hd-prof-label">
        {profile.nickname}・{t(levelKey, { n: parts.n })} ▾
      </span>
    </button>
  )
}

export interface PageHeaderProps {
  variant: HeaderVariant
  /** tab・back で使う画面名のキー。brand では使わない（brand キー固定） */
  titleKey?: string
  onOpenLang: () => void
  onOpenProfile: () => void
}

/**
 * ヘッダー（子 plan「作業内容」2）。
 * brand: ブランドの印・ブランド名・右にことばのボタンと学習者のボタン。
 * tab: .header.compact に画面名と学習者のボタン。
 * back: 戻るボタン・画面名。戻る先は shouldReplaceBack の判定に従う（must 3）。
 */
export function PageHeader({ variant, titleKey, onOpenLang, onOpenProfile }: PageHeaderProps) {
  const { t, text } = useI18n()
  const navigate = useNavigate()
  const currentProfile = useCurrentProfile()

  if (variant === 'back') {
    const handleBack = () => {
      // must 3: 学校サイトの useGoBack と同じ判定（history.state.idx が 0 または無ければ、
      // 戻る先が無い最初のエントリとみなして / へ置き換え遷移する。それ以外は 1 つ戻る）。
      const idx = getHistoryIndex()
      if (shouldReplaceBack(idx)) navigate(ROUTES.home, { replace: true })
      else navigate(-1)
    }
    return (
      <div className="header">
        <button type="button" className="icon-btn" aria-label={text('common.back')} onClick={handleBack}>
          ←
        </button>
        <div className="brand">{titleKey ? t(titleKey) : null}</div>
      </div>
    )
  }

  const compact = variant === 'tab'
  return (
    <div className={compact ? 'header compact' : 'header'}>
      {!compact && <BrandMark />}
      <div className="brand">{compact && titleKey ? t(titleKey) : t('brand')}</div>
      <div className="hd-right">
        {!compact && (
          <button type="button" className="hd-lang" aria-label={text('lang.button')} onClick={onOpenLang}>
            🌐
          </button>
        )}
        {currentProfile && <ProfileChip profile={currentProfile} onClick={onOpenProfile} />}
      </div>
    </div>
  )
}

/**
 * 下のタブ（5 つ）。tab を持つ行（/ /practice /map /stats）のときだけ Layout が出す
 * （子 plan「作業内容」2）。ボタンの並びは routing.ts の TAB_ENTRIES（ROUTE_TABLE から tab を
 * 持つ行だけを取り出したもの）から作る（2 巡目レビュー should 4: タブの定義をこのファイルに
 * 直書きせず、ルートの表 1 つに一元化する）。
 */
function BottomTabs({ pathname, onOpenMore }: { pathname: string; onOpenMore: () => void }) {
  const { t, text } = useI18n()
  const navigate = useNavigate()

  return (
    <nav className="bottom-tabs" aria-label={text('nav.label')}>
      {TAB_ENTRIES.map((entry) => {
        const on = pathname === entry.path
        return (
          <button
            key={entry.path}
            type="button"
            className={on ? 'bottom-tab on' : 'bottom-tab'}
            aria-current={on ? 'page' : undefined}
            onClick={() => navigate(entry.path)}
          >
            <span aria-hidden="true">{entry.tab.icon}</span>
            <b>{t(entry.tab.labelKey)}</b>
          </button>
        )
      })}
      <button type="button" className="bottom-tab" onClick={onOpenMore}>
        <span aria-hidden="true">☰</span>
        <b>{t('tab.more')}</b>
      </button>
    </nav>
  )
}

export function KanjiLayout({ closed }: { closed: boolean }) {
  const { t } = useI18n()
  const { volatile } = useProfiles()
  const currentProfile = useCurrentProfile()
  const location = useLocation()
  // 「その他」・ことばのボタン・学習者のボタンが開く中身（MoreDrawer・LanguageSheet・
  // ProfileSheet）は C7 で作った。ここでは、どれを開こうとしているかの状態だけを持つ
  // （子 plan「作業内容」2。C7 レビュー should 5: 「開く中身は C7 で作る」という未来形のまま
  // 残っていたコメントを、実装済みの現状に合わせて直した）。
  const [open, setOpen] = useState<'more' | 'lang' | 'profiles' | null>(null)

  // findRouteEntry は内部で normalizePath するが、BottomTabs の「どのタブが on か」の比較にも
  // 同じ正規化済みの値を使う（2026-09-24 ブラウザでの目視で発見: /practice/ で findRouteEntry は
  // 正しく tab 付きの行を返すのに、下のタブの pathname === entry.path が生の pathname 同士を
  // 比べていて末尾の / の分だけ一致せず、どのタブにも on が付かなかった）。
  const pathname = normalizePath(location.pathname)
  const entry = findRouteEntry(pathname)
  const isKid = currentProfile?.display === 'child'

  return (
    <div className="stage">
      <div className={isKid ? 'phone kid' : 'phone'} data-open-sheet={open ?? undefined}>
        <PageHeader
          variant={entry.variant}
          titleKey={entry.titleKey}
          onOpenLang={() => setOpen('lang')}
          onOpenProfile={() => setOpen('profiles')}
        />
        {volatile && (
          // must 1: .volatile-banner は display:flex なので、Markup の描画がそのまま子になると
          // 中の text/ruby のセグメントがそれぞれ別の flex アイテムになり、ふりがな付きの文言が
          // 横に飛び飛びになる。<span> でひとまとめにする。
          <p className="volatile-banner" role="status">
            <span>{t('volatile.banner')}</span>
          </p>
        )}
        {closed && (
          <div className="volatile-banner" role="alert">
            <span>{t('store.closed')}</span>
            <button type="button" className="link-btn" onClick={() => reloadApp()}>
              {t('store.reload')}
            </button>
          </div>
        )}
        <main className={entry.tab ? 'content' : 'content no-tabs'}>
          <div className="maxw">
            <Outlet />
          </div>
        </main>
        {entry.tab && <BottomTabs pathname={pathname} onOpenMore={() => setOpen('more')} />}
        {/* シート・引き出しの中身は C7 で作った（子 plan「作業内容」5）。開閉の状態はここだけが
            持つ（このファイル冒頭のコメントのまま）。MoreDrawer は Sidebar と同じく常にマウントし、
            LanguageSheet・ProfileSheet は LoginSheet と同じくマウント／アンマウントで開閉する
            （それぞれのファイル冒頭のコメントを参照）。 */}
        <MoreDrawer
          open={open === 'more'}
          onClose={() => setOpen(null)}
          onOpenLang={() => setOpen('lang')}
          onOpenProfile={() => setOpen('profiles')}
        />
        {open === 'lang' && <LanguageSheet onClose={() => setOpen(null)} noTabs={!entry.tab} />}
        {open === 'profiles' && <ProfileSheet onClose={() => setOpen(null)} noTabs={!entry.tab} />}
      </div>
    </div>
  )
}
