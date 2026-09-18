#!/usr/bin/env node
// kb-driven secrets-scan — unified scanner for layer 2 (husky) / layer 3 (CI) / layer 4 (release) / sweep
//
// 設計詳細: docs/local/secrets-scan-design/index.html
// 原則: ~/.claude/guides/reference_release-pipeline.md P10
//
// kb の表示名列 + family display + 構造 regex（パス・private IP）で公開対象ファイルをスキャン。
// 新しい watchlist テーブルは作らない（id 正典・名前派生の kb 設計を維持）。

import { readFileSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

// === Configuration ===
// KB_ROOT / FAMILY_ROOT are required env vars (no hardcoded default so this
// script can ship as portable OSS without exposing a personal directory).
// If unset, the kb/family watchlists are skipped and only structural regex
// runs. Setup (example, PowerShell):
//   $env:KB_ROOT     = 'C:/path/to/kb'
//   $env:FAMILY_ROOT = 'C:/path/to/family'
// bash/zsh:
//   export KB_ROOT=/path/to/kb
//   export FAMILY_ROOT=/path/to/family

const KB_ROOT = process.env.KB_ROOT || null;
const FAMILY_ROOT = process.env.FAMILY_ROOT || null;

// Paths exempted from scanning (substring match against the path returned by git).
// These files legitimately reference watchlist patterns by design.
const EXEMPT_PATHS = [
  'scripts/secrets-scan.mjs',
  'scripts/secrets-scan.',
  '.husky/pre-commit',
  '.github/workflows/secrets-scan',
  'docs/local/',
  // 総務省「全国地方公共団体コード」由来の公的データ専用ディレクトリ
  // （docs/local/convert-soumu-codes.py の生成物のみを置く契約）。
  // 市区町村名・かなが watchlist の短い needle（人名かな 2 文字等）と
  // 偶然部分一致して誤検知するため除外する（2026-08-04・実例: かつうらちょう/さくら市/熊谷市）。
  //
  // repo-doctor: exempt-tracked-ok
  // このディレクトリは追跡したまま除外するのが正しい。中身は公開前提の公的データで、
  // 「gitignore されているから除外している」型ではないため（2026-09-11 追記）。
  // 他リポで「除外しているのに追跡されている」= 検査の穴だった事例があり、
  // repo-doctor がそれを ERROR で拾う。この宣言が無いとここも誤検知で落ちる。
  'web/data/',
];

// === Watchlist needle minimum length ===
// kb / family 由来の needle は「名前」であって形ではない。短いものは中身のない部分一致になる。
// とくに非 ASCII（日本語）の 2 文字は、下の境界規則（SHORT_NEEDLE_MAX）でも救えない。
// 境界規則は前後が `[A-Za-z0-9]` でないことを要求するが、日本語の散文では前後も日本語なので
// 条件が常に成立し、素の部分文字列一致へ退化する。
//
// 実測（2026-09-18・KB_ROOT を設定した環境）: watchlist の一致は追跡 248 ファイルでも
// 履歴 1085 blob でも 2 文字の needle 1 件だけで、それは日本語の散文
// （`scripts/admission/official-fetch.mjs:18`）への誤検知だった。3 文字以上の needle は 1 件も当たっていない。
//
// 3 に置く理由は 4 との差にある。4 文字は日本語の氏名がちょうど収まる長さで、現行の watchlist でも
// people.name の 4 文字が 16 件ある。4 を下限にすると最も価値の高い検知をまとめて捨てることになる。
// 誤検知が観測された層だけを外し、実在の氏名が並ぶ層は残す線が 3。
//
// この下限は watchlist（名前）にだけ当てる。構造 regex（メール / パス / IP / トークン）には当てない。
// あれは長さではなく形で判定する検査で、短いから曖昧になるという性質を持たない。
const MIN_NEEDLE_LEN = 3;
const MAX_FILE_SIZE = 1024 * 1024;

// === History scan limits ===
// execFileSync の既定 maxBuffer は 1 MiB で、履歴のオブジェクト一覧は容易に超えるため明示する。
const GIT_LIST_MAX_BUFFER = 256 * 1024 * 1024;
// `git cat-file --batch` へ 1 回に渡す blob の合計サイズの目安（超えたら次の呼び出しへ分ける）。
// 履歴が伸びてもメモリが線形に増えないようにするための区切りで、検査内容には影響しない。
const HISTORY_BATCH_BYTES = 8 * 1024 * 1024;

// === Public-email allowlist ===
// メールアドレスは構造 regex で全件検知し、「公開する前提のアドレス」だけをここで通す。
// 非公開アドレスそのものは絶対にここへ書かない（allowlist 方式なら書かずに防げる）。
const ALLOWED_EMAILS = [
  'ishizakahiroshi.dev@gmail.com', // 公開コミット名義・package manifest 用
];
const ALLOWED_EMAIL_DOMAINS = [
  'manabi-map.app',            // サービスの公開窓口（hello@ / takedown@ / sns@ 等）
  'users.noreply.github.com',  // GitHub の noreply
  'anthropic.com',             // AI コミット footer（Co-Authored-By）
  'example.com',               // ドキュメントの例示用
  'example.net',               // ドキュメントの例示用（RFC 2606 予約）
  'example.org',               // ドキュメントの例示用（RFC 2606 予約）
];

// 一致した値そのものはレポートへ出さない。
// このレポートは CI のログと端末のスクロールバックに残り、どちらも保持される。
// 検知した秘密をそこへ書き出しては、走査器自身が漏洩経路になる。
// 突き合わせに要る情報（長さ・先頭末尾 1 文字）だけ残し、中身は file:line を開いて確認させる。
// Do not print the matched value. This report lands in CI logs and terminal scrollback,
// both retained; writing a detected secret there makes the scanner its own leak path.
function maskMatch(matched) {
  const s = String(matched);
  if (s.length <= 2) return `<${s.length} chars, masked>`;
  return `${s[0]}...${s[s.length - 1]} <${s.length} chars, masked>`;
}

function isAllowedEmail(matched) {
  const email = matched.toLowerCase();
  if (ALLOWED_EMAILS.includes(email)) return true;
  const domain = email.split('@')[1] || '';
  return ALLOWED_EMAIL_DOMAINS.some(d => domain === d || domain.endsWith('.' + d));
}

const BINARY_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.ico',
  '.pdf', '.zip', '.tar', '.gz', '.bz2', '.xz', '.7z', '.rar',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.o', '.obj',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp3', '.mp4', '.wav', '.avi', '.mov', '.webm', '.m4a',
]);

// Always skip these regardless of mode (huge text files that aren't authored)
const SKIP_FILENAMES = new Set([
  'pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'Cargo.lock',
  'go.sum', 'poetry.lock', 'Pipfile.lock',
]);

// === Minimal CSV parser (RFC 4180 subset with quoted fields) ===

function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuote = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuote) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { inQuote = false; }
      } else {
        field += c;
      }
    } else {
      if (c === '"') inQuote = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c === '\r') { /* ignore */ }
      else { field += c; }
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

// === Watchlist loading ===

// Some kb names include a parenthetical category/disambiguator
// (e.g. "ProductName(Purpose)" / "ServiceName(CompanyName)"). For matching purposes
// we want BOTH the full string AND the bare name before the paren,
// so a leak of just "ProductName" (without paren) is still caught.
// 長さの選別はここでは行わない。呼び出し側が MIN_NEEDLE_LEN で落とし、落とした分を数える
// （黙って落とすと watchlist が縮んだことが誰にも見えなくなるため）。
function expandNameVariants(value) {
  const variants = new Set();
  if (value) variants.add(value);
  // Strip both half-width (...) and full-width （...） suffix
  const stripped = value.replace(/[(（].*$/, '').trim();
  if (stripped) variants.add(stripped);
  return [...variants];
}

function loadKbWatchlist(kbRoot) {
  if (!kbRoot || !existsSync(kbRoot)) {
    return { available: false, items: [], shortSkipped: [] };
  }
  const items = [];
  const shortSkipped = new Set();
  const specs = [
    { file: 'companies.csv',    col: 3, label: 'companies.short_name' },
    { file: 'people.csv',       col: 1, label: 'people.name' },
    { file: 'servers.csv',      col: 1, label: 'servers.host' },
    { file: 'applications.csv', col: 1, label: 'applications.name' },
  ];
  for (const { file, col, label } of specs) {
    const path = join(kbRoot, file);
    if (!existsSync(path)) continue;
    try {
      const rows = parseCSV(readFileSync(path, 'utf8'));
      for (let i = 1; i < rows.length; i++) {
        const value = (rows[i][col] || '').trim();
        for (const variant of expandNameVariants(value)) {
          if (variant.length < MIN_NEEDLE_LEN) { shortSkipped.add(variant); continue; }
          items.push({ needle: variant, source: `kb/${file}:${label}` });
        }
      }
    } catch (e) {
      console.error(`WARN: failed to parse ${path}: ${e.message}`);
    }
  }
  return { available: true, items, shortSkipped: [...shortSkipped] };
}

function loadFamilyWatchlist(familyRoot) {
  if (!familyRoot) {
    return { available: false, items: [], shortSkipped: [] };
  }
  const path = join(familyRoot, 'people.csv');
  if (!existsSync(path)) {
    return { available: false, items: [], shortSkipped: [] };
  }
  const items = [];
  const shortSkipped = new Set();
  const add = (needle, source) => {
    if (!needle) return;
    if (needle.length < MIN_NEEDLE_LEN) { shortSkipped.add(needle); return; }
    items.push({ needle, source });
  };
  try {
    const rows = parseCSV(readFileSync(path, 'utf8'));
    for (let i = 1; i < rows.length; i++) {
      const familyName = (rows[i][1] || '').trim();
      const givenName  = (rows[i][2] || '').trim();
      add(familyName, 'family/people.csv:family_name');
      add(givenName,  'family/people.csv:given_name');
      if (familyName && givenName) {
        add(familyName + givenName, 'family/people.csv:full_name');
      }
    }
  } catch (e) {
    console.error(`WARN: failed to parse ${path}: ${e.message}`);
  }
  return { available: true, items, shortSkipped: [...shortSkipped] };
}

// === Structural patterns (regex) ===

function getStructuralPatterns() {
  return [
    {
      // `Program Files` / `Windows` は共有システムパスで個人情報ではないため対象外。
      // `Users` / `dev` のみ personal-path として検知する。
      name: 'Windows absolute path',
      regex: /[A-Za-z]:[\\/](?:Users|dev)[\\/]/g,
      suggestion: '個人パスを削除またはプレースホルダ化 / Remove personal absolute path or use a placeholder',
    },
    {
      name: 'POSIX home path',
      regex: /\/(?:Users|home)\/[a-zA-Z0-9_.-]+\//g,
      suggestion: 'ホームパスを ~/ などにマスク / Mask home path with `~/`',
    },
    {
      // loopback (127.0.0.1) は共有定数で個人情報ではなく、技術文書での例示にも頻出するため対象外。
      // RFC1918 (10/8, 172.16/12, 192.168/16) のみを内部 LAN トポロジー漏洩として検知する。
      name: 'Private IPv4 (RFC1918)',
      regex: /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b/g,
      suggestion: '内部 IP を一般化または削除 / Generalize or remove internal IP',
    },
    {
      // allowlist（ALLOWED_EMAILS / ALLOWED_EMAIL_DOMAINS）に無いメールアドレスは全件ブロック。
      // 個人アドレスを watchlist に書かずに検知するための allowlist 方式。
      name: 'Email address (not on public allowlist)',
      regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9][A-Za-z0-9.-]*\.[A-Za-z]{2,}\b/g,
      allow: isAllowedEmail,
      suggestion: '非公開メールを削除 / 公開前提のアドレスなら ALLOWED_EMAILS(_DOMAINS) へ追加',
    },
  ];
}

// === File listing per mode ===

// git は既定で非 ASCII を含むパスをダブルクォートと C エスケープで包んで返す（core.quotepath）。
// 包まれたパスは拡張子判定（`.pdf"` で終わる）も読み取りも通らないため、`-z` で生のパスを受け取る。
// 2026-09-18 に、日本語名の PDF 2 本がこの経路で黙って未走査になっていたのを検知して修正した。
function gitPathList(args) {
  return execFileSync('git', [...args, '-z'], { encoding: 'utf8', maxBuffer: GIT_LIST_MAX_BUFFER })
    .split('\0').filter(Boolean);
}

function getFilesByMode(mode) {
  try {
    switch (mode) {
      case 'staged':
        return gitPathList(['diff', '--cached', '--name-only', '--diff-filter=ACMR']);
      case 'files-from-diff':
        return gitPathList(['diff', '--name-only', '--diff-filter=ACMR', 'HEAD']);
      case 'all-tracked':
        return gitPathList(['ls-files']);
      case 'packaged':
        console.error('ERROR: --packaged mode not yet implemented (TODO: read npm pack output for layer 4)');
        process.exit(2);
      default:
        console.error(`ERROR: unknown mode: ${mode}`);
        process.exit(2);
    }
  } catch (e) {
    if (String(e.message || '').includes('not a git repository')) {
      console.error('ERROR: not a git repository');
      process.exit(2);
    }
    throw e;
  }
}

// === History listing (revision walk) ===
//
// 上の 3 モードはどれも「今そこにあるファイル」しか見ない。検出パターンを後から足しても、
// それ以前に削除されたファイルには一度も当たらない（実例: メールアドレスの検出パターンは、
// 当該ファイルを削除した commit の 33 分後に入った。削除しても blob は履歴に残るので取りこぼした）。
// 履歴モードは全 ref から到達できる blob を (oid, path) 単位で重複排除し、同じ検査に掛ける。
//
// 毎回全履歴を舐める（前回走査位置からの差分にはしない）。理由は 2 つ。
//   1. 差分にすると「後から足した検出器を過去へ当てる」が構造的にできなくなり、
//      上の取りこぼしを設計として再現してしまう。検出器は増えるが履歴は増えない前提を置けない。
//   2. 他の 3 モードと同じく git の出力だけから決まる（状態ファイルを持たない）ので、
//      どこで走らせても同じ結果になる。重複排除後の blob 数は commit 数ではなく
//      「これまでに存在した中身の種類」に比例するので、commit が増えても線形には増えない。

function getHistoryEntries() {
  let listed;
  try {
    // rev-list に `-z` は無いので、パスを包ませない設定を明示して渡す（上の gitPathList と同じ理由）。
    listed = execFileSync('git', ['-c', 'core.quotepath=false', 'rev-list', '--objects', '--all'], {
      encoding: 'utf8',
      maxBuffer: GIT_LIST_MAX_BUFFER,
    });
  } catch (e) {
    if (String(e.message || '').includes('not a git repository')) {
      console.error('ERROR: not a git repository');
      process.exit(2);
    }
    throw e;
  }
  // 出力は `<oid>` （commit / tag / root tree）か `<oid> <path>`（tree / blob）。
  const byOidPath = new Map();
  for (const line of listed.split('\n')) {
    const sp = line.indexOf(' ');
    if (sp < 0) continue;
    const oid = line.slice(0, sp);
    const path = line.slice(sp + 1).trim();
    if (!path) continue;
    byOidPath.set(`${oid} ${path}`, { oid, path });
  }
  const entries = [...byOidPath.values()];
  const meta = batchCheckObjects([...new Set(entries.map(e => e.oid))]);
  return entries
    .filter(e => (meta.get(e.oid) || {}).type === 'blob')
    .map(e => ({ oid: e.oid, path: e.path, size: meta.get(e.oid).size }));
}

function batchCheckObjects(oids) {
  const meta = new Map();
  if (oids.length === 0) return meta;
  const out = execFileSync('git', ['cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], {
    input: oids.join('\n') + '\n',
    encoding: 'utf8',
    maxBuffer: GIT_LIST_MAX_BUFFER,
  });
  for (const line of out.split('\n')) {
    const [oid, type, size] = line.trim().split(' ');
    if (!oid || !type || type === 'missing') continue;
    meta.set(oid, { type, size: Number(size) });
  }
  return meta;
}

// `git cat-file --batch` の出力は `<oid> <type> <size>\n<本体><LF>` の連結。
// blob は UTF-8 とは限らないので Buffer のまま受け取り、呼び出し側で判定する。
function readBlobs(oids) {
  const contents = new Map();
  if (oids.length === 0) return contents;
  // encoding を指定しない = stdout を Buffer のまま受け取る（`encoding: 'buffer'` は input 側で弾かれる）。
  const out = execFileSync('git', ['cat-file', '--batch'], {
    input: oids.join('\n') + '\n',
    maxBuffer: GIT_LIST_MAX_BUFFER,
  });
  let pos = 0;
  while (pos < out.length) {
    const nl = out.indexOf(0x0a, pos);
    if (nl < 0) break;
    const header = out.toString('utf8', pos, nl).split(' ');
    pos = nl + 1;
    if (header.length < 3) continue; // `<oid> missing`
    const size = Number(header[2]);
    contents.set(header[0], out.subarray(pos, pos + size));
    pos += size + 1; // 本体の後ろの LF
  }
  return contents;
}

// === Inline exempt directive ===
// Lines containing `secrets-scan: allow` are exempted.
//   `secrets-scan: allow`            -> allow all hits on this line
//   `secrets-scan: allow Nextcloud`  -> allow only matches whose needle
//                                       contains (case-insensitive) "Nextcloud"
// Multiple directives per line are OR'd.
function isAllowedByDirective(line, matchedNeedle) {
  const re = /secrets-scan:\s*allow(?:\s+([^\s\->]+))?/gi;
  let m;
  while ((m = re.exec(line)) !== null) {
    if (!m[1]) return true; // bare "allow" = whole-line exempt
    const target = m[1].toLowerCase();
    const needle = matchedNeedle.toLowerCase();
    if (needle.includes(target) || target.includes(needle)) return true;
  }
  return false;
}

// === Exemption / binary checks ===

function isExempt(path) {
  // normalize separator for substring matching
  const p = path.replace(/\\/g, '/');
  return EXEMPT_PATHS.some(ex => p.includes(ex));
}

function isBinary(path) {
  const lower = path.toLowerCase();
  for (const ext of BINARY_EXTS) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}

function isSkipFilename(path) {
  const base = path.replace(/\\/g, '/').split('/').pop();
  return SKIP_FILENAMES.has(base);
}

// === Scanning ===

// === Short-needle boundary rule ===
// 2 文字以下の watchlist 名は、そのままの部分文字列一致だと乱数めいた文字列に
// 無数に当たる（実例: YouTube の動画 ID `5vudjnGWFKc` の中の `WF` が kb のアプリ名に
// 一致して push がブロックされた・2026-08-30）。短い needle は「前後が英数字でない」
// ときだけ一致させる。実際の言及（`WF の設定` / `（WF）` / 行頭・行末）は引き続き当たり、
// 検知の網は落ちない。3 文字以上は従来どおり素の部分文字列一致。
//
// 2026-09-18 に MIN_NEEDLE_LEN を 3 へ上げたので、2 文字以下の needle は現在そもそも読み込まれない
// （この分岐は今は通らない）。残してあるのは、境界規則が下限を下げたときの受け皿であり、
// かつ上の実例が「短い needle は素の部分一致では使い物にならない」根拠そのものだから。
// 境界規則だけでは非 ASCII の 2 文字を救えない（前後が日本語だと条件が常に成立する）ことが、
// MIN_NEEDLE_LEN を別に設けた理由。
const SHORT_NEEDLE_MAX = 2;
const ALNUM = /[A-Za-z0-9]/;

function matchesNeedle(line, needle) {
  if (needle.length > SHORT_NEEDLE_MAX) return line.includes(needle);
  let from = 0;
  for (;;) {
    const i = line.indexOf(needle, from);
    if (i < 0) return false;
    const before = i > 0 ? line[i - 1] : '';
    const after = line[i + needle.length] || '';
    if (!ALNUM.test(before) && !ALNUM.test(after)) return true;
    from = i + 1;
  }
}

// === Unscanned reporting ===
// 読めなかった・大きすぎた対象を黙って捨てると「異常なし」に化ける。
// scanFile / scanHistory は hits と一緒に「走査できなかったもの」を返し、
// 呼び出し側が件数として報告する（--block では hits と同じく非 0 終了の理由になる）。

function firstErrorLine(e) {
  // git のエラー文に入るのはコマンド行と stderr だけでファイル本文は入らないが、
  // 想定外の長文をそのまま出さないよう 1 行に切り詰める。
  return String((e && e.message) || e).split('\n')[0].slice(0, 200);
}

function scanFile(path, needleMap, structuralPatterns, mode) {
  let content;
  try {
    content = mode === 'staged'
      ? execFileSync('git', ['show', `:${path}`], { encoding: 'utf8', maxBuffer: MAX_FILE_SIZE * 4 })
      : readFileSync(path, 'utf8');
  } catch (e) {
    return { hits: [], unscanned: { file: path, reason: 'read-failed', detail: firstErrorLine(e) } };
  }
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_FILE_SIZE) {
    return {
      hits: [],
      unscanned: { file: path, reason: 'size-limit', detail: `${bytes} bytes > ${MAX_FILE_SIZE} bytes` },
    };
  }
  return { hits: scanContent(path, content, needleMap, structuralPatterns), unscanned: null };
}

// 履歴モードの走査。blob を (oid, path) 単位で読み、ファイルモードと同じ検査を当てる。
function scanHistory(entries, needleMap, structuralPatterns) {
  const hits = [];
  const unscanned = [];
  let pending = [];
  let pendingBytes = 0;

  const flush = () => {
    if (pending.length === 0) return;
    const contents = readBlobs([...new Set(pending.map(e => e.oid))]);
    for (const entry of pending) {
      const buf = contents.get(entry.oid);
      if (!buf) {
        unscanned.push({
          file: entry.path, blob: entry.oid,
          reason: 'read-failed', detail: 'git cat-file returned no content',
        });
        continue;
      }
      if (buf.includes(0)) {
        // 拡張子で判定できないバイナリ（履歴には拡張子なしのものも残る）。
        unscanned.push({
          file: entry.path, blob: entry.oid,
          reason: 'binary-content', detail: 'NUL byte present (not scannable as text)',
        });
        continue;
      }
      hits.push(...scanContent(entry.path, buf.toString('utf8'), needleMap, structuralPatterns, { blob: entry.oid }));
    }
    pending = [];
    pendingBytes = 0;
  };

  for (const entry of entries) {
    if (entry.size > MAX_FILE_SIZE) {
      unscanned.push({
        file: entry.path, blob: entry.oid,
        reason: 'size-limit', detail: `${entry.size} bytes > ${MAX_FILE_SIZE} bytes`,
      });
      continue;
    }
    pending.push(entry);
    pendingBytes += entry.size;
    if (pendingBytes >= HISTORY_BATCH_BYTES) flush();
  }
  flush();

  return { hits, unscanned };
}

function scanContent(path, content, needleMap, structuralPatterns, extra = {}) {
  const hits = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // watchlist needles (substring match)
    for (const [needle, source] of needleMap) {
      if (matchesNeedle(line, needle) && !isAllowedByDirective(line, needle)) {
        hits.push({
          file: path,
          lineNumber: i + 1,
          matched: needle,
          source,
          kind: 'watchlist',
          suggestion: '一般化（kb 由来名称を抽象化）/ Generalize (mask kb-derived name)',
          ...extra,
        });
      }
    }

    // structural patterns
    for (const { name, regex, suggestion, allow } of structuralPatterns) {
      regex.lastIndex = 0;
      let m;
      while ((m = regex.exec(line)) !== null) {
        if (!(allow && allow(m[0])) && !isAllowedByDirective(line, m[0])) {
          hits.push({
            file: path,
            lineNumber: i + 1,
            matched: m[0],
            source: `structural: ${name}`,
            kind: 'structural',
            suggestion,
            ...extra,
          });
        }
        if (m.index === regex.lastIndex) regex.lastIndex++;
      }
    }
  }
  return hits;
}

// === Output ===

function formatHitsText(hits, mode) {
  const lines = [];
  lines.push('');
  lines.push('================================================================');
  lines.push(`BLOCKED: secrets-scan detected ${hits.length} match(es) in scanned files.`);
  lines.push(`ブロック: スキャン対象に ${hits.length} 件の混入を検知`);
  lines.push('================================================================');
  lines.push('');
  lines.push('Matched values are masked on purpose: this report is written to CI logs and');
  lines.push('terminal scrollback, both of which are retained. Open the cited file:line yourself.');
  lines.push('一致した値は意図的に伏せている。本レポートは CI ログと端末のスクロールバックに残るため。');
  lines.push('中身は引用された file:line を自分で開いて確認すること。');
  lines.push('');
  for (const h of hits) {
    lines.push(`  ${h.file}:${h.lineNumber}`);
    lines.push(`    matched : ${maskMatch(h.matched)}`);
    lines.push(`    source  : ${h.source}`);
    if (h.blob) lines.push(`    blob    : ${h.blob}  (git log --all --oneline --find-object=${h.blob})`);
    lines.push(`    suggest : ${h.suggestion}`);
    lines.push('');
  }
  if (mode === 'history') {
    lines.push('History hits live in past commits; editing the current file does not remove them.');
    lines.push('履歴の指摘は過去の commit の中身です。現在のファイルを直しても消えません（履歴の書き換えが要ります）。');
    lines.push('');
  }
  if (mode === 'staged' || mode === 'files-from-diff') {
    lines.push('To bypass (NOT recommended): git commit --no-verify');
    lines.push('  Note: CI (layer 3) and release gate (layer 4) will run the same check.');
    lines.push('  注意: bypass しても CI（層 3）と release ゲート（層 4）で再 fail します。');
    lines.push('');
  }
  return lines.join('\n');
}

// 走査できなかった対象の報告。件数を 0 と混同させないため、hits とは別の見出しで出す。
function formatUnscannedText(unscanned) {
  const lines = [];
  lines.push('');
  lines.push('================================================================');
  lines.push(`UNSCANNED: ${unscanned.length} target(s) could not be scanned (NOT verified clean).`);
  lines.push(`未走査: ${unscanned.length} 件は走査できていません（「異常なし」ではありません）`);
  lines.push('================================================================');
  lines.push('');
  for (const u of unscanned) {
    lines.push(`  ${u.file}`);
    if (u.blob) lines.push(`    blob    : ${u.blob}`);
    lines.push(`    reason  : ${u.reason}`);
    lines.push(`    detail  : ${u.detail}`);
    lines.push('');
  }
  lines.push('Resolve by making the target scannable, or by declaring it out of scope');
  lines.push('(BINARY_EXTS / SKIP_FILENAMES / EXEMPT_PATHS in scripts/secrets-scan.mjs).');
  lines.push('走査できる形にするか、対象外であることを上記の宣言で明示してください。');
  lines.push('');
  return lines.join('\n');
}

// === Argument parsing ===

function parseArgs(argv) {
  const args = { mode: null, block: false, dryRun: false, format: 'text', help: false };
  for (const a of argv) {
    if (a === '--staged') args.mode = 'staged';
    else if (a === '--files-from-diff') args.mode = 'files-from-diff';
    else if (a === '--all-tracked') args.mode = 'all-tracked';
    else if (a === '--history') args.mode = 'history';
    else if (a === '--packaged') args.mode = 'packaged';
    else if (a === '--block') args.block = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--format=json') args.format = 'json';
    else if (a === '--format=text') args.format = 'text';
    else if (a === '-h' || a === '--help') args.help = true;
  }
  return args;
}

function showHelp() {
  process.stdout.write(`secrets-scan — kb-driven content gate for public-facing files

Usage: node scripts/secrets-scan.mjs <mode> [options]

Modes (exactly one required):
  --staged              scan files staged for commit (layer 2 / pre-commit hook)
  --files-from-diff     scan files changed since HEAD (layer 3 / CI on PR)
  --all-tracked         scan all git-tracked files (sweep / audit)
  --history             scan every blob reachable from any ref, including files
                        deleted long ago (revision walk; needs a full clone /
                        actions/checkout with fetch-depth: 0)
  --packaged            scan packaged tarball (layer 4 / release gate) [TODO]

Options:
  --block               exit 1 on any hit, or on any unscanned target (enforcement)
  --dry-run             report hits but exit 0 (use for sweep / audit)
  --format=text|json    output format (default: text)
  -h, --help            show this help

Environment (required for full coverage; unset = structural regex only):
  KB_ROOT       path to kb root containing companies.csv / people.csv / servers.csv / applications.csv
  FAMILY_ROOT   path to family CSV root containing people.csv
  Example (PowerShell): $env:KB_ROOT = 'C:/path/to/kb'
  Example (bash/zsh)  : export KB_ROOT=/path/to/kb

Exit codes:
  0  no hits and nothing unscanned, or findings but --dry-run / no --block
  1  hits or unscanned targets found with --block
  2  configuration / usage error

Unscanned targets (read failure / over 1 MiB / binary content without a known
extension) are reported separately and are never counted as "clean".

Watchlist sources:
  kb/companies.csv (short_name) / people.csv (name) /
  servers.csv (host) / applications.csv (name)
  family/people.csv (family_name, given_name, family+given)
  + structural regex (Windows absolute paths, POSIX home paths, RFC1918 IPs, emails)

Watchlist needles shorter than ${MIN_NEEDLE_LEN} characters are excluded (a 2-character name
matches almost anything, especially inside Japanese prose). The number excluded is
reported on every run; it is never silently dropped. The minimum length applies to
the name-based watchlist only — structural regex matches on shape, not length, and
is unaffected.
`);
}

// === Main ===

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) { showHelp(); process.exit(0); }
  if (!args.mode) { showHelp(); process.exit(2); }

  const kb = loadKbWatchlist(KB_ROOT);
  const family = loadFamilyWatchlist(FAMILY_ROOT);

  const warnings = [];
  if (!kb.available) {
    if (!KB_ROOT) {
      warnings.push(`WARN: KB_ROOT env var not set — kb-derived watchlist skipped, structural regex only`);
      warnings.push(`WARN: KB_ROOT env var が未設定 — kb 由来 watchlist をスキップ・構造 regex のみで継続`);
    } else {
      warnings.push(`WARN: KB_ROOT path not found: ${KB_ROOT} — kb-derived watchlist skipped`);
      warnings.push(`WARN: KB_ROOT パスが見つかりません: ${KB_ROOT} — kb 由来 watchlist をスキップ`);
    }
  }
  if (!family.available) {
    if (!FAMILY_ROOT) {
      warnings.push(`WARN: FAMILY_ROOT env var not set — family watchlist skipped`);
      warnings.push(`WARN: FAMILY_ROOT env var が未設定 — family watchlist をスキップ`);
    } else {
      warnings.push(`WARN: FAMILY_ROOT path not found: ${FAMILY_ROOT} — family watchlist skipped`);
      warnings.push(`WARN: FAMILY_ROOT パスが見つかりません: ${FAMILY_ROOT} — family watchlist をスキップ`);
    }
  }

  // 短すぎて走査対象から外した needle は、件数を必ず出す。
  // 黙って落とすと watchlist が縮んだことが誰にも見えず、「異常なし」が守備範囲の狭まった
  // 「異常なし」に化ける。未走査ファイルを別見出しで報告しているのと同じ理由。
  // 件数だけを出し、値は出さない（このレポートは CI ログとスクロールバックに残る）。
  const shortSkipped = new Set([...kb.shortSkipped, ...family.shortSkipped]);
  if (shortSkipped.size > 0) {
    warnings.push(`NOTE: ${shortSkipped.size} watchlist needle(s) under ${MIN_NEEDLE_LEN} chars excluded from scanning — NOT checked (too short to match meaningfully)`);
    warnings.push(`注意: ${MIN_NEEDLE_LEN} 文字未満の watchlist needle ${shortSkipped.size} 件は走査対象外 — 検査していません（短すぎて誤検知になるため）`);
  }

  // De-duplicate needles (a name can appear in multiple kb tables)
  const needleMap = new Map();
  for (const item of [...kb.items, ...family.items]) {
    if (!needleMap.has(item.needle)) needleMap.set(item.needle, item.source);
  }

  const structuralPatterns = getStructuralPatterns();

  const allHits = [];
  const unscanned = [];
  let totalTargets = 0;
  let candidates = 0;

  if (args.mode === 'history') {
    const allEntries = getHistoryEntries();
    const entriesToScan = allEntries.filter(e => !isExempt(e.path) && !isBinary(e.path) && !isSkipFilename(e.path));
    totalTargets = allEntries.length;
    candidates = entriesToScan.length;
    const result = scanHistory(entriesToScan, needleMap, structuralPatterns);
    allHits.push(...result.hits);
    unscanned.push(...result.unscanned);
  } else {
    const allFiles = getFilesByMode(args.mode);
    const filesToScan = allFiles.filter(f => !isExempt(f) && !isBinary(f) && !isSkipFilename(f));
    totalTargets = allFiles.length;
    candidates = filesToScan.length;
    for (const file of filesToScan) {
      const result = scanFile(file, needleMap, structuralPatterns, args.mode);
      allHits.push(...result.hits);
      if (result.unscanned) unscanned.push(result.unscanned);
    }
  }

  // 走査できたものだけを「走査済み」と数える（未走査は下の unscanned で別に報告する）。
  const scannedCount = candidates - unscanned.length;

  for (const w of warnings) console.error(w);

  if (args.format === 'json') {
    process.stdout.write(JSON.stringify({
      mode: args.mode,
      scanned: scannedCount,
      total_files: totalTargets,
      exempt_or_skipped: totalTargets - candidates,
      kb_needles: kb.items.length,
      family_needles: family.items.length,
      short_needles_excluded: shortSkipped.size,
      min_needle_len: MIN_NEEDLE_LEN,
      structural_patterns: structuralPatterns.length,
      hits: allHits,
      unscanned,
      warnings,
    }, null, 2) + '\n');
  } else {
    const unit = args.mode === 'history' ? 'blobs' : 'files';
    if (allHits.length === 0 && unscanned.length === 0) {
      process.stdout.write(`OK: secrets-scan passed (scanned ${scannedCount} ${unit}; ${needleMap.size} needles + ${structuralPatterns.length} structural patterns)\n`);
      process.stdout.write(`OK: secrets-scan に問題なし\n`);
    } else {
      if (allHits.length > 0) process.stderr.write(formatHitsText(allHits, args.mode));
      if (unscanned.length > 0) process.stderr.write(formatUnscannedText(unscanned));
      process.stderr.write(`scanned ${scannedCount} ${unit} / ${allHits.length} hit(s) / ${unscanned.length} unscanned\n`);
    }
  }

  if ((allHits.length > 0 || unscanned.length > 0) && args.block && !args.dryRun) {
    process.exit(1);
  }
  process.exit(0);
}

main();
