// C3 の書式（同じディレクトリの markup.ts）を React 要素として描く部品。
// 文字列を HTML としてそのまま DOM へ入れる方式はとらない（学習者ごとのふりがな設定を、描画の直前に
// React の要素として反映する。子 plan「調査で確認した現在の実装」・「書き方の約束」）。
// ファイル名は markup.ts と大文字小文字だけ違う名前にしない（Windows 等の大文字小文字を
// 区別しないファイルシステムで TypeScript の TS1149 になるため。2026-09-23 コーディネーター指摘で改名）。

import { cloneElement, createContext, isValidElement, useContext, type ReactElement, type ReactNode } from 'react'
import { needsRuby, parseMarkup, type FuriganaSetting, type InlineSegment, type MarkupSegment } from './markup'

/**
 * {name} に差し込める値。文字列・数値・React の要素だけに絞る（2026-09-23 再レビュー should 2〔通番は
 * このレビューの 2〕: ReactNode のままだと配列（ReactNode[]）も通ってしまい、渡された配列の要素に
 * key が無いと React が警告を出す。配列を弾くことで、renderVar の cloneElement による key 付与が
 * 必ず効くようにする）。
 */
export type VarValue = string | number | ReactElement

/**
 * 学習者がまだいないとき（はじめての画面など）に使う既定値。levelOf は常に undefined を返すため、
 * needsRuby の unlearned は「levelOf が undefined」の条件で常に true になり、all と同じ見え方になる。
 * 漢字ごとの級のデータができるまでの暫定で、データが揃ったら本物の levelOf を渡す
 * （親 plan C3・子 plan「作業内容」2 のコメント指示）。
 */
const DEFAULT_FURIGANA_SETTING: FuriganaSetting = {
  mode: 'all',
  level: '10',
  levelOf: () => undefined,
}

/** ふりがなの設定（学習者の級・ふりがなモード・級の判定関数）を配る Context */
export const FuriganaContext = createContext<FuriganaSetting>(DEFAULT_FURIGANA_SETTING)

/**
 * FuriganaContext の値を差し替える。画面の骨組み（親 plan C6）が学習者の設定で包む。
 * children は型としては省略可にしている（createElement の型推論のため。呼び出し側は必ず渡す）。
 */
export function FuriganaProvider({ value, children }: { value: FuriganaSetting; children?: ReactNode }) {
  return <FuriganaContext.Provider value={value}>{children}</FuriganaContext.Provider>
}

/**
 * {name} の差し込み値を要素にする。値が文字列ならただの文字列として入れる（React が自動でエスケープ
 * するので HTML タグにはならない。値の中の書式は解釈しない）。値が React の要素ならそのまま入れる
 * （ふりがなを保ったまま差し込むため。2026-09-23 レビュー should 7）。配列の中に置くための key だけ足す
 * （文字列・数値・空文字には key は要らない）。
 */
function renderVar(name: string, key: number, vars: Record<string, VarValue> | undefined): ReactNode {
  const value = vars?.[name] ?? ''
  if (isValidElement(value)) {
    return cloneElement(value, { key })
  }
  return value
}

/**
 * InlineSegment（text・furigana・var・br）を要素にする。<a> の中身にも最上位にも使う
 * （2026-09-23 レビュー must 1: <a> の中の <br> もここを通るので改行になる）。
 */
function renderInline(
  segment: InlineSegment,
  key: number,
  setting: FuriganaSetting,
  vars: Record<string, VarValue> | undefined,
): ReactNode {
  switch (segment.type) {
    case 'text':
      return segment.value
    case 'br':
      return <br key={key} />
    case 'var':
      return renderVar(segment.name, key, vars)
    case 'furigana':
      if (!needsRuby(segment.base, setting)) return segment.base
      return (
        <ruby key={key}>
          {segment.base}
          <rt>{segment.reading}</rt>
        </ruby>
      )
  }
}

/** 最上位のセグメント（強調を含む）を要素にする */
function renderSegment(
  segment: MarkupSegment,
  key: number,
  setting: FuriganaSetting,
  vars: Record<string, VarValue> | undefined,
): ReactNode {
  if (segment.type === 'accent') {
    return (
      <span className="accent" key={key}>
        {segment.children.map((child, i) => renderInline(child, i, setting, vars))}
      </span>
    )
  }
  return renderInline(segment, key, setting, vars)
}

/**
 * 言語パックの文言（C3 の書式）を描く。文字列を HTML としてそのまま差し込む API は使わない
 * （子 plan「書き方の約束」）。ふりがなの要不要は FuriganaContext（学習者の設定）で決まる。
 * vars の値は文字列・数値・React の要素（2026-09-23 レビュー should 7、再レビュー should 2）。
 * 配列は受け付けない（VarValue の定義を参照）。文字列だけの plainText 用の vars とは型が違うので、
 * こちらは markup.ts の plainText には渡さない。
 */
export function Markup({ text, vars }: { text: string; vars?: Record<string, VarValue> }) {
  const setting = useContext(FuriganaContext)
  const segments = parseMarkup(text)
  return <>{segments.map((segment, i) => renderSegment(segment, i, setting, vars))}</>
}
