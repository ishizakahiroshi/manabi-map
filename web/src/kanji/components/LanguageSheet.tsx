// ことばを選ぶシート（C7・子 plan「作業内容」1）。
// props の onSelect があれば「選んだ言語コードを渡して閉じる」だけにする（C8 の学習者編集フォーム
// 用。フォームの値だけを変え、いまの学習者や画面全体の言語は変えない）。onSelect が無いとき
// （「その他」の引き出しから開いたとき）は C5 の setUiLang を呼ぶ（2026-09-23 C5 レビューの
// 申し送り）。選んだときの分岐そのものは languagePick.ts の pickLanguage（純粋な関数）に出した
// （C7 レビュー should 3）。
//
// 見た目は学校サイトの web/src/components/LoginSheet.tsx（.sheet .handle .head .body の枠）を
// 見本にしたが、コードは共有しない（子 plan「このファイルを開いた AI へ」）。LoginSheet には
// 無い「背景を押して閉じる」を子 plan の指示で足すため、専用の .sheet-backdrop を kanji.css に
// 足した（理由は kanji.css のコメントを参照）。Esc で閉じる処理も、学校サイトの
// useEscapeKey フックを import できないので同じだけの短い実装をここに持つ。フォーカスの扱い
// （開いたら中へ・Tab を閉じ込める・閉じたら戻す）は lib/useFocusTrap.ts に出した（C7 レビュー
// must 2。学校サイトの useFocusTrap を見本にしたが、コードは共有しない）。

import { useEffect, useRef } from 'react'
import { useI18n } from '../i18n/I18nProvider'
import { LANGUAGES } from '../i18n/packs'
import { useFocusTrap } from '../lib/useFocusTrap'
import { useProfiles } from '../state/ProfileProvider'
import { pickLanguage } from './languagePick'

export interface LanguageSheetProps {
  /** いまの言語として on を付ける言語コード。省略時は useI18n().lang（画面がいま使っている言語） */
  value?: string
  /**
   * 指定があれば、選んだ言語コードを渡して閉じるだけにする（C8 のフォーム用。いまの学習者の
   * 言語は変えない）。指定が無ければ setUiLang を呼ぶ。
   */
  onSelect?: (code: string) => void
  onClose: () => void
  /** いまの画面に下のタブが無ければ true（KanjiLayout が routing.ts の entry.tab から渡す。should 1） */
  noTabs: boolean
}

const HEADING_ID = 'kanji-lang-sheet-title'

export function LanguageSheet({ value, onSelect, onClose, noTabs }: LanguageSheetProps) {
  const { t, text, lang } = useI18n()
  const { setUiLang } = useProfiles()
  const current = value ?? lang
  const sheetRef = useRef<HTMLDivElement>(null)

  // LanguageSheet は「開く」＝「マウントする」（LoginSheet 流。ファイル冒頭のコメント）なので、
  // active には常に true を渡す（マウント時に開く処理・アンマウント時に閉じる処理が走る）。
  useFocusTrap(sheetRef, true)

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  function handlePick(code: string) {
    pickLanguage(code, { onSelect, setUiLang })
    onClose()
  }

  return (
    <>
      <button
        type="button"
        className="sheet-backdrop"
        onClick={onClose}
        aria-label={text('common.close')}
        tabIndex={-1}
      />
      <div
        ref={sheetRef}
        className={noTabs ? 'sheet auto no-tabs' : 'sheet auto'}
        role="dialog"
        aria-modal="true"
        aria-labelledby={HEADING_ID}
      >
        <button type="button" className="handle" onClick={onClose} aria-label={text('common.close')} />
        <div className="head">
          <span className="grow">
            <h3 className="detail-title" id={HEADING_ID}>
              {t('lang.title')}
            </h3>
          </span>
          <button type="button" className="sheet-close" onClick={onClose} aria-label={text('common.close')}>
            ×
          </button>
        </div>
        <div className="body">
          <div className="chip-row">
            {LANGUAGES.map((meta) => (
              <button
                key={meta.code}
                type="button"
                className={meta.code === current ? 'chip on' : 'chip'}
                aria-pressed={meta.code === current}
                onClick={() => handlePick(meta.code)}
              >
                {/* must 3: lang はその言語自身での名前（meta.name）の部分だけに付ける。ボタン全体
                    に付けると、日本語 UI のときの「仮訳」（lang.draft）まで外国語扱いになる。 */}
                <span lang={meta.code}>{meta.name}</span>
                {meta.status === 'draft' && <small>{t('lang.draft')}</small>}
              </button>
            ))}
          </div>
        </div>
      </div>
    </>
  )
}
