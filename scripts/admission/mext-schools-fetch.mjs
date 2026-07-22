#!/usr/bin/env node
/**
 * MEXT（文部科学省）学校基本調査 D1 系「学校コード一覧」CSV から、都道府県別の学校リストを
 * 一括取得して UTF-8 CSV + manifest.json に落とす foundation tool（manabi-map v0.4 Block 5-7）。
 *
 * 背景: 佐賀県 agent が本 CSV を cp932→UTF-8 で取得し、母集団 legal 41 校（公立32+私立9）を
 * 確定した実績がある（docs/local/west-japan-v0.4-incremental/blocks/block-6-kyushu-north/saga/
 * schools-candidate-source.tsv）。この手順を全県で使える tool として汎用化したもの。
 *
 * MEXT の「文部科学省 学校コード一覧」は 1 本の全国 CSV ではなく、地域ブロックごとに
 * 複数ファイルへ分割配布されている（本 tool が実測確認した2026-05-20時点の構成）:
 *   - `..._2.csv`: 都道府県コード 01(北海道)〜24(三重) を収録（A1〜E1 各種学校種を含む）
 *   - `..._4.csv`: 都道府県コード 25(滋賀)〜47(沖縄) を収録（同上）
 *   - `..._6.csv`: 大学(F1)/短大(F2)/高専(G1) の全国一覧（都道府県コードで横断フィルタ）
 * 上記 2 ファイルのいずれも 学校コード先頭 `D1` が高校、`D2` が中等教育学校（中高一貫）で、
 * 別ファイルには分かれていない（`D2` 単体 CSV は 404 実測済・D1 系ファイルに同梱されている）。
 *
 * CSV は cp932（Shift_JIS 系）で配布される。iconv-lite 等の追加依存を避けるため、
 * Node.js 標準の `TextDecoder('windows-31j')`（フルICUで既定搭載・cp932 相当）で復号する。
 *
 * Usage（都道府県コードまたは都道府県名のどちらでも指定可）:
 *   node scripts/admission/mext-schools-fetch.mjs --pref 41
 *   node scripts/admission/mext-schools-fetch.mjs --pref 佐賀
 *   node scripts/admission/mext-schools-fetch.mjs --pref 佐賀県 --type high_school
 *   node scripts/admission/mext-schools-fetch.mjs --pref 京都 --type high_school,chukyo --out-dir docs/local/mext-fetch
 *   node scripts/admission/mext-schools-fetch.mjs --pref 大阪 --type high_school,private
 *   node scripts/admission/mext-schools-fetch.mjs --pref 兵庫 --type high_school,kosen
 *   node scripts/admission/mext-schools-fetch.mjs --pref 福岡 --year 2026
 *   node scripts/admission/mext-schools-fetch.mjs --pref 長崎 --type high_school,private
 *   node scripts/admission/mext-schools-fetch.mjs --pref 大分 --type high_school,chukyo,kosen
 *   node scripts/admission/mext-schools-fetch.mjs --pref 熊本 --type high_school
 *   node scripts/admission/mext-schools-fetch.mjs --pref 宮崎 --type high_school,private
 *   node scripts/admission/mext-schools-fetch.mjs --pref 鹿児島 --type high_school,chukyo
 *   node scripts/admission/mext-schools-fetch.mjs --pref 沖縄 --type high_school,kosen,private
 *
 * --type（カンマ区切り・複数指定可。既定は high_school のみ）:
 *   high_school … 学校コード `D1` 高校（本タイプのみ指定時が既定）
 *   chukyo      … 学校コード `D2` 中等教育学校（同一ファイルに同梱）
 *   kosen       … 学校コード `G1` 高専（全国一覧ファイルから都道府県で絞り込み）
 *   private     … 上記で選ばれた行を設置区分=私立のみへ絞り込む修飾子（単独指定時は high_school 前提）
 *
 * 出力（--out-dir 既定 `docs/local/mext-fetch/`）:
 *   <out-dir>/mext-<pref-code>-<type...>-<year>.csv … UTF-8 CSV（RFC4180・見出し行あり）
 *   <out-dir>/mext-<pref-code>-manifest.json         … SHA-256・行数・取得日時・source URL 等
 *
 * 本 tool は DB へ接続しない。生成 CSV の投入判断・SQL 化は別工程（例: gen-admission-v2.mjs 等）が担う。
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fetchWithRetry, sha256Buf } from './official-fetch.mjs';

// 2026-05-20 時点で実測した MEXT content の日付トークン。MEXT が定期更新で
// URL を差し替えた場合は --source-date で上書きするか、この既定値を更新する。
const DEFAULT_SOURCE_DATE = '20260529';
const CONTENT_ID = 'mxt_chousa01-000011635';
const SLEEP_MS = 500;

function mextUrl(sourceDate, suffix) {
  return `https://www.mext.go.jp/content/${sourceDate}-${CONTENT_ID}${suffix}.csv`;
}

// 都道府県コード⇔名称（MEXT CSV の都道府県番号ラベルは「NN(漢字)」形式・道/都/府/県の接尾辞なし）
export const PREFECTURES = [
  ['01', '北海道'], ['02', '青森'], ['03', '岩手'], ['04', '宮城'], ['05', '秋田'],
  ['06', '山形'], ['07', '福島'], ['08', '茨城'], ['09', '栃木'], ['10', '群馬'],
  ['11', '埼玉'], ['12', '千葉'], ['13', '東京'], ['14', '神奈川'], ['15', '新潟'],
  ['16', '富山'], ['17', '石川'], ['18', '福井'], ['19', '山梨'], ['20', '長野'],
  ['21', '岐阜'], ['22', '静岡'], ['23', '愛知'], ['24', '三重'], ['25', '滋賀'],
  ['26', '京都'], ['27', '大阪'], ['28', '兵庫'], ['29', '奈良'], ['30', '和歌山'],
  ['31', '鳥取'], ['32', '島根'], ['33', '岡山'], ['34', '広島'], ['35', '山口'],
  ['36', '徳島'], ['37', '香川'], ['38', '愛媛'], ['39', '高知'], ['40', '福岡'],
  ['41', '佐賀'], ['42', '長崎'], ['43', '熊本'], ['44', '大分'], ['45', '宮崎'],
  ['46', '鹿児島'], ['47', '沖縄'],
];

const SUFFIX_STRIP = /(都|道|府|県)$/;

/** 都道府県コード（'01'〜'47'）または都道府県名（接尾辞有無どちらも可）を 2 桁コードへ正規化する。 */
export function normalizePrefCode(input) {
  if (!input) return null;
  const s = String(input).trim();
  if (/^\d{1,2}$/.test(s)) {
    const code = s.padStart(2, '0');
    return PREFECTURES.some(([c]) => c === code) ? code : null;
  }
  const bare = s.replace(SUFFIX_STRIP, '');
  const hit = PREFECTURES.find(([, name]) => name === bare || name === s);
  return hit ? hit[0] : null;
}

export function prefNameOf(code) {
  const hit = PREFECTURES.find(([c]) => c === code);
  return hit ? hit[1] : null;
}

// D1/D2 系ファイルは地域ブロックで 2 分割配布されている（実測: 01-24 / 25-47）。
const D1_FILE_RANGES = [
  { suffix: '_2', min: 1, max: 24 },
  { suffix: '_4', min: 25, max: 47 },
];
const G_FILE_SUFFIX = '_6';

function d1FileSuffixForPref(prefCode) {
  const n = parseInt(prefCode, 10);
  const hit = D1_FILE_RANGES.find((r) => n >= r.min && n <= r.max);
  return hit ? hit.suffix : null;
}

const TYPE_TOKENS = new Set(['high_school', 'chukyo', 'kosen', 'private']);
const KIND_PREFIX = { high_school: 'D1', chukyo: 'D2', kosen: 'G1' };
const KIND_FILE_GROUP = { high_school: 'D1', chukyo: 'D1', kosen: 'G' };

export function parseArgs(argv) {
  const args = { pref: null, type: ['high_school'], year: new Date().getFullYear(), outDir: 'docs/local/mext-fetch', sourceDate: DEFAULT_SOURCE_DATE, sleepMs: SLEEP_MS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--pref') args.pref = argv[++i];
    else if (a === '--type') args.type = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--year') args.year = parseInt(argv[++i], 10);
    else if (a === '--out-dir') args.outDir = argv[++i];
    else if (a === '--source-date') args.sourceDate = argv[++i];
    else if (a === '--sleep-ms') args.sleepMs = parseInt(argv[++i], 10);
  }
  return args;
}

export function validateTypes(types) {
  const unknown = types.filter((t) => !TYPE_TOKENS.has(t));
  if (unknown.length > 0) {
    throw new Error(`unknown --type token(s): ${unknown.join(', ')} (allowed: ${[...TYPE_TOKENS].join(', ')})`);
  }
  const kindTokens = types.filter((t) => t !== 'private');
  return {
    kinds: kindTokens.length > 0 ? kindTokens : ['high_school'],
    private: types.includes('private'),
  };
}

/** RFC4180 CSV parser（引用符内の改行・エスケープ二重引用符に対応）。 */
export function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); field = ''; rows.push(row); row = []; }
    else if (c === '\r') { /* skip */ }
    else field += c;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

function decodeCp932(buf) {
  return new TextDecoder('windows-31j').decode(buf);
}

function normalizeSetter(raw) {
  if (raw?.includes('公')) return 'public';
  if (raw?.includes('私')) return 'private';
  if (raw?.includes('国')) return 'national';
  return 'unknown';
}

function normalizeBranch(raw) {
  if (raw?.includes('本')) return 'main';
  if (raw?.includes('分')) return 'branch';
  if (raw?.includes('廃')) return 'abolished';
  return 'unknown';
}

function categoryOfCode(code) {
  if (code.startsWith('D1')) return 'high_school';
  if (code.startsWith('D2')) return 'chukyo';
  if (code.startsWith('G1')) return 'kosen';
  return 'unknown';
}

const OUTPUT_HEADER = [
  'mext_code', 'category', 'school_kind_label', 'name', 'address', 'postal_code',
  'setter', 'branch_flag', 'effective_date', 'abolished_date', 'prev_survey_no', 'migrated_code',
];

function csvEscape(v) {
  const s = v ?? '';
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toOutputRow(r) {
  return {
    mext_code: r[0],
    category: categoryOfCode(r[0]),
    school_kind_label: r[1],
    name: r[5],
    address: r[6],
    postal_code: r[7],
    setter: normalizeSetter(r[3]),
    branch_flag: normalizeBranch(r[4]),
    effective_date: r[8],
    abolished_date: r[9],
    prev_survey_no: r[10],
    migrated_code: r[11],
  };
}

/** 取得済みの CSV rows（生の MEXT 行配列）から、指定 kind prefix + 都道府県コードで抽出する。 */
export function filterRows(rows, prefCode, kindPrefixes) {
  const dataRows = rows.slice(2); // row0=タイトル行, row1=見出し行
  return dataRows.filter((r) => {
    const code = r[0] || '';
    const pref = r[2] || '';
    return kindPrefixes.some((p) => code.startsWith(p)) && pref.startsWith(`${prefCode}(`);
  });
}

async function fetchAndParse(url, sleepAfter) {
  const result = await fetchWithRetry(url);
  if (sleepAfter) await new Promise((r) => setTimeout(r, sleepAfter));
  if (!result.ok) {
    throw new Error(`fetch failed: ${url} (status=${result.status} error=${result.error ?? ''})`);
  }
  const text = decodeCp932(result.body);
  return { rows: parseCSV(text), fetchMeta: { url, status: result.status, bytes: result.bytes, sha256: result.sha256, attempts: result.attempt } };
}

export async function run(args) {
  const prefCode = normalizePrefCode(args.pref);
  if (!prefCode) throw new Error(`invalid --pref: ${args.pref}`);
  const prefName = prefNameOf(prefCode);
  const { kinds, private: privateOnly } = validateTypes(args.type);

  const fileGroups = new Set(kinds.map((k) => KIND_FILE_GROUP[k]));
  const sourcesFetched = [];
  let mergedRows = [];
  const seenCodes = new Set();

  const fetchTargets = [];
  if (fileGroups.has('D1')) {
    const suffix = d1FileSuffixForPref(prefCode);
    if (!suffix) throw new Error(`no D1 source file mapped for pref ${prefCode}`);
    fetchTargets.push({ group: 'D1', url: mextUrl(args.sourceDate, suffix) });
  }
  if (fileGroups.has('G')) {
    fetchTargets.push({ group: 'G', url: mextUrl(args.sourceDate, G_FILE_SUFFIX) });
  }

  for (let i = 0; i < fetchTargets.length; i++) {
    const target = fetchTargets[i];
    const sleepAfter = i < fetchTargets.length - 1 ? args.sleepMs : 0;
    const { rows, fetchMeta } = await fetchAndParse(target.url, sleepAfter);
    sourcesFetched.push(fetchMeta);
    const kindPrefixes = kinds.filter((k) => KIND_FILE_GROUP[k] === target.group).map((k) => KIND_PREFIX[k]);
    const filtered = filterRows(rows, prefCode, kindPrefixes);
    for (const r of filtered) {
      if (!seenCodes.has(r[0])) {
        seenCodes.add(r[0]);
        mergedRows.push(r);
      }
    }
  }

  let outputRows = mergedRows.map(toOutputRow);
  if (privateOnly) outputRows = outputRows.filter((r) => r.setter === 'private');
  outputRows.sort((a, b) => a.mext_code.localeCompare(b.mext_code));

  const csvLines = [OUTPUT_HEADER.join(',')];
  for (const row of outputRows) csvLines.push(OUTPUT_HEADER.map((h) => csvEscape(row[h])).join(','));
  const csvText = csvLines.join('\r\n') + '\r\n';
  const csvBuf = Buffer.from(csvText, 'utf8');

  await mkdir(args.outDir, { recursive: true });
  const typeLabel = args.type.join('+');
  const csvPath = join(args.outDir, `mext-${prefCode}-${typeLabel}-${args.year}.csv`);
  const manifestPath = join(args.outDir, `mext-${prefCode}-manifest.json`);

  await writeFile(csvPath, csvBuf);
  const manifest = {
    pref_code: prefCode,
    pref_name: prefName,
    type: args.type,
    year: args.year,
    generated_at: new Date().toISOString(),
    row_count: outputRows.length,
    sha256: sha256Buf(csvBuf),
    output_csv: csvPath,
    sources: sourcesFetched,
  };
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  return { csvPath, manifestPath, rowCount: outputRows.length, manifest };
}

function isMain() {
  const invoked = process.argv[1] ? process.argv[1].replace(/\\/g, '/') : '';
  return import.meta.url === `file://${invoked}` || import.meta.url.endsWith(invoked);
}

if (isMain()) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.pref) {
    console.error('Usage: mext-schools-fetch.mjs --pref <code-or-name> [--type high_school,kosen,chukyo,private] [--year 2026] [--out-dir <path>]');
    process.exit(2);
  }
  run(args)
    .then((res) => {
      console.log(JSON.stringify({ ok: true, ...res, manifest: undefined }, null, 2));
    })
    .catch((err) => {
      console.error('fatal:', err.message || err);
      process.exit(1);
    });
}
