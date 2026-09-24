// 学習者の追加・編集フォームの「ことば」欄（ボタン + LanguageSheet）を 1 つの部品にまとめたもの
// （C8 レビュー must 3）。
//
// open・onOpenChange を親（pages/ProfileEditPage.tsx）から渡す制御コンポーネントにしてある。
// 理由: vitest の環境は node（DOM が無い）ため、「ボタンを押してシートを開く」操作を
// シミュレートできない。open を外から渡せる形にしておけば、テストから open={true} を直接渡して
// LanguageSheet が描かれた状態を検証できる（EditLangField.test.ts）。ProfileEditPage.tsx 側は、
// 内部にあった langSheetOpen の state をそのままこのコンポーネントへ渡すだけで、動きは今までと
// 変わらない。
//
// onSelect（LanguageSheet が選んだ言語コードを渡してくる）は onChange をそのまま呼ぶだけで、
// setUiLang は呼ばない（LanguageSheet 側の分岐は components/LanguageSheet.tsx 冒頭のコメントと
// components/sheets.test.ts の pickLanguage のテストを参照。onSelect を渡している限り、
// LanguageSheet は setUiLang を呼ばない）。これにより、学習者の追加・編集フォームでことばを選んでも
// フォームの値だけが変わり、いまの学習者や他の学習者の lang は変わらない（子 plan「作業内容」4）。
//
// should 2（2026-09-24 C8 レビュー）: ことばのボタンの aria-labelledby に、見出しの span の id
// （labelId）だけでなく、実際に選んでいる言語名を表示する span の id（`${labelId}-value`）も足す。
// ボタンを読み上げたときに「ことば（画面の言語） 日本語」のように、見出しと現在値の両方が伝わる。

import { LANGUAGES } from '../i18n/packs'
import { LanguageSheet } from './LanguageSheet'

export interface EditLangFieldProps {
  /** フォームがいま持っている言語コード（学習者の lang ではなく、フォームの入力値） */
  value: string
  /** ことばシートで選んだ言語コードを、フォームの値として反映する（setUiLang は呼ばない） */
  onChange: (code: string) => void
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 見出し（form-label）の id。aria-labelledby の起点にする */
  labelId: string
}

export function EditLangField({ value, onChange, open, onOpenChange, labelId }: EditLangFieldProps) {
  const selectedName = LANGUAGES.find((meta) => meta.code === value)?.name ?? value
  const valueId = `${labelId}-value`

  return (
    <>
      <button
        type="button"
        className="mypage-link"
        aria-labelledby={`${labelId} ${valueId}`}
        onClick={() => onOpenChange(true)}
      >
        <span className="ic" aria-hidden="true">
          🌐
        </span>
        <span id={valueId} lang={value}>
          {selectedName}
        </span>
        <span className="arrow" aria-hidden="true">
          ›
        </span>
      </button>
      {/* 申し送り 3（2026-09-24）: このシートは <form className="profile-edit-form"> の中に描かれる
          （Fragment を挟んでいるだけなので、開いたときは実質 <form> の直下の子になる）。フォーム側の
          .chip 用 CSS（kanji.css）は .profile-edit-form の直下の .chip-row／.level-band だけに
          絞ってあるので、このシートの中の .body .chip-row（さらに 1 段深い）には触れない。 */}
      {open && (
        <LanguageSheet
          value={value}
          onSelect={(code) => {
            onChange(code)
            onOpenChange(false)
          }}
          onClose={() => onOpenChange(false)}
          noTabs
        />
      )}
    </>
  )
}
