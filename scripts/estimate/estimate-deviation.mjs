#!/usr/bin/env node
/**
 * estimate-deviation.mjs — Manabi Map 独自偏差値推計スクリプト（v1f 系）
 *
 * 入力: 県の公的資料・学校公式「入試結果」ページ由来の CSV（フォーマットは README.md 参照）
 * 出力: school_deviation_values 用 INSERT SQL（stdout または --out）
 *       + 「情報募集中」（数値を作らない校）の一覧レポート（stderr）
 *
 * 3 段階フロー（docs/local/archive/v0.1.1/plan_data-acquisition-strategy.md §3.2〜3.4）:
 *   ① 学校公式「入試結果」の合格最低点がある → 式推計
 *        偏差値 = 50 + 10 × (合格最低点 − 受験者平均点) / 標準偏差
 *   ② ①が無く、志願者数と定員がある → 志願倍率ベースの参考推計
 *        倍率 r = 志願者数 / 定員。r > 1 のとき、志願者集団を正規分布とみなし
 *        合格ボーダーを下から (r−1)/r 分位点に置く:
 *        偏差値 = baseline + 10 × Φ⁻¹((r−1)/r)   （baseline 既定 50・行単位で上書き可）
 *        r ≤ 1（定員充足）は baseline をそのまま参考値とする
 *   ③ どちらも無い → 数字を作らない（SQL を出さず「情報募集中」レポートに載せる）
 *
 * provenance 原則:
 *   - 商用偏差値サイトの数値は入力に混ぜない（入力 CSV の source_url は公的資料 /
 *     学校公式のみ。スクリプトは検証用に commercial domain を拒否する）
 *   - estimate_method は「1 識別子 = 1 手法」: 本スクリプトの出力は必ず
 *     v1f_<pref>_<year>（式推計）。人手推計 v1h_* をこのスクリプトが出すことはない
 *   - 県ごとに独立発番・独立算出。他県の値の流用はしない
 *
 * 使い方:
 *   node scripts/estimate/estimate-deviation.mjs --input <csv> [--out <sql>] [--pref <slug>] [--year <n>]
 *   例: node scripts/estimate/estimate-deviation.mjs --input example-input.csv
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import process from 'node:process';

// ---------------------------------------------------------------- 設定

/** 段階①（合格最低点の式推計）のクランプ範囲 */
const STAGE1_CLAMP = [30, 75];
/** 段階②（志願倍率の参考推計）のクランプ範囲（信頼度が低いので狭める） */
const STAGE2_CLAMP = [38, 66];
/** 段階②の baseline 既定値（志願者集団の平均偏差値の仮定） */
const DEFAULT_BASELINE = 50;

/** 商用偏差値サイトの domain（source_url に混入していたら即エラー） */
const COMMERCIAL_DOMAINS = [
  'minkou.jp',
  'studysapuri.jp',
  'shingakunet.com',
  'koukou-shiken.com',
  'jyukendama',
  'manabi.st',
];

/** 必須ヘッダ列（README.md のフォーマット定義と一致させる） */
const REQUIRED_COLUMNS = ['pref', 'year', 'school_name', 'department_name'];

// ---------------------------------------------------------------- CSV パーサ（RFC4180 最小実装・依存なし）

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const src = text.replace(/^﻿/, ''); // BOM 除去
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    if (row.length > 1 || row[0] !== '') rows.push(row);
  }
  return rows;
}

// ---------------------------------------------------------------- 標準正規分布の逆関数（Acklam 近似・依存なし）

function inverseNormalCdf(p) {
  if (!(p > 0 && p < 1)) throw new RangeError(`p must be in (0,1): ${p}`);
  const a = [-39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472, 2.50662827745924];
  const b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857];
  const c = [-0.00778489400243029, -0.322396458041136, -2.40075827716184, -2.54973253934373, 4.37466414146497, 2.93816398269878];
  const d = [0.00778469570904146, 0.32246712907004, 2.445134137143, 3.75440866190742];
  const pLow = 0.02425;
  let q, r;
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p <= 1 - pLow) {
    q = p - 0.5;
    r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  q = Math.sqrt(-2 * Math.log(1 - p));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
    ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

// ---------------------------------------------------------------- 推計ロジック

const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));

/** 段階①: 合格最低点 → 偏差値（式推計） */
export function estimateFromMinScore(minScore, mean, sd) {
  if (!(sd > 0)) throw new RangeError(`標準偏差は正の値が必要: ${sd}`);
  const raw = 50 + (10 * (minScore - mean)) / sd;
  return clamp(Math.round(raw), STAGE1_CLAMP);
}

/** 段階②: 志願倍率 → 偏差値（参考推計） */
export function estimateFromRatio(applicants, capacity, baseline = DEFAULT_BASELINE) {
  if (!(capacity > 0) || !(applicants >= 0)) {
    throw new RangeError(`志願者数/定員が不正: applicants=${applicants} capacity=${capacity}`);
  }
  const r = applicants / capacity;
  if (r <= 1) {
    // 定員充足: 選抜圧なし。r→1+ の極限（Φ⁻¹(0+)→−∞ → クランプ下限）と連続になるよう
    // クランプ下限を参考値とする
    return { value: STAGE2_CLAMP[0], ratio: r, saturated: true };
  }
  const p = (r - 1) / r; // 合格ボーダーの下側分位
  const raw = baseline + 10 * inverseNormalCdf(p);
  return { value: clamp(Math.round(raw), STAGE2_CLAMP), ratio: r, saturated: false };
}

// ---------------------------------------------------------------- 行の解釈

function toNum(s) {
  if (s === undefined || s === null || String(s).trim() === '') return null;
  const n = Number(String(s).trim());
  return Number.isFinite(n) ? n : null;
}

function classifyRow(rec) {
  const minScore = toNum(rec.min_score);
  const mean = toNum(rec.exam_mean);
  const sd = toNum(rec.exam_sd);
  const applicants = toNum(rec.applicants);
  const capacity = toNum(rec.capacity);
  if (minScore !== null && mean !== null && sd !== null) return 'stage1';
  if (applicants !== null && capacity !== null) return 'stage2';
  return 'stage3';
}

// ---------------------------------------------------------------- SQL 生成

const sqlStr = (s) => `'${String(s).replace(/'/g, "''")}'`;

function buildInsertValues(rec, value, note, method) {
  const school = sqlStr(rec.school_name);
  const dept = sqlStr(rec.department_name);
  return [
    `  ((select id from schools where name = ${school}),`,
    `   (select sd.id from school_departments sd join schools s on s.id = sd.school_id where s.name = ${school} and sd.name = ${dept}),`,
    `   ${value}, ${Number(rec.year)}, 'manabi_estimate', ${sqlStr(method)}, ${sqlStr(note)}, true)`,
  ].join('\n');
}

// ---------------------------------------------------------------- main

function parseArgs(argv) {
  const args = { input: null, out: null, pref: null, year: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--input') args.input = argv[++i];
    else if (a === '--out') args.out = argv[++i];
    else if (a === '--pref') args.pref = argv[++i];
    else if (a === '--year') args.year = argv[++i];
    else if (a === '--help' || a === '-h') args.help = true;
    else {
      console.error(`不明な引数: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.input) {
    console.error('使い方: node estimate-deviation.mjs --input <csv> [--out <sql>] [--pref <slug>] [--year <n>]');
    process.exit(args.help ? 0 : 2);
  }

  const rows = parseCsv(readFileSync(args.input, 'utf8'));
  if (rows.length < 2) {
    console.error('CSV にデータ行がありません');
    process.exit(1);
  }
  const header = rows[0].map((h) => h.trim());
  for (const col of REQUIRED_COLUMNS) {
    if (!header.includes(col)) {
      console.error(`必須列が見つかりません: ${col}（README.md のフォーマット定義を参照）`);
      process.exit(1);
    }
  }

  const records = rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])));

  // provenance ガード: 商用 domain の source_url を拒否
  for (const rec of records) {
    const url = (rec.source_url ?? '').toLowerCase();
    for (const dom of COMMERCIAL_DOMAINS) {
      if (url.includes(dom)) {
        console.error(`商用偏差値サイトの URL が入力に混入しています（絶対禁止）: ${rec.source_url}`);
        process.exit(1);
      }
    }
  }

  // pref / year は CSV 列から取得（--pref/--year は全行一致の検証用オーバーライド）
  const prefs = new Set(records.map((r) => r.pref));
  const years = new Set(records.map((r) => r.year));
  if (prefs.size !== 1 || years.size !== 1) {
    console.error(`1 ファイル = 1 県 × 1 年度で作成してください（pref: ${[...prefs]} / year: ${[...years]}）`);
    process.exit(1);
  }
  const pref = args.pref ?? [...prefs][0];
  const year = args.year ?? [...years][0];
  if ((args.pref && args.pref !== [...prefs][0]) || (args.year && args.year !== [...years][0])) {
    console.error(`--pref/--year が CSV の内容と一致しません（CSV: ${[...prefs][0]}/${[...years][0]}）`);
    process.exit(1);
  }
  const method = `v1f_${pref}_${year}`;

  const inserts = [];
  const pending = [];

  for (const rec of records) {
    const stage = classifyRow(rec);
    if (stage === 'stage1') {
      const value = estimateFromMinScore(toNum(rec.min_score), toNum(rec.exam_mean), toNum(rec.exam_sd));
      const note = `学校公表の合格最低点（${rec.year}年度入試）から式推計（50+10×(最低点−平均点)/標準偏差）`;
      inserts.push({ sql: buildInsertValues(rec, value, note, method), src: rec.source_url });
    } else if (stage === 'stage2') {
      const baseline = toNum(rec.baseline_dev) ?? DEFAULT_BASELINE;
      const { value, ratio, saturated } = estimateFromRatio(toNum(rec.applicants), toNum(rec.capacity), baseline);
      const note = saturated
        ? `志願倍率${ratio.toFixed(2)}倍（定員充足）のため選抜圧なしとみなした参考値`
        : `志願倍率${ratio.toFixed(2)}倍と定員から推計（合格最低点非公表・参考値）`;
      inserts.push({ sql: buildInsertValues(rec, value, note, method), src: rec.source_url });
    } else {
      pending.push(rec);
    }
  }

  const lines = [
    'begin;',
    '',
    '-- =====================================================================',
    `-- school_deviation_values — ${pref} ${year} 独自推計（${method}）`,
    `-- generated by scripts/estimate/estimate-deviation.mjs from ${basename(args.input)}`,
    '--',
    "-- All values are manabi_estimate: this project's own independent estimate",
    '-- computed from official public data (prefectural board of education /',
    '-- school official admission results). No commercial ranking site data.',
    `-- 段階①=式推計 / 段階②=志願倍率参考推計 / 段階③=「情報募集中」（${pending.length} 件・SQL 非出力）`,
    '-- =====================================================================',
    '',
  ];
  if (inserts.length > 0) {
    lines.push('insert into school_deviation_values (school_id, department_id, value, year, source_type, estimate_method, note, is_active)');
    lines.push('values');
    inserts.forEach((ins, i) => {
      if (ins.src) lines.push(`  -- source: ${ins.src}`);
      lines.push(ins.sql + (i === inserts.length - 1 ? ';' : ','));
      lines.push('');
    });
  } else {
    lines.push('-- （出力対象 0 件）');
  }
  lines.push('commit;');
  const sql = lines.join('\n') + '\n';

  if (args.out) {
    writeFileSync(args.out, sql, 'utf8');
    console.error(`SQL を書き出しました: ${args.out}（insert ${inserts.length} 件）`);
  } else {
    process.stdout.write(sql);
  }

  if (pending.length > 0) {
    console.error('');
    console.error(`-- 情報募集中（数値を作らない・${pending.length} 件）:`);
    for (const rec of pending) {
      console.error(`--   ${rec.school_name} / ${rec.department_name}`);
    }
  }
}

// テストから import された場合は main を走らせない
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('estimate-deviation.mjs')) {
  main();
}
