// 「その他」の引き出し（C7・子 plan「作業内容」3）。
// 学校サイトの web/src/components/Sidebar.tsx と同じ .sb-backdrop・.sidebar の枠を見本にしたが、
// コードは共有しない（子 plan「このファイルを開いた AI へ」）。Sidebar と同じく常にマウントし、
// open の真偽で .on を付け外しする（CSS の transform のアニメーションをそのまま使うため。
// LanguageSheet・ProfileSheet はマウント／アンマウントで開閉する LoginSheet 流だが、この引き出しは
// 横からスライドする Sidebar 流に合わせた。開閉の方式は子 plan の作業内容に指定が無い軽い迷いなので、
// 同じ見た目の既存コード〔Sidebar〕に倣った）。
//
// 項目は 5 つ（子 plan「作業内容」3）: 学習者の設定・学習者を切り替える・ことば・このアプリに
// ついて・学校選びの Manabi Map（外部リンク）。アイコンの絵文字は Sidebar.tsx の sb-item に倣った
// 見た目合わせで、キーの意味に近いものを選んだ（子 plan に指定が無い軽い迷い）。
//
// __APP_VERSION__ は web/src/globals.d.ts の ambient 宣言をそのまま使う。実体は Vite の
// gitVersion プラグインの define でしか入らず、vitest には無いので、これを描くテスト
// （components/sheets.test.ts）は vi.stubGlobal で埋める。
//
// フォーカスの扱い（開いたら中へ・Tab を閉じ込める・閉じたら戻す）は lib/useFocusTrap.ts に
// 出した（C7 レビュー must 2。学校サイトの useFocusTrap を見本にしたが、コードは共有しない）。
// 閉じている間は inert を付け、キーボードで中の項目に入れないようにする（C7 レビュー must 1。
// .sidebar は transform で画面外へ動かすだけで DOM からは消えないため、inert が無いと
// aria-hidden だけでは Tab キーで中の sb-item へ入れてしまう）。

import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { APP_CONFIG } from '../config/app'
import { useI18n } from '../i18n/I18nProvider'
import { useFocusTrap } from '../lib/useFocusTrap'
import { ROUTES } from '../routing'
import { useCurrentProfile } from '../state/ProfileProvider'

export interface MoreDrawerProps {
  open: boolean
  onClose: () => void
  onOpenLang: () => void
  onOpenProfile: () => void
}

export function MoreDrawer({ open, onClose, onOpenLang, onOpenProfile }: MoreDrawerProps) {
  const { t, text } = useI18n()
  const currentProfile = useCurrentProfile()
  const navigate = useNavigate()
  const asideRef = useRef<HTMLElement>(null)

  useFocusTrap(asideRef, open)

  // Esc で閉じる（開いているときだけ購読する）。学校サイトの useEscapeKey と同じ考え方だが、
  // 漢字アプリのコードから学校サイトのフックを import しないので同じだけの短い実装を持つ。
  useEffect(() => {
    if (!open) return
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, onClose])

  function go(path: string) {
    onClose()
    navigate(path)
  }

  return (
    <>
      <button
        type="button"
        className={open ? 'sb-backdrop on' : 'sb-backdrop'}
        onClick={onClose}
        aria-label={text('common.close')}
        tabIndex={open ? 0 : -1}
        aria-hidden={!open}
      />
      <aside
        ref={asideRef}
        className={open ? 'sidebar on' : 'sidebar'}
        aria-hidden={!open}
        inert={!open}
        role="dialog"
        aria-modal="true"
        aria-label={text('more.title')}
      >
        <div className="sb-head">
          <button type="button" className="icon-btn" onClick={onClose} aria-label={text('common.close')}>
            ×
          </button>
          <div className="brand">{t('brand')}</div>
        </div>
        <div className="sb-body">
          <div className="sb-section">
            {currentProfile && (
              <button type="button" className="sb-item" onClick={() => go(ROUTES.profileEdit(currentProfile.id))}>
                <span className="ic" aria-hidden="true">
                  👤
                </span>
                <span className="tx">{t('more.learner')}</span>
                <span className="arrow" aria-hidden="true">
                  ›
                </span>
              </button>
            )}
            <button type="button" className="sb-item" onClick={onOpenProfile}>
              <span className="ic" aria-hidden="true">
                👥
              </span>
              <span className="tx">{t('profiles.switch')}</span>
              <span className="arrow" aria-hidden="true">
                ›
              </span>
            </button>
            <button type="button" className="sb-item" onClick={onOpenLang}>
              <span className="ic" aria-hidden="true">
                🌐
              </span>
              <span className="tx">{t('lang.title')}</span>
              <span className="arrow" aria-hidden="true">
                ›
              </span>
            </button>
            <button type="button" className="sb-item" onClick={() => go(ROUTES.about)}>
              <span className="ic" aria-hidden="true">
                ℹ️
              </span>
              <span className="tx">{t('more.about')}</span>
              <span className="arrow" aria-hidden="true">
                ›
              </span>
            </button>
            <a className="sb-item" href={APP_CONFIG.schoolUrl} target="_blank" rel="noopener" onClick={onClose}>
              <span className="ic" aria-hidden="true">
                🔗
              </span>
              <span className="tx">{t('wel.school')}</span>
              <span className="arrow" aria-hidden="true">
                ›
              </span>
            </a>
          </div>
          {/* 2026-09-24 C9 レビュー should 5: .sb-footer は学校サイトの Sidebar.tsx と同じく
              .sb-body（スクロールする所）の中の末尾に置く。以前は .sb-body の外（.sidebar の
              直下）に置いていたため、背の低い画面で項目の一覧が .sb-footer に押しつぶされて
              隠れる恐れがあった。.sb-body の中なら、項目が増えても footer ごとスクロールできる。
              左右の余白は .sb-body の padding（12px 14px 24px。index.css）をそのまま使えるように
              なったので、kanji.css に足していた .sb-footer の左右の余白の上書きは外した。
              safe-area の下余白（iPhone のホームバー分）は、.sb-footer から .sb-body へ移した
              （スクロールの最後、.sb-body の下端で効くようにするため）。 */}
          {/* must 4: 親 plan D-1「はじめての画面と『その他』に、次の注記を常に出す」への対応。
              これまで About 画面にしか出していなかった。C9 で注記を 2 つ（notice.unofficial・
              notice.localOnly）続けて出すようにした（子 plan「作業内容」2）。 */}
          <div className="sb-footer">
            <div>{t('more.version', { v: __APP_VERSION__ })}</div>
            <div>{t('notice.unofficial')}</div>
            <div>{t('notice.localOnly')}</div>
          </div>
        </div>
      </aside>
    </>
  )
}
