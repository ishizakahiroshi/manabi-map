#!/usr/bin/env node
/**
 * 学校別入試PDF（募集定員・志願者数・受検者数・合格者数の一覧表）を、
 * 機械的に per-school 行へ復元する汎用tool。
 *
 * 背景: 京都府・福岡県・佐賀県・長崎県・兵庫県などの入試PDFをpdftotextで抽出すると、
 * 縦書き・二段組・罫線なし表などが原因で「学校名」「定員」「志願者数」等の列が
 * 別々の行にドリフトする。本toolは学校名をアンカーにして、周辺の数値列を
 * 1school 1行へ寄せ集める（完璧な抽出は不可能なので、失敗行はquarantineへ落とす）。
 *
 * 実行:
 *   node scripts/admission/pdf-extract.mjs <pdf-path> --out <csv>
 *   node scripts/admission/pdf-extract.mjs <pdf-path> --anchor "<regex>" --out <csv>
 *   node scripts/admission/pdf-extract.mjs <pdf-path> --columns capacity=0,applicants=2,examinees=3,admitted=4,ratio=5 --out <csv>
 *   node scripts/admission/pdf-extract.mjs <pdf-path> --engine pymupdf --out <csv>
 *   node scripts/admission/pdf-extract.mjs <txt-path> --start-marker "学舎・分校名" --out <csv>
 *
 * 入力: PDFパス（拡張子 .pdf）を渡すとテキスト化してから解析する。テキスト化の
 * エンジンは --engine で選ぶ:
 *   auto (既定) … poppler を試し、CJKが壊れている・出力が空・pdftotext未導入の
 *                 いずれかならPyMuPDFへフォールバックする
 *   poppler     … `pdftotext -layout`（失敗時はレイアウト保持なしで再試行）
 *   pymupdf     … scripts/admission/pymupdf-extract.py をPython経由で呼ぶ
 * 福岡 S02 268332.pdf・長崎 R8 capacity PDF のようにCIDフォントで埋め込まれた
 * 入試表はpopplerでは字形を復元できないため、PyMuPDFエンジンが必要になる。
 * 拡張子 .txt を渡した場合は、既に抽出済みのテキストとしてそのまま読む
 * （実測材料の tmp/kyoto-pdf/*.txt はこの経路で読む）。
 *
 * 出力: school_name,capacity,applicants,examinees,admitted,ratio,source_line_range のCSV。
 * 未解決行（学校名アンカーが確定しない等）は `<out>` と同じディレクトリの
 * `quarantine.csv` に raw_line と reason で出力する。
 *
 * 本toolはDBへ接続しない。抽出結果の採否・投入は別途人間が確認する。
 */

import { execFileSync } from 'node:child_process'
import { readFileSync as readFile, writeFileSync as writeFile } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// 学校名アンカーの既定パターン（JSDoc記載の要件どおり）。
// 「高等学校/高校/中等教育学校」の全部または一部を含む名前にマッチさせる用途。
// 実データの多くは県立高校一覧で略称（末尾の「高校」なし）が使われるため、
// これだけでは不十分。builtinNameCandidate() の汎用ヒューリスティックと併用する。
export const DEFAULT_ANCHOR_SOURCE = '[一-龠ぁ-んァ-ヶー]{2,20}(高等学校|高校|中等教育学校)'

// 学科名・欄見出し等、学校名として絶対に採用しないキーワード。
const DEPT_KEYWORDS = [
  '普通', '専門', '総合', '情報', '商業', '工業', '農業', '家庭', '福祉', '理数', '国際', '芸術', '美術', '音楽', '体育',
  'ものづくり', 'まちづくり', '建築', '電気', '機械', '土木', '環境', 'ビジネス', 'デザイン', '探究', 'クリエイト', '分野', '学科', 'コース', '分校', '学舎',
  '単位制', '系列', '類型', '科学', '工学', '起業', '創造', '企画', 'アグリ', 'プロジェクト', 'ステ', 'ジネス', 'テクノロジー', 'ロボット', '自動車',
  '溶接', '電子', '機工', '金属', 'セラミック', '繊維', 'グラフィック', '園芸', '植物', 'クラフト', '昼間', '夜間', '定時制', '通信制', '課程', '選抜',
  '募集', '合計', '実施', '倍率', '検査', '面接', '報告書', '活動', '実績', '配点', '比率', '人員', '志願', '受検', '合格', '年度', '全日制', '願書',
  '問い合わせ', '教育委員会', '推進', '学校指導', '担当', '直通', '目次', '制度', '所在地図', '通学圏', '備考',
]

// 学校名の一部として単独では採用しない1文字（地域欄・接続詞の縦書き崩れ対策）。
const SINGLE_CHAR_STOPLIST = new Set(['京', '都', '市', '丹', '後', '通', '学', '圏', '乙', '訓', '全', '計', '小', '・', '年', '度', '其', '他', '夜', '間', '注'])

const CJK_NAME_RE = /^[一-龠々〆ヶぁ-んァ-ヶーゝゞ\s　]{1,20}$/
const SINGLE_FREE_CHAR_RE = /^[一-龠々〆ヶ]$/
const NUM_RE = /-?\d[\d,]*(?:\.\d+)?/g

function builtinNameCandidate(token) {
  const t = (token ?? '').trim()
  if (!t) return false
  if (!CJK_NAME_RE.test(t)) return false
  // 入試表のセルは字間を全角スペースで調整していることが多く（例: 「総　合」「室　　戸」）、
  // 生のままキーワード照合すると学科名が学校名としてすり抜ける。空白を落としてから判定する。
  const normalized = t.replaceAll(/[\s　]/g, '')
  if (!normalized) return false
  if (normalized.length === 1 && SINGLE_CHAR_STOPLIST.has(normalized)) return false
  if (DEPT_KEYWORDS.some((keyword) => normalized.includes(keyword))) return false
  return true
}

function isNameCandidate(token, anchorRegex) {
  if (anchorRegex && anchorRegex.test(token)) return true
  return builtinNameCandidate(token)
}

function isSingleFreeChar(token) {
  const t = (token ?? '').trim()
  return t.length === 1 && !SINGLE_CHAR_STOPLIST.has(t) && SINGLE_FREE_CHAR_RE.test(t)
}

// 縦書きくずれで1文字ずつ別トークンになった学校名（例: "山" "城" → "山城"）を復元する。
// 数字トークンや stoplist 文字が挟まると連結しない。
function mergeSingleCharTokens(tokens) {
  const out = []
  let buffer = ''
  for (const token of tokens) {
    if (isSingleFreeChar(token)) {
      buffer += token
      continue
    }
    if (buffer) {
      out.push(buffer)
      buffer = ''
    }
    out.push(token)
  }
  if (buffer) out.push(buffer)
  return out
}

function extractNumbers(text) {
  const out = []
  for (const match of text.matchAll(NUM_RE)) out.push(Number(match[0].replaceAll(',', '')))
  return out
}

// 数値列 → capacity/applicants/examinees/admitted/ratio のマッピング。
// 既定は「募集定員(A) 中期選抜募集人員(B) 志願者数(C) 受検者数(D) 合格者数(E) 倍率 昨年度倍率」
// という西日本入試PDFで頻出する並びを仮定する。--columns で明示指定した項目があれば上書きする。
function defaultColumnMap(numbers) {
  if (numbers.length >= 5) {
    return { capacity: 0, applicants: 2, examinees: 3, admitted: 4, ratio: numbers.length >= 6 ? 5 : null }
  }
  if (numbers.length === 4) {
    return { capacity: 0, applicants: 1, examinees: 2, admitted: 3, ratio: null }
  }
  return { capacity: 0, applicants: null, examinees: null, admitted: null, ratio: null }
}

function pick(numbers, index) {
  if (index == null) return null
  const value = numbers[index]
  return value === undefined ? null : value
}

/**
 * pdftotextで抽出済みのテキストから、per-school行を復元する。
 *
 * @param {string} text pdftotextの出力（-layout推奨）
 * @param {object} [options]
 * @param {string} [options.anchor] 学校名アンカーの追加正規表現（DEFAULT_ANCHOR_SOURCEに追加で使う）
 * @param {Record<string, number>} [options.columns] 数値列インデックスの上書き（例: {capacity:0, applicants:2}）
 * @param {string} [options.startMarker] このテキストを含む行より前は解析対象から除外する（サマリー表・目次などの誤検出防止）
 * @returns {{ rows: Array<object>, quarantine: Array<object> }}
 */
export function parseSchoolRows(text, options = {}) {
  const anchorRegex = options.anchor ? new RegExp(options.anchor) : null
  const columnOverrides = options.columns ?? {}
  const startMarker = options.startMarker ?? null

  const lines = text.split(/\r?\n/)
  const rows = []
  const quarantine = []
  let currentSchool = ''
  let started = !startMarker

  const finalize = (name, numbers, lineNo, rawLine) => {
    if (numbers.length === 0) return
    if (!name) {
      quarantine.push({ line: lineNo, reason: 'name_unresolved', raw: rawLine })
      return
    }
    const map = { ...defaultColumnMap(numbers), ...columnOverrides }
    rows.push({
      school_name: name,
      capacity: pick(numbers, map.capacity),
      applicants: pick(numbers, map.applicants),
      examinees: pick(numbers, map.examinees),
      admitted: pick(numbers, map.admitted),
      ratio: pick(numbers, map.ratio),
      source_line_range: `${lineNo}-${lineNo}`,
    })
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!started) {
      if (startMarker && line.includes(startMarker)) started = true
      continue
    }
    if (!line.trim()) continue

    let tokens = line.split(/ {2,}/).map((s) => s.trim()).filter(Boolean)
    tokens = mergeSingleCharTokens(tokens)

    let pendingName = currentSchool
    let pendingNumbers = []
    for (const token of tokens) {
      if (isNameCandidate(token, anchorRegex)) {
        finalize(pendingName, pendingNumbers, i + 1, line)
        pendingName = token.replaceAll(/[\s　]/g, '')
        currentSchool = pendingName
        pendingNumbers = []
      } else {
        pendingNumbers.push(...extractNumbers(token))
      }
    }
    finalize(pendingName, pendingNumbers, i + 1, line)
  }

  return { rows, quarantine }
}

const MAX_BUFFER = 64 * 1024 * 1024
const PYMUPDF_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'pymupdf-extract.py')

export const ENGINES = ['auto', 'poppler', 'pymupdf']

// PyMuPDF を動かすPythonの探索順。MANABI_PYTHON で明示指定できる。
// Windows では `py` ランチャ、Unix では `python3` が通ることが多いので両方見る。
const PYTHON_CANDIDATES = ['python3', 'python', 'py']

const CJK_CHAR_RE = /[぀-ヿ㐀-鿿]/g
const CID_MARKER_RE = /\(cid:\d+\)/g
// pdftotext がグリフを解決できないと U+FFFD（置換文字）や制御文字が並ぶ。
const BROKEN_CHAR_RE = /[\uFFFD\u0000-\u0008\u000B\u000C\u000E-\u001F]/g

function countMatches(text, regex) {
  return (text.match(regex) ?? []).length
}

/**
 * poppler の抽出結果が「日本語の入試表として使い物になるか」を判定する。
 * CIDフォント埋め込みのPDFでは、本文が空・`(cid:123)` の羅列・置換文字だらけの
 * いずれかになるため、そのケースを検出してPyMuPDFへ回す。
 *
 * @param {string} text
 * @returns {boolean}
 */
export function isPopplerTextUsable(text) {
  const body = (text ?? '').trim()
  if (body.length === 0) return false
  if (countMatches(body, CID_MARKER_RE) > 0) return false
  if (countMatches(body, BROKEN_CHAR_RE) / body.length > 0.02) return false
  // 日本語の入試表を想定しているので、CJKが1文字も無い抽出結果は失敗とみなす。
  return countMatches(body, CJK_CHAR_RE) > 0
}

function runPdftotext(pdfPath, args) {
  return execFileSync('pdftotext', [...args, pdfPath, '-'], { encoding: 'utf8', maxBuffer: MAX_BUFFER })
}

/**
 * poppler pdftotext でPDFをテキスト化する。`-layout` を優先し、
 * 失敗または出力が空の場合はレイアウト保持なしにフォールバックする。
 * @param {string} pdfPath
 * @returns {string}
 */
export function extractWithPoppler(pdfPath) {
  let layoutText = ''
  try {
    layoutText = runPdftotext(pdfPath, ['-layout'])
  } catch {
    layoutText = ''
  }
  if (layoutText.trim().length > 0) return layoutText
  return runPdftotext(pdfPath, [])
}

/**
 * PyMuPDF（pymupdf-extract.py）でPDFをレイアウト保持テキスト化する。
 * @param {string} pdfPath
 * @param {object} [options]
 * @param {number} [options.gap] 列区切りとみなすx方向の隙間（pt）
 * @returns {string}
 */
export function extractWithPymupdf(pdfPath, options = {}) {
  const args = [PYMUPDF_SCRIPT, pdfPath]
  if (options.gap != null) args.push('--gap', String(options.gap))

  const candidates = process.env.MANABI_PYTHON ? [process.env.MANABI_PYTHON] : PYTHON_CANDIDATES
  const failures = []
  for (const python of candidates) {
    try {
      return execFileSync(python, args, { encoding: 'utf8', maxBuffer: MAX_BUFFER })
    } catch (error) {
      // Python自体が見つからない場合だけ次の候補へ進む。PyMuPDF未導入や
      // PDF不正はどの候補でも同じ結果になるので、その旨を添えて中断する。
      const message = error instanceof Error ? error.message : String(error)
      failures.push(`${python}: ${message}`)
      if (error?.code !== 'ENOENT') break
    }
  }
  throw new Error(`PyMuPDFでの抽出に失敗しました:\n${failures.join('\n')}`)
}

/**
 * PDFをテキスト化する。
 *
 * @param {string} pdfPath
 * @param {object} [options]
 * @param {'auto'|'poppler'|'pymupdf'} [options.engine] 既定は 'auto'
 * @param {number} [options.gap] PyMuPDFエンジンの列区切り閾値（pt）
 * @param {(path: string) => string} [options.poppler] テスト用の差し替え
 * @param {(path: string, options: object) => string} [options.pymupdf] テスト用の差し替え
 * @returns {string}
 */
export function extractPdfText(pdfPath, options = {}) {
  const engine = options.engine ?? 'auto'
  if (!ENGINES.includes(engine)) throw new Error(`不明な --engine: ${engine}（${ENGINES.join('|')} のいずれか）`)

  const poppler = options.poppler ?? extractWithPoppler
  const pymupdf = options.pymupdf ?? extractWithPymupdf

  if (engine === 'pymupdf') return pymupdf(pdfPath, options)
  if (engine === 'poppler') return poppler(pdfPath)

  let popplerText = ''
  try {
    popplerText = poppler(pdfPath)
  } catch (error) {
    // pdftotext 未導入（ENOENT）も「popplerでは取れない」ケースとして扱う。
    popplerText = ''
    if (process.env.MANABI_PDF_DEBUG) console.error(`poppler 失敗: ${error instanceof Error ? error.message : error}`)
  }
  if (isPopplerTextUsable(popplerText)) return popplerText
  console.error('poppler ではCJKを復元できませんでした。PyMuPDF へフォールバックします。')
  return pymupdf(pdfPath, options)
}

function csvField(value) {
  if (value === null || value === undefined) return ''
  const s = String(value)
  if (/[",\n]/.test(s)) return `"${s.replaceAll('"', '""')}"`
  return s
}

function toCsv(header, records) {
  const lines = [header.join(',')]
  for (const record of records) lines.push(header.map((key) => csvField(record[key])).join(','))
  return lines.join('\n') + '\n'
}

const ROW_HEADER = ['school_name', 'capacity', 'applicants', 'examinees', 'admitted', 'ratio', 'source_line_range']
const QUARANTINE_HEADER = ['line', 'reason', 'raw']

function parseColumnsArg(value) {
  const map = {}
  for (const pair of value.split(',')) {
    const [name, index] = pair.split('=')
    if (!name || index === undefined) throw new Error(`--columns の指定が不正です: ${pair}`)
    map[name.trim()] = Number(index.trim())
  }
  return map
}

export function parseArgs(argv) {
  const args = { input: '', anchor: '', columns: '', out: '', startMarker: '', engine: 'auto', gap: null }
  const positionals = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--anchor') args.anchor = argv[++i] ?? ''
    else if (arg === '--columns') args.columns = argv[++i] ?? ''
    else if (arg === '--out') args.out = argv[++i] ?? ''
    else if (arg === '--start-marker') args.startMarker = argv[++i] ?? ''
    else if (arg === '--engine') {
      args.engine = argv[++i] ?? ''
      if (!ENGINES.includes(args.engine)) throw new Error(`不明な --engine: ${args.engine}（${ENGINES.join('|')} のいずれか）`)
    } else if (arg === '--gap') {
      args.gap = Number(argv[++i])
      if (!Number.isFinite(args.gap)) throw new Error('--gap には数値（pt）を指定してください')
    }
    else if (arg === '--help' || arg === '-h') args.help = true
    else if (arg.startsWith('--')) throw new Error(`不明な引数: ${arg}`)
    else positionals.push(arg)
  }
  args.input = positionals[0] ?? ''
  return args
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args.input) {
    console.error('使い方: node scripts/admission/pdf-extract.mjs <pdf-or-txt-path> [--engine auto|poppler|pymupdf] [--gap <pt>] [--anchor <regex>] [--columns name=index,...] [--start-marker <substring>] [--out <csv>]')
    process.exit(args.help ? 0 : 2)
  }
  const isTxt = extname(args.input).toLowerCase() === '.txt'
  const engineOptions = { engine: args.engine }
  if (args.gap != null) engineOptions.gap = args.gap
  const text = isTxt ? readFile(args.input, 'utf8') : extractPdfText(args.input, engineOptions)
  const options = {}
  if (args.anchor) options.anchor = args.anchor
  if (args.columns) options.columns = parseColumnsArg(args.columns)
  if (args.startMarker) options.startMarker = args.startMarker

  const { rows, quarantine } = parseSchoolRows(text, options)
  const distinctSchools = new Set(rows.map((r) => r.school_name)).size
  console.error(`抽出: rows=${rows.length} (schools=${distinctSchools}) quarantine=${quarantine.length}`)

  if (args.out) {
    writeFile(args.out, toCsv(ROW_HEADER, rows), 'utf8')
    const quarantinePath = args.out.replace(/\.csv$/i, '') + '.quarantine.csv'
    writeFile(quarantinePath, toCsv(QUARANTINE_HEADER, quarantine), 'utf8')
    console.error(`書き出しました: ${args.out} / ${quarantinePath}`)
  } else {
    process.stdout.write(toCsv(ROW_HEADER, rows))
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main()
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
