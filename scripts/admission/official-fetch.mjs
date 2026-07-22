#!/usr/bin/env node
// scripts/admission/official-fetch.mjs
//
// 教委・自治体・MEXT 等の公式 URL を rate-limit-safe に取得する共通 tool。
// Block 5-7 の各県 agent が個別に指数バックオフ実装していたのを一元化する。
//
// Usage (single):
//   node scripts/admission/official-fetch.mjs https://pref.saga.lg.jp/... --out ./raw/saga-r8.pdf
//
// Usage (batch):
//   node scripts/admission/official-fetch.mjs --list urls.txt --cache-dir ./verify-cache --sleep-ms 800
//
// 出力:
//   --out 指定時: 単一 URL の response body をそのパスへ保存
//   --cache-dir 指定時: sha1(url).bin と .meta.json を書き出す
//   常に stderr へ 1 URL 1 行の JSON ログ (url / status / bytes / sha256 / attempt / elapsed_ms)
//
// リトライ: 5xx / ECONNRESET / タイムアウト は 3 回まで指数バックオフ (1s, 2s, 4s)
// politeness: 連続 fetch 間で --sleep-ms (既定 500ms) スリープ

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const UA = 'manabi-map-official-fetch/1.0 (+https://manabi-map.app; contact: hello@manabi-map.app)';
const DEFAULT_SLEEP_MS = 500;
const MAX_RETRIES = 3;
const TIMEOUT_MS = 30000;

function parseArgs(argv) {
  const args = { urls: [], out: null, cacheDir: null, list: null, sleepMs: DEFAULT_SLEEP_MS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') args.out = argv[++i];
    else if (a === '--cache-dir') args.cacheDir = argv[++i];
    else if (a === '--list') args.list = argv[++i];
    else if (a === '--sleep-ms') args.sleepMs = parseInt(argv[++i], 10);
    else if (!a.startsWith('--')) args.urls.push(a);
  }
  return args;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function sha256Buf(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function urlKey(url) {
  return createHash('sha1').update(url).digest('hex');
}

async function fetchWithRetry(url) {
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    const started = Date.now();
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept': '*/*' },
        signal: ac.signal,
        redirect: 'follow',
      });
      clearTimeout(timer);
      if (res.status >= 500) {
        lastErr = new Error(`http_${res.status}`);
        if (attempt < MAX_RETRIES) {
          const backoff = 1000 * Math.pow(2, attempt - 1);
          await sleep(backoff);
          continue;
        }
        return { ok: false, status: res.status, attempt, elapsedMs: Date.now() - started, error: lastErr.message };
      }
      const buf = Buffer.from(await res.arrayBuffer());
      return {
        ok: res.ok,
        status: res.status,
        attempt,
        elapsedMs: Date.now() - started,
        bytes: buf.length,
        sha256: sha256Buf(buf),
        contentType: res.headers.get('content-type') || '',
        finalUrl: res.url,
        body: buf,
      };
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (attempt < MAX_RETRIES) {
        const backoff = 1000 * Math.pow(2, attempt - 1);
        await sleep(backoff);
        continue;
      }
      return { ok: false, status: 0, attempt, elapsedMs: Date.now() - started, error: String(err.message || err) };
    }
  }
  return { ok: false, status: 0, attempt: MAX_RETRIES, elapsedMs: 0, error: String(lastErr) };
}

async function saveResult(url, result, opts) {
  if (opts.out) {
    await mkdir(dirname(opts.out), { recursive: true });
    await writeFile(opts.out, result.body);
  }
  if (opts.cacheDir) {
    await mkdir(opts.cacheDir, { recursive: true });
    const key = urlKey(url);
    await writeFile(join(opts.cacheDir, `${key}.bin`), result.body);
    const meta = {
      url,
      final_url: result.finalUrl,
      status: result.status,
      content_type: result.contentType,
      bytes: result.bytes,
      sha256: result.sha256,
      attempts: result.attempt,
      elapsed_ms: result.elapsedMs,
      fetched_at: new Date().toISOString(),
    };
    await writeFile(join(opts.cacheDir, `${key}.meta.json`), JSON.stringify(meta, null, 2) + '\n');
  }
}

async function loadUrls(args) {
  if (args.list) {
    const text = await readFile(args.list, 'utf8');
    return text.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'));
  }
  return args.urls;
}

function logLine(url, result) {
  const rec = {
    url,
    status: result.status,
    attempt: result.attempt,
    elapsed_ms: result.elapsedMs,
    bytes: result.bytes ?? 0,
    sha256: result.sha256 ?? '',
  };
  if (!result.ok) rec.error = result.error;
  process.stderr.write(JSON.stringify(rec) + '\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const urls = await loadUrls(args);
  if (urls.length === 0) {
    console.error('Usage: official-fetch.mjs <url> [--out <path>] [--cache-dir <dir>] [--list <file>] [--sleep-ms 500]');
    process.exit(2);
  }
  if (urls.length > 1 && args.out) {
    console.error('--out is only valid with a single URL. Use --cache-dir for batch mode.');
    process.exit(2);
  }
  const results = [];
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const result = await fetchWithRetry(url);
    logLine(url, result);
    if (result.ok && result.body) {
      await saveResult(url, result, args);
    }
    results.push({ url, ok: result.ok, status: result.status, sha256: result.sha256 ?? null });
    if (i < urls.length - 1) await sleep(args.sleepMs);
  }
  const summary = {
    total: results.length,
    ok: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
  };
  process.stdout.write(JSON.stringify({ summary, results }, null, 2) + '\n');
  process.exit(summary.failed > 0 ? 1 : 0);
}

// Named export for testing
export { fetchWithRetry, parseArgs, urlKey, sha256Buf };

if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  main().catch((err) => {
    console.error('fatal:', err);
    process.exit(1);
  });
}
