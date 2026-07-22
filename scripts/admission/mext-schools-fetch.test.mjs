// scripts/admission/mext-schools-fetch.test.mjs
// mext-schools-fetch.mjs の純関数部分の unit test。実 HTTP は既定では叩かない
// （MEXT_FETCH_LIVE_TEST=1 の時だけ実 fetch を伴う fixture 検証を実行する）。

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import {
  parseArgs,
  normalizePrefCode,
  prefNameOf,
  validateTypes,
  parseCSV,
  filterRows,
  PREFECTURES,
} from './mext-schools-fetch.mjs';

// 佐賀 agent が実測した MEXT D1 系西日本ファイル(..._4.csv)の SHA-256
// (docs/local/west-japan-v0.4-incremental/blocks/block-6-kyushu-north/saga/sources.csv 記載)
const SAGA_MEXT_D1_SHA256 = '867dfe2f14644033d5b8c85081f8cf653ee0edfdd4d0245aba17a8beec3dc36f';

test('parseArgs: defaults', () => {
  const args = parseArgs(['--pref', '41']);
  assert.equal(args.pref, '41');
  assert.deepEqual(args.type, ['high_school']);
  assert.equal(args.outDir, 'docs/local/mext-fetch');
  assert.equal(typeof args.year, 'number');
  assert.equal(args.sleepMs, 500);
});

test('parseArgs: --type comma list and overrides', () => {
  const args = parseArgs(['--pref', '佐賀', '--type', 'high_school,kosen,chukyo,private', '--year', '2026', '--out-dir', './out', '--sleep-ms', '100']);
  assert.deepEqual(args.type, ['high_school', 'kosen', 'chukyo', 'private']);
  assert.equal(args.year, 2026);
  assert.equal(args.outDir, './out');
  assert.equal(args.sleepMs, 100);
});

test('normalizePrefCode: numeric code', () => {
  assert.equal(normalizePrefCode('41'), '41');
  assert.equal(normalizePrefCode('1'), '01');
  assert.equal(normalizePrefCode('47'), '47');
  assert.equal(normalizePrefCode('99'), null);
});

test('normalizePrefCode: kanji name with/without suffix', () => {
  assert.equal(normalizePrefCode('佐賀'), '41');
  assert.equal(normalizePrefCode('佐賀県'), '41');
  assert.equal(normalizePrefCode('京都'), '26');
  assert.equal(normalizePrefCode('京都府'), '26');
  assert.equal(normalizePrefCode('東京'), '13');
  assert.equal(normalizePrefCode('東京都'), '13');
  assert.equal(normalizePrefCode('北海道'), '01');
  assert.equal(normalizePrefCode('存在しない県'), null);
});

test('PREFECTURES: covers all 47 codes 01-47 with no duplicates', () => {
  assert.equal(PREFECTURES.length, 47);
  const codes = new Set(PREFECTURES.map(([c]) => c));
  assert.equal(codes.size, 47);
  for (let i = 1; i <= 47; i++) assert.ok(codes.has(String(i).padStart(2, '0')));
});

test('prefNameOf: round trips with normalizePrefCode', () => {
  assert.equal(prefNameOf('41'), '佐賀');
  assert.equal(prefNameOf('13'), '東京');
  assert.equal(prefNameOf('99'), null);
});

test('validateTypes: default kind when only private given', () => {
  const { kinds, private: priv } = validateTypes(['private']);
  assert.deepEqual(kinds, ['high_school']);
  assert.equal(priv, true);
});

test('validateTypes: mixed kinds plus private modifier', () => {
  const { kinds, private: priv } = validateTypes(['high_school', 'kosen', 'chukyo', 'private']);
  assert.deepEqual(kinds, ['high_school', 'kosen', 'chukyo']);
  assert.equal(priv, true);
});

test('validateTypes: rejects unknown token', () => {
  assert.throws(() => validateTypes(['high_school', 'bogus']), /unknown --type token/);
});

test('parseCSV: handles quoted multiline fields and escaped quotes', () => {
  const text = 'a,b,c\n"line1\nline2","quote""d",plain\n';
  const rows = parseCSV(text);
  assert.deepEqual(rows[0], ['a', 'b', 'c']);
  assert.deepEqual(rows[1], ['line1\nline2', 'quote"d', 'plain']);
});

test('filterRows: matches kind prefix and pref code boundary', () => {
  const rows = [
    ['title'],
    ['header'],
    ['D141290000018', 'D1(高校)', '41(佐賀)', '2(公)', '1(本)', '佐賀県立佐賀西高等学校'],
    ['D142290000099', 'D1(高校)', '42(長崎)', '2(公)', '1(本)', '長崎県立某高等学校'],
    ['D241290000011', 'D2(中等)', '41(佐賀)', '2(公)', '1(本)', '佐賀県立某中等教育学校'],
    ['G141290000022', 'G1(高専)', '41(佐賀)', '1(国)', '1(本)', '佐賀高専'],
    ['D141490000033', 'D1(高校)', '414(架空)', '2(公)', '1(本)', '境界誤検出防止用ダミー'],
  ];
  const highSchoolOnly = filterRows(rows, '41', ['D1']);
  assert.equal(highSchoolOnly.length, 1);
  assert.equal(highSchoolOnly[0][5], '佐賀県立佐賀西高等学校');

  const highAndChukyo = filterRows(rows, '41', ['D1', 'D2']);
  assert.equal(highAndChukyo.length, 2);

  const kosenOnly = filterRows(rows, '41', ['G1']);
  assert.equal(kosenOnly.length, 1);
  assert.equal(kosenOnly[0][5], '佐賀高専');
});

test('live: MEXT D1 west-japan file sha256 matches saga agent fixture (skipped without MEXT_FETCH_LIVE_TEST=1)', async (t) => {
  if (!process.env.MEXT_FETCH_LIVE_TEST) {
    t.skip('set MEXT_FETCH_LIVE_TEST=1 to run the real network fixture check');
    return;
  }
  const res = await fetch('https://www.mext.go.jp/content/20260529-mxt_chousa01-000011635_4.csv');
  const buf = Buffer.from(await res.arrayBuffer());
  const sha256 = createHash('sha256').update(buf).digest('hex');
  assert.equal(sha256, SAGA_MEXT_D1_SHA256);
});
