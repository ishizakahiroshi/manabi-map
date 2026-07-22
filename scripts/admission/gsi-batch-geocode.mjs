#!/usr/bin/env node
/**
 * 国土地理院（GSI）AddressSearch API で schools-candidate.csv の座標を一括解決する。
 *
 * 元ネタ: docs/local/west-japan-v0.4-incremental/blocks/block-5-kinki-b/hyogo/_s1-resolve-coords-private.py
 * （兵庫県 私立55+国立2校向けの単発 Python スクリプト）を汎用化し、Node.js に昇格したもの。
 * 元の Python 実装は履歴として削除せず残す。
 *
 * 挙動:
 *   - schools-candidate.csv から --ownership に一致し、latitude/longitude が未設定の行だけを対象にする
 *   - 住所を NFC 正規化してから GSI AddressSearch
 *     (https://msearch.gsi.go.jp/address-search/AddressSearch?q=<address>) を叩く
 *   - exact 1 hit のときだけ lat/lng を書き戻す（6 桁小数）
 *   - 0 hit / multi-hit / address 空欄 / GSI エラー（リトライ後も失敗）は書き戻さず quarantine CSV に記録する
 *   - 既存 lat/lng がある行・対象 ownership 外の行はスキップする（複数回実行しても安全 = idempotent）
 *
 * 使い方:
 *   node scripts/admission/gsi-batch-geocode.mjs docs/local/.../hyogo/schools-candidate.csv --ownership private,national
 *   node scripts/admission/gsi-batch-geocode.mjs docs/local/.../nagasaki/schools-candidate.csv --ownership prefectural,municipal,private,national
 *   node scripts/admission/gsi-batch-geocode.mjs docs/local/.../fukuoka/schools-candidate.csv --dry-run
 *   node scripts/admission/gsi-batch-geocode.mjs <csv> --quarantine docs/local/.../coord-quarantine.csv --sleep-ms 500
 *
 * 想定件数の例: 兵庫 143 校（うち private/national 57 校を先行解決）・長崎 55 校・福岡 165 校。
 *
 * 本スクリプトは CSV の書き換えのみ行い、DB へは一切接続しない。
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const GSI_ENDPOINT = 'https://msearch.gsi.go.jp/address-search/AddressSearch?q='
const DEFAULT_OWNERSHIP = ['prefectural', 'municipal', 'private', 'national']
const QUARANTINE_HEADER = ['name', 'address', 'hit_count', 'reason', 'hits_json']
const MAX_RETRIES = 3

export function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let quoted = false
  const src = text.replace(/^﻿/, '')
  for (let i = 0; i < src.length; i++) {
    const char = src[i]
    if (quoted) {
      if (char === '"' && src[i + 1] === '"') {
        field += '"'
        i++
      } else if (char === '"') {
        quoted = false
      } else {
        field += char
      }
    } else if (char === '"') {
      quoted = true
    } else if (char === ',') {
      row.push(field)
      field = ''
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && src[i + 1] === '\n') i++
      row.push(field)
      field = ''
      if (row.length > 1 || row[0] !== '') rows.push(row)
      row = []
    } else {
      field += char
    }
  }
  if (quoted) throw new Error('CSV の引用符が閉じていません')
  if (field !== '' || row.length > 0) {
    row.push(field)
    if (row.length > 1 || row[0] !== '') rows.push(row)
  }
  return rows
}

function csvField(value) {
  const s = value == null ? '' : String(value)
  if (/[",\n\r]/.test(s)) return `"${s.replaceAll('"', '""')}"`
  return s
}

export function stringifyCsv(header, records) {
  const lines = [header.map(csvField).join(',')]
  for (const record of records) lines.push(header.map((column) => csvField(record[column])).join(','))
  return lines.join('\r\n') + '\r\n'
}

export function readCsvRecords(path) {
  const rows = parseCsv(readFileSync(path, 'utf8'))
  if (rows.length === 0) throw new Error(`${path} にデータ行がありません`)
  const header = rows[0].map((value) => value.trim())
  const records = rows.slice(1).map((row, rowIndex) => {
    if (row.length !== header.length) throw new Error(`${path}:${rowIndex + 2} の列数が不正です`)
    return Object.fromEntries(header.map((name, index) => [name, row[index] ?? '']))
  })
  return { header, records }
}

export function selectTargetRows(records, ownership) {
  const ownershipSet = new Set(ownership)
  return records.filter((row) => ownershipSet.has(row.ownership) && !(row.latitude && row.longitude))
}

async function sleep(ms) {
  if (ms <= 0) return
  await new Promise((resolve) => setTimeout(resolve, ms))
}

async function fetchGsi(address, { fetchImpl = fetch } = {}) {
  const url = GSI_ENDPOINT + encodeURIComponent(address)
  let lastError
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetchImpl(url, { headers: { 'User-Agent': 'manabi-map-gsi-batch-geocode/1.0' } })
      if (res.status >= 500 || res.status === 429) {
        lastError = new Error(`gsi_http_${res.status}`)
        await sleep(2 ** attempt * 500)
        continue
      }
      if (!res.ok) throw new Error(`gsi_http_${res.status}`)
      return await res.json()
    } catch (error) {
      lastError = error
      if (attempt < MAX_RETRIES - 1) await sleep(2 ** attempt * 500)
    }
  }
  throw lastError ?? new Error('gsi_unknown_error')
}

/**
 * 住所を GSI へ渡せる表記へ正規化する。
 *
 * MEXT 学校コード CSV の住所欄には CJK 互換漢字（例: 宝塚の「塚」が U+FA10・
 * 通常の U+585A ではない）が混じることがあり、GSI はこれを解決できず 0 hit になる。
 * 兵庫県 S1 で 5 校が同一原因で quarantine されていた（U+FA10 の出現箇所と失敗校が完全一致）。
 * NFC は互換漢字を統合漢字へ正規分解・再合成するため、これで根本的に解消する。
 *
 * @param {string} address
 * @returns {string}
 */
export function normalizeAddress(address) {
  return (address ?? '').normalize('NFC').trim()
}

export async function resolveCoordinates(records, { ownership, sleepMs, fetchImpl } = {}) {
  const targets = selectTargetRows(records, ownership)
  let resolved = 0
  let multiHit = 0
  let noHit = 0
  let normalized = 0
  const quarantineRows = []

  for (const row of targets) {
    const rawAddress = (row.address ?? '').trim()
    const address = normalizeAddress(row.address)
    if (address !== rawAddress) normalized++
    if (!address) {
      quarantineRows.push({ name: row.name, address, hit_count: '0', reason: 'empty_address', hits_json: '' })
      continue
    }
    let hits
    try {
      hits = await fetchGsi(address, { fetchImpl })
    } catch (error) {
      quarantineRows.push({
        name: row.name,
        address,
        hit_count: 'error',
        reason: `gsi_error_after_retries:${error instanceof Error ? error.message : String(error)}`,
        hits_json: '',
      })
      await sleep(sleepMs)
      continue
    }

    if (Array.isArray(hits) && hits.length === 1) {
      const [lon, lat] = hits[0].geometry.coordinates
      row.latitude = lat.toFixed(6)
      row.longitude = lon.toFixed(6)
      resolved++
    } else if (!Array.isArray(hits) || hits.length === 0) {
      noHit++
      quarantineRows.push({ name: row.name, address, hit_count: '0', reason: 'gsi_no_hit', hits_json: '' })
    } else {
      multiHit++
      quarantineRows.push({
        name: row.name,
        address,
        hit_count: String(hits.length),
        reason: 'gsi_multi_hit',
        hits_json: JSON.stringify(hits),
      })
    }
    await sleep(sleepMs)
  }

  return { resolved, multiHit, noHit, normalized, quarantineRows, targetCount: targets.length }
}

function parseArgs(argv) {
  const args = { csvPath: '', ownership: DEFAULT_OWNERSHIP, quarantine: '', sleepMs: 350, dryRun: false }
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--ownership') args.ownership = (argv[++i] ?? '').split(',').map((value) => value.trim()).filter(Boolean)
    else if (arg === '--quarantine') args.quarantine = argv[++i] ?? ''
    else if (arg === '--sleep-ms') args.sleepMs = Number(argv[++i] ?? '350')
    else if (arg === '--dry-run') args.dryRun = true
    else if (arg === '--help' || arg === '-h') args.help = true
    else if (arg.startsWith('--')) throw new Error(`不明な引数: ${arg}`)
    else positional.push(arg)
  }
  args.csvPath = positional[0] ?? ''
  if (!args.quarantine && args.csvPath) args.quarantine = args.csvPath.replace(/schools-candidate\.csv$/, 'coord-quarantine.csv')
  if (!args.quarantine) args.quarantine = 'coord-quarantine.csv'
  return args
}

function gsiQueryUrl(address) {
  return GSI_ENDPOINT + encodeURIComponent(normalizeAddress(address))
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || !args.csvPath) {
    console.error('使い方: node scripts/admission/gsi-batch-geocode.mjs <schools-candidate.csv> [--ownership prefectural,municipal,private,national] [--quarantine <path>] [--sleep-ms 350] [--dry-run]')
    process.exit(args.help ? 0 : 2)
  }

  const { header, records } = readCsvRecords(args.csvPath)
  const targets = selectTargetRows(records, args.ownership)

  if (args.dryRun) {
    console.error(`対象行数: ${targets.length}（ownership=${args.ownership.join(',')}）`)
    for (const row of targets.slice(0, 3)) {
      console.error(`  ${row.name}: ${gsiQueryUrl(row.address ?? '')}`)
    }
    console.log(JSON.stringify({ dryRun: true, targetCount: targets.length }))
    return
  }

  const result = await resolveCoordinates(records, { ownership: args.ownership, sleepMs: args.sleepMs })

  writeFileSync(args.csvPath, stringifyCsv(header, records), 'utf8')
  writeFileSync(args.quarantine, stringifyCsv(QUARANTINE_HEADER, result.quarantineRows), 'utf8')

  console.log(JSON.stringify({
    resolved: result.resolved,
    multi_hit: result.multiHit,
    no_hit: result.noHit,
    normalized_addresses: result.normalized,
    quarantine_rows: result.quarantineRows.length,
  }))
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  })
}
