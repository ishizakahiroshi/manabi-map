import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, test } from 'node:test'

import { ENGINES, extractPdfText, isPopplerTextUsable, parseArgs, parseSchoolRows } from './pdf-extract.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const fixtureDir = join(here, '..', '..', 'tmp', 'kyoto-pdf')

function loadFixture(name) {
  return readFileSync(join(fixtureDir, name), 'utf8')
}

// PyMuPDF が動くPythonを探す。pdf-extract.mjs 本体と同じ探索順・同じ環境変数を使う。
function resolvePython() {
  const candidates = process.env.MANABI_PYTHON ? [process.env.MANABI_PYTHON] : ['python3', 'python', 'py']
  for (const python of candidates) {
    try {
      execFileSync(python, ['-c', 'import pymupdf'], { stdio: 'ignore' })
      return python
    } catch {
      continue
    }
  }
  return null
}

let tempDir = null
function workDir() {
  tempDir ??= mkdtempSync(join(tmpdir(), 'manabi-pdf-extract-'))
  return tempDir
}
after(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true })
})

// pdftotext が苦手な「罫線なし・列が座標だけで分かれた日本語の表」をPyMuPDFで生成する。
const BUILD_PDF_SCRIPT = `
import sys
import pymupdf

ROWS = [
    ("山城", "普通", "320  224  301  301  224  1.34"),
    ("鴨沂", "普通", "240  168  265  265  168  1.58"),
]

document = pymupdf.open()
page = document.new_page()
y = 100
for name, department, numbers in ROWS:
    page.insert_text((40, y), name, fontname="japan", fontsize=10)
    page.insert_text((140, y), department, fontname="japan", fontsize=10)
    page.insert_text((240, y), numbers, fontsize=10)
    y += 24
document.save(sys.argv[1])
`

function buildCjkTablePdf(python, pdfPath) {
  execFileSync(python, ['-c', BUILD_PDF_SCRIPT, pdfPath], { stdio: 'ignore' })
}

// 京都府 中期選抜合格者数一覧（R6/R7/R8）は「地 学校名 学科等名 募集定員 ...」の
// 見出し行の直後から per-school 行が並ぶ。見出し前のサマリー表・順位表の誤検出を
// 避けるため、実運用と同じ --start-marker 相当のオプションで解析する。
const MID_ADMITTED_START_MARKER = '学舎・分校名'

for (const fixture of ['r6-mid-admitted.txt', 'r7-mid-admitted.txt', 'r8-mid-admitted.txt']) {
  test(`${fixture}: 上位10校がper-school行として抽出できる`, () => {
    const text = loadFixture(fixture)
    const { rows } = parseSchoolRows(text, { startMarker: MID_ADMITTED_START_MARKER })
    assert.ok(rows.length >= 10, `rows.length=${rows.length}`)

    const distinctSchools = [...new Set(rows.map((r) => r.school_name))]
    assert.ok(distinctSchools.length >= 10, `distinctSchools.length=${distinctSchools.length}`)

    // 冒頭の代表校（山城・鴨沂・洛北）は実データで確実に解決できる基準行。
    const bySchool = Object.fromEntries(rows.map((r) => [r.school_name, r]))
    assert.ok(bySchool['山城'], '山城 が抽出できていない')
    assert.equal(bySchool['山城'].capacity, 320)
    assert.ok(bySchool['山城'].applicants > 0)
    assert.ok(bySchool['山城'].admitted > 0)

    assert.ok(bySchool['鴨沂'], '鴨沂 が抽出できていない')
    assert.ok(bySchool['洛北'], '洛北 が抽出できていない')
  })
}

test('r8-school-guide.txt: 学科抽出が20校以上できる', () => {
  const text = loadFixture('r8-school-guide.txt')
  // 学校案内は目次より前の表紙・制度説明ページで学校名らしき語が多数誤検出されるため、
  // 全日制課程の学校一覧（目次内の通学圏別ページ索引）から解析する。
  const { rows } = parseSchoolRows(text, { startMarker: '全日制課程' })
  const distinctSchools = new Set(rows.map((r) => r.school_name))
  assert.ok(distinctSchools.size >= 20, `distinctSchools.size=${distinctSchools.size}`)

  // 代表校が学科案内の一覧から解決できていること。
  for (const name of ['山城', '鴨沂', '洛北', '桂']) {
    assert.ok(distinctSchools.has(name), `${name} が抽出できていない`)
  }
})

test('parseSchoolRows: 学校名アンカーがない数値行はquarantineへ落ちる', () => {
  const text = [
    '見出し 学校名 学科等名 募集定員',
    '320 224 301 301 224 1.34',
  ].join('\n')
  const { rows, quarantine } = parseSchoolRows(text, { startMarker: '学校名' })
  assert.equal(rows.length, 0)
  assert.equal(quarantine.length, 1)
  assert.equal(quarantine[0].reason, 'name_unresolved')
})

test('parseSchoolRows: 5数値の行は capacity/applicants/examinees/admitted/ratio に既定マッピングされる', () => {
  const text = [
    '見出し 学校名 学科等名 募集定員',
    '　　山　城      普通　　　　320　224　301　301　224　1.34',
  ].join('\n')
  const { rows } = parseSchoolRows(text, { startMarker: '学校名' })
  assert.equal(rows.length, 1)
  const [row] = rows
  assert.equal(row.school_name, '山城')
  assert.equal(row.capacity, 320)
  assert.equal(row.applicants, 301)
  assert.equal(row.examinees, 301)
  assert.equal(row.admitted, 224)
  assert.equal(row.ratio, 1.34)
})

test('parseSchoolRows: --columns相当のオプションで列マッピングを上書きできる', () => {
  const text = [
    '見出し 学校名 学科等名 募集定員',
    '　　鴨　沂      普通　　　　240　168　265　265　168　1.58',
  ].join('\n')
  const { rows } = parseSchoolRows(text, {
    startMarker: '学校名',
    columns: { capacity: 0, applicants: 1, examinees: 2, admitted: 4, ratio: 5 },
  })
  assert.equal(rows.length, 1)
  const [row] = rows
  assert.equal(row.school_name, '鴨沂')
  assert.equal(row.capacity, 240)
  assert.equal(row.applicants, 168)
  assert.equal(row.examinees, 265)
  assert.equal(row.admitted, 168)
  assert.equal(row.ratio, 1.58)
})

// --- エンジン選択（Task #17: PyMuPDF fallback） ---

test('isPopplerTextUsable: 日本語が取れている抽出結果は採用する', () => {
  assert.equal(isPopplerTextUsable('　　山　城      普通　　　　320　224　301'), true)
})

test('isPopplerTextUsable: 空・CIDマーカー羅列・置換文字だらけは不採用', () => {
  assert.equal(isPopplerTextUsable(''), false)
  assert.equal(isPopplerTextUsable('   \n  \n'), false)
  assert.equal(isPopplerTextUsable('(cid:12)(cid:34) 320 224'), false)
  assert.equal(isPopplerTextUsable('���� 320 224'), false)
  // CJKが1文字も無い抽出結果は、日本語入試表としては失敗とみなす。
  assert.equal(isPopplerTextUsable('320 224 301 301 224 1.34'), false)
})

test('extractPdfText: --engine auto はpopplerが壊れているとPyMuPDFへフォールバックする', () => {
  const calls = []
  const text = extractPdfText('dummy.pdf', {
    engine: 'auto',
    poppler: () => {
      calls.push('poppler')
      return '(cid:12)(cid:34)'
    },
    pymupdf: () => {
      calls.push('pymupdf')
      return '山城   普通   320'
    },
  })
  assert.deepEqual(calls, ['poppler', 'pymupdf'])
  assert.equal(text, '山城   普通   320')
})

test('extractPdfText: --engine auto はpdftotext未導入（throw）でもPyMuPDFへ回す', () => {
  const text = extractPdfText('dummy.pdf', {
    engine: 'auto',
    poppler: () => {
      const error = new Error('spawn pdftotext ENOENT')
      error.code = 'ENOENT'
      throw error
    },
    pymupdf: () => '山城   普通   320',
  })
  assert.equal(text, '山城   普通   320')
})

test('extractPdfText: --engine auto はpopplerで取れていればPyMuPDFを呼ばない', () => {
  const calls = []
  const text = extractPdfText('dummy.pdf', {
    engine: 'auto',
    poppler: () => {
      calls.push('poppler')
      return '山城   普通   320   224'
    },
    pymupdf: () => {
      calls.push('pymupdf')
      return 'unused'
    },
  })
  assert.deepEqual(calls, ['poppler'])
  assert.equal(text, '山城   普通   320   224')
})

test('extractPdfText: --engine poppler / pymupdf は指定エンジンのみを使う', () => {
  const poppler = () => 'poppler-text'
  const pymupdf = () => 'pymupdf-text'
  assert.equal(extractPdfText('d.pdf', { engine: 'poppler', poppler, pymupdf }), 'poppler-text')
  assert.equal(extractPdfText('d.pdf', { engine: 'pymupdf', poppler, pymupdf }), 'pymupdf-text')
})

test('parseArgs: --engine の値を検証し、未知の値は即エラーにする', () => {
  assert.equal(parseArgs(['a.pdf']).engine, 'auto')
  assert.equal(parseArgs(['a.pdf', '--engine', 'pymupdf']).engine, 'pymupdf')
  assert.equal(parseArgs(['a.pdf', '--gap', '6']).gap, 6)
  assert.throws(() => parseArgs(['a.pdf', '--engine', 'tesseract']), /不明な --engine/)
  assert.throws(() => parseArgs(['a.pdf', '--gap', 'wide']), /--gap/)
  assert.deepEqual(ENGINES, ['auto', 'poppler', 'pymupdf'])
})

// PyMuPDF実経路の統合テスト。CIDフォント埋め込みPDFの実物はリポジトリに置けないため、
// PyMuPDF自身の内蔵日本語フォントで同等の「pdftotextが苦手な表」を生成して往復させる。
// PyMuPDFが導入されていない環境ではスキップする（poppler側の既存テストは影響を受けない）。
const python = resolvePython()

test('PyMuPDFエンジン: 日本語の表PDFを列区切り付きテキストへ復元しper-school行にできる', { skip: python ? false : 'PyMuPDF/Python が無い環境' }, () => {
  const pdfPath = join(workDir(), 'cjk-table.pdf')
  buildCjkTablePdf(python, pdfPath)

  const text = extractPdfText(pdfPath, { engine: 'pymupdf' })
  assert.match(text, /山城/)
  assert.match(text, /320/)

  const { rows } = parseSchoolRows(text)
  const bySchool = Object.fromEntries(rows.map((r) => [r.school_name, r]))
  assert.ok(bySchool['山城'], `山城 が抽出できていない: ${text}`)
  assert.equal(bySchool['山城'].capacity, 320)
  assert.equal(bySchool['山城'].admitted, 224)
  assert.equal(bySchool['山城'].ratio, 1.34)
  assert.ok(bySchool['鴨沂'], '鴨沂 が抽出できていない')
  assert.equal(bySchool['鴨沂'].capacity, 240)
})

test('parseSchoolRows: --anchor相当のオプションで「高等学校」付きフルネームも学校名アンカーになる', () => {
  const text = [
    '見出し 学校名 学科等名 募集定員',
    '架空第一高等学校      普通科      100  80  90  88  78  1.13',
  ].join('\n')
  const { rows } = parseSchoolRows(text, {
    startMarker: '学校名',
    anchor: '[一-龠ぁ-んァ-ヶー]{2,20}(高等学校|高校|中等教育学校)',
  })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].school_name, '架空第一高等学校')
})
