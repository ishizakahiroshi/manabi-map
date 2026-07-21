// scripts/admission/official-fetch.test.mjs
// official-fetch.mjs の純関数部分の unit test。実 HTTP は叩かない。

import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseArgs, urlKey, sha256Buf } from './official-fetch.mjs';

test('parseArgs: single URL with --out', () => {
  const args = parseArgs(['https://example.com/a.pdf', '--out', './raw/a.pdf']);
  assert.deepEqual(args.urls, ['https://example.com/a.pdf']);
  assert.equal(args.out, './raw/a.pdf');
  assert.equal(args.cacheDir, null);
  assert.equal(args.sleepMs, 500);
});

test('parseArgs: batch mode with --list and --cache-dir', () => {
  const args = parseArgs(['--list', 'urls.txt', '--cache-dir', './verify-cache', '--sleep-ms', '800']);
  assert.equal(args.list, 'urls.txt');
  assert.equal(args.cacheDir, './verify-cache');
  assert.equal(args.sleepMs, 800);
  assert.deepEqual(args.urls, []);
});

test('parseArgs: multiple positional URLs', () => {
  const args = parseArgs(['https://a.example/x', 'https://b.example/y', '--sleep-ms', '200']);
  assert.deepEqual(args.urls, ['https://a.example/x', 'https://b.example/y']);
  assert.equal(args.sleepMs, 200);
});

test('urlKey: deterministic sha1-based cache key', () => {
  const k1 = urlKey('https://example.com/a');
  const k2 = urlKey('https://example.com/a');
  const k3 = urlKey('https://example.com/b');
  assert.equal(k1, k2, 'same URL produces same key');
  assert.notEqual(k1, k3, 'different URL produces different key');
  assert.match(k1, /^[0-9a-f]{40}$/, 'sha1 hex string');
});

test('sha256Buf: known vector', () => {
  const empty = sha256Buf(Buffer.from(''));
  assert.equal(empty, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  const abc = sha256Buf(Buffer.from('abc'));
  assert.equal(abc, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
