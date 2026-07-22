import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { readCsvRecords, selectTargetRows, resolveCoordinates, stringifyCsv, parseCsv, normalizeAddress } from './gsi-batch-geocode.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(HERE, 'fixtures', 'geocode-sample.csv')
const SCRIPT = join(HERE, 'gsi-batch-geocode.mjs')

describe('parseCsv / stringifyCsv', () => {
  it('カンマ・改行を含むフィールドを round-trip できる', () => {
    const text = 'a,b\r\n"1,2",3\r\n'
    const rows = parseCsv(text)
    assert.deepEqual(rows, [['a', 'b'], ['1,2', '3']])
    const out = stringifyCsv(['a', 'b'], [{ a: '1,2', b: '3' }])
    assert.equal(out, text)
  })
})

describe('selectTargetRows', () => {
  it('ownership 一致 と 座標未設定 の両方を満たす行だけを選ぶ', () => {
    const { records } = readCsvRecords(FIXTURE)
    const targets = selectTargetRows(records, ['prefectural', 'municipal', 'private', 'national'])
    assert.deepEqual(targets.map((row) => row.record_key), ['school-0002', 'school-0003', 'school-0004', 'school-0005'])
  })

  it('ownership を絞ると対象が減る', () => {
    const { records } = readCsvRecords(FIXTURE)
    const targets = selectTargetRows(records, ['private', 'national'])
    assert.deepEqual(targets.map((row) => row.record_key), ['school-0003', 'school-0005'])
  })

  it('既存 lat/lng がある行は対象外（idempotent）', () => {
    const { records } = readCsvRecords(FIXTURE)
    const targets = selectTargetRows(records, ['prefectural'])
    assert.ok(!targets.some((row) => row.record_key === 'school-0001'))
  })
})

describe('normalizeAddress', () => {
  it('CJK互換漢字を統合漢字へ正規化する（GSI が 0 hit になる原因）', () => {
    // U+FA10（互換漢字の「塚」）は MEXT 住所欄に混入し、GSI で解決できない。
    // 兵庫県 S1 の失敗 5 件がこれと同一原因だった。
    const compatTsuka = String.fromCodePoint(0xfa10)
    const unifiedTsuka = String.fromCodePoint(0x585a)
    const compat = `兵庫県宝${compatTsuka}市架空町1-1`
    const unified = `兵庫県宝${unifiedTsuka}市架空町1-1`
    assert.notEqual(compat, unified)
    assert.equal(normalizeAddress(compat), unified)
  })

  it('前後の空白を落とし、未設定は空文字にする', () => {
    assert.equal(normalizeAddress('  兵庫県架空市1-1 '), '兵庫県架空市1-1')
    assert.equal(normalizeAddress(undefined), '')
    assert.equal(normalizeAddress(null), '')
  })
})

describe('resolveCoordinates', () => {
  it('互換漢字を含む住所は正規化してから GSI へ問い合わせ、normalized で件数を返す', async () => {
    const compatAddress = `兵庫県宝${String.fromCodePoint(0xfa10)}市架空町9-9`
    const unifiedAddress = `兵庫県宝${String.fromCodePoint(0x585a)}市架空町9-9`
    const records = [
      { record_key: 'school-9001', name: '架空宝塚高等学校', ownership: 'prefectural', address: compatAddress, latitude: '', longitude: '' },
    ]
    const queried = []
    const fetchImpl = async (url) => {
      queried.push(decodeURIComponent(String(url).split('q=')[1]))
      return { ok: true, status: 200, json: async () => [{ geometry: { coordinates: [135.36, 34.79] } }] }
    }
    const result = await resolveCoordinates(records, { ownership: ['prefectural'], sleepMs: 0, fetchImpl })
    // GSI へ渡るのは正規化後の統合漢字表記（これが 0 hit 解消の本体）。
    assert.deepEqual(queried, [unifiedAddress])
    assert.equal(result.resolved, 1)
    assert.equal(result.normalized, 1)
    assert.equal(records[0].latitude, '34.790000')
  })

  it('正規化不要の住所は normalized に数えない', async () => {
    const records = [
      { record_key: 'school-9002', name: '架空高等学校', ownership: 'prefectural', address: '兵庫県架空市架空町9-9', latitude: '', longitude: '' },
    ]
    const fetchImpl = async () => ({ ok: true, status: 200, json: async () => [{ geometry: { coordinates: [135, 35] } }] })
    const result = await resolveCoordinates(records, { ownership: ['prefectural'], sleepMs: 0, fetchImpl })
    assert.equal(result.normalized, 0)
    assert.equal(result.resolved, 1)
  })

  it('exact 1 hit は書き戻し、0/複数 hit・空欄住所は quarantine に回る', async () => {
    const { records } = readCsvRecords(FIXTURE)
    const fetchImpl = async (url) => {
      const address = decodeURIComponent(String(url).split('q=')[1])
      if (address.includes('架空町2丁目2')) {
        return { ok: true, status: 200, json: async () => [{ geometry: { coordinates: [135.111111, 35.222222] } }] }
      }
      if (address.includes('架空町4丁目4')) {
        return { ok: true, status: 200, json: async () => [] }
      }
      if (address.includes('架空町5丁目5')) {
        return { ok: true, status: 200, json: async () => [{ geometry: { coordinates: [1, 1] } }, { geometry: { coordinates: [2, 2] } }] }
      }
      throw new Error(`unexpected address in test: ${address}`)
    }
    const result = await resolveCoordinates(records, { ownership: ['prefectural', 'municipal', 'private', 'national'], sleepMs: 0, fetchImpl })
    assert.equal(result.resolved, 1)
    assert.equal(result.noHit, 1)
    assert.equal(result.multiHit, 1)
    assert.equal(result.quarantineRows.length, 3)
    assert.equal(result.quarantineRows.find((row) => row.name.includes('架空学園'))?.reason, 'empty_address')
    const row2 = records.find((row) => row.record_key === 'school-0002')
    assert.equal(row2.latitude, '35.222222')
    assert.equal(row2.longitude, '135.111111')
  })

  it('5xx はリトライ後も失敗すれば gsi_error_after_retries で quarantine する', async () => {
    const { records } = readCsvRecords(FIXTURE)
    const onlyMunicipal = records.filter((row) => row.record_key === 'school-0004')
    let calls = 0
    const fetchImpl = async () => {
      calls++
      return { ok: false, status: 503, json: async () => [] }
    }
    const result = await resolveCoordinates(onlyMunicipal, { ownership: ['municipal'], sleepMs: 0, fetchImpl })
    assert.equal(result.quarantineRows[0].reason.startsWith('gsi_error_after_retries'), true)
    assert.equal(calls, 3)
  })
})

describe('CLI --dry-run', () => {
  it('実 GSI 呼び出しなしで対象件数・先頭3件のクエリを表示する', () => {
    const stdout = execFileSync(process.execPath, [SCRIPT, FIXTURE, '--dry-run'], { encoding: 'utf8' })
    const parsed = JSON.parse(stdout.trim().split('\n').pop())
    assert.equal(parsed.dryRun, true)
    assert.equal(parsed.targetCount, 4)
  })

  it('ownership を絞ると dry-run の対象件数も減る', () => {
    const stdout = execFileSync(process.execPath, [SCRIPT, FIXTURE, '--ownership', 'private,national', '--dry-run'], { encoding: 'utf8' })
    const parsed = JSON.parse(stdout.trim().split('\n').pop())
    assert.equal(parsed.targetCount, 2)
  })

  it('--dry-run では入力 CSV を書き換えない', () => {
    const before = readCsvRecords(FIXTURE).records
    execFileSync(process.execPath, [SCRIPT, FIXTURE, '--dry-run'], { encoding: 'utf8' })
    const after = readCsvRecords(FIXTURE).records
    assert.deepEqual(after, before)
  })
})
