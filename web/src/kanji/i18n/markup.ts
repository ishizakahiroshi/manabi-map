// 言語パックの文言に書ける小さな書式（差し込み・ふりがな・強調・改行）を解釈するモジュール。
// React には依存しない（描画は同じディレクトリの MarkupView.tsx が行う。子 plan「作業内容」1・2 の分担）。
// HTML 文字列を DOM へそのまま差し込む方式は使わない。HTML 文字列は一切作らず、セグメントの配列だけを返す。

import type { FuriganaMode, Level } from '../types'
import { levelRank } from '../lib/levels'

/**
 * 漢字 1 文字に当たる正規表現。文字そのものではなく、バックスラッシュ + u + 16進の書き方で書く
 * （2026-09-23 レビュー should 6: グレップ・編集のしやすさのため。挙動は同じ）。
 * CJK 統合漢字（4 桁の範囲）・互換漢字（4 桁の範囲）・BMP の外の拡張（波かっこで 5 桁の範囲。
 * 常用漢字の「𠮟」などはここに入る）・々（波かっこで 4 桁・直前の字の繰り返し記号）を含む。
 * 波かっこの記法を使うため u フラグが必須。
 */
export const KANJI_RE = /[\u3400-\u9FFF\uF900-\uFAFF\u{20000}-\u{3134F}\u3005]/u

/**
 * 々（繰り返し記号）。needsRuby の unlearned 判定で「級を持たない記号」として除外するために使う
 * （2026-09-23 レビュー should 2）。KANJI_RE と同じく、文字そのものではなくエスケープの書き方で書く。
 */
const ITERATION_MARK = '\u3005'

/** {name} 差し込み・{漢字|かんじ} ふりがな候補・<br> 改行（<a> の中でも外でも同じ扱い） */
export type InlineSegment =
  | { type: 'text'; value: string }
  | { type: 'furigana'; base: string; reading: string }
  | { type: 'var'; name: string }
  | { type: 'br' }

/** parseMarkup が返すセグメント。InlineSegment に加えて強調（<a>、入れ子にしない）を持つ */
export type MarkupSegment = InlineSegment | { type: 'accent'; children: InlineSegment[] }

/** needsRuby に渡す、学習者のふりがな設定（親 plan D-9） */
export interface FuriganaSetting {
  mode: FuriganaMode
  level: Level
  /** 引数の 1 文字がどの級の字か。分からない字は undefined（漢字データができるまでは常に undefined） */
  levelOf: (ch: string) => Level | undefined
}

/** 末尾が text セグメントなら連結し、セグメントを増やしすぎない（空文字は何もしない） */
function pushText(segments: InlineSegment[], value: string): void {
  if (value.length === 0) return
  const last = segments[segments.length - 1]
  if (last && last.type === 'text') {
    last.value += value
    return
  }
  segments.push({ type: 'text', value })
}

/**
 * {name}（差し込みの場所として残す。値は描画側（MarkupView.tsx）が入れる。文字列ならただの文字列
 * として入れ、値の中の書式は解釈しない。React の要素をそのまま入れてもよい。2026-09-23 レビュー
 * should 7）・{漢字|かんじ}（ふりがな候補）・<br>（改行）を解釈する。
 * <a> はここでは扱わない（parseMarkup が構造として先に切り出し、中身をこの関数に渡す。<a> の中の
 * <br> も <a> の外と同じこの関数で解釈されるので改行になる。2026-09-23 レビュー must 1: 以前は
 * <a> の中身をふりがな候補と差し込みだけを見る別関数に渡していたため <br> が文字のまま素通りしていた。
 * <a> の中と外で同じ関数を使うことで解消する）。
 * 読みの部分に `|` を含むもの（{漢|字|かんじ} {a||b}）はどの書式にもマッチせず、ただの文字として残る
 * （2026-09-23 レビュー should 1: 読みの正規表現 `[^{}]+` が `|` も受けてしまっていたのを
 * `[^{}|]+` に締める）。
 * ふりがな候補の字・読みのどちらにも `<` `>` を含めない（2026-09-23 再レビュー should 3〔通番は
 * このレビューの 1〕: `{漢<br>字|かん}` のように中に <br> があると、それごと base に取り込んで
 * `<br>` が文字のまま出ていた。`<` `>` を締め出すことで、その手前までで match が切れ、続きは
 * <br> トークンとして・その後は素の文字として扱われる）。
 */
function tokenizeSegments(text: string): InlineSegment[] {
  const segments: InlineSegment[] = []
  // { 中身が英数字と _ だけ } = 差し込み、{ 左|右 } = ふりがな候補（左右とも | と < > を含まない）、
  // <br> = 改行。どれでもなければマッチせず、後段の pushText でただの文字として残る。
  const tokenRe = /\{([A-Za-z0-9_]+)\}|\{([^{}|<>]+)\|([^{}|<>]+)\}|<br>/g
  let lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = tokenRe.exec(text))) {
    if (match.index > lastIndex) {
      pushText(segments, text.slice(lastIndex, match.index))
    }
    if (match[0] === '<br>') {
      segments.push({ type: 'br' })
    } else if (match[1] !== undefined) {
      segments.push({ type: 'var', name: match[1] })
    } else {
      segments.push({ type: 'furigana', base: match[2]!, reading: match[3]! })
    }
    lastIndex = tokenRe.lastIndex
  }
  if (lastIndex < text.length) {
    pushText(segments, text.slice(lastIndex))
  }
  return segments
}

/**
 * 言語パックの文言に書ける小さな書式を解釈する（子 plan「作業内容」1）。
 * {name} 差し込み・{漢字|かんじ} ふりがな候補・<a>強調</a>（入れ子にしない。中にふりがな・差し込み・
 * 改行を含んでよい）・<br> 改行の 4 つだけを解釈し、それ以外の `<` `>` `{` `}` はただの文字として残す。
 */
export function parseMarkup(text: string): MarkupSegment[] {
  const segments: MarkupSegment[] = []
  // <a>〜</a> は非貪欲にマッチ（入れ子にしない前提なので、最初に閉じる </a> までを中身とする）
  const structRe = /<a>([\s\S]*?)<\/a>/g
  let lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = structRe.exec(text))) {
    if (match.index > lastIndex) {
      segments.push(...tokenizeSegments(text.slice(lastIndex, match.index)))
    }
    segments.push({ type: 'accent', children: tokenizeSegments(match[1] ?? '') })
    lastIndex = structRe.lastIndex
  }
  if (lastIndex < text.length) {
    segments.push(...tokenizeSegments(text.slice(lastIndex)))
  }
  return segments
}

/**
 * base に漢字が含まれるか。BMP の外の字（サロゲートペア）を分けないよう、文字列を Array.from で
 * 1 コードポイントずつ見る（2026-09-23 レビュー should 6）。
 */
function hasKanji(base: string): boolean {
  return Array.from(base).some((ch) => KANJI_RE.test(ch))
}

/**
 * base にふりがなを付けるか（子 plan「作業内容」1・親 plan D-9）。
 * base に漢字が無ければ、どのモードでも false。all なら true、none なら false。
 * unlearned は、base の中の漢字（々を除く。2026-09-23 レビュー should 2: 々は直前の字の繰り返し
 * 記号で、それ自体は級を持たないため級の判定には使わない）のどれか 1 つでも「levelOf が undefined」か
 * 「levelRank(levelOf(字)) >= levelRank(level)」なら true（＝まだ習っていない扱い）。
 */
export function needsRuby(base: string, setting: FuriganaSetting): boolean {
  if (!hasKanji(base)) return false
  if (setting.mode === 'all') return true
  if (setting.mode === 'none') return false
  return Array.from(base).some((ch) => {
    if (!KANJI_RE.test(ch)) return false
    if (ch === ITERATION_MARK) return false
    const level = setting.levelOf(ch)
    return level === undefined || levelRank(level) >= levelRank(setting.level)
  })
}

/** plainText 用。var は vars（文字列だけ）から引く。無ければ空文字 */
function inlineToPlainText(segment: InlineSegment, vars: Record<string, string> | undefined): string {
  switch (segment.type) {
    case 'text':
      return segment.value
    case 'furigana':
      return segment.base
    case 'br':
      return ' '
    case 'var':
      return vars?.[segment.name] ?? ''
  }
}

/**
 * 書式を外した素の文字列（aria-label・placeholder 用）。ふりがなは文字だけ・強調の印を外す・
 * 改行は半角空白にする。vars は文字列だけを受け付ける（React の要素は渡せない。差し込みは
 * MarkupView.tsx の Markup コンポーネントとは別に、ここで文字列として解決する。子 plan「作業内容」1）。
 */
export function plainText(text: string, vars?: Record<string, string>): string {
  return parseMarkup(text)
    .map((segment) => {
      if (segment.type === 'accent') {
        return segment.children.map((child) => inlineToPlainText(child, vars)).join('')
      }
      return inlineToPlainText(segment, vars)
    })
    .join('')
}
