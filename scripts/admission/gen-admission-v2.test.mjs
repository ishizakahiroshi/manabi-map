import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { generateSql, validateBundle } from './gen-admission-v2.mjs'

function validBundle() {
  const base = {
    pref: '架空県', school_name: '架空高等学校', school_record_key: '', unit_key: 'general', year: '2026',
    selection_stage_code: 'primary', selection_track_code: 'combined', scope_key: 'primary_total',
  }
  return {
    units: [{ pref: base.pref, school_name: base.school_name, unit_key: base.unit_key, unit_kind_code: 'department', unit_label: '普通科', course_time: 'fulltime', valid_from_year: '2024', valid_to_year: '', department_names: '普通科' }],
    stats: [{ ...base, stage_label_raw: '一次募集', track_label_raw: '一般＋特色', selection_scope_raw: '一次募集全体', population_scope_raw: '', map_role_code: 'primary_total', is_ratio_comparable: 'true', capacity: '100', applicants: '120', examinees: '', admitted: '', exam_scope_raw: '学力検査・面接', exam_component_codes: 'academic_test|interview' }],
    sources: [
      { ...base, fact_kind_code: 'capacity', official_url: 'https://example.pref.jp/capacity.pdf', doc_title: '募集定員', published_at: '2025-10-01', source_page_or_table: 'p.1', quoted_evidence: '募集定員', last_verified_at: '2026-07-14', last_http_status: '200' },
      { ...base, fact_kind_code: 'applicants', official_url: 'https://example.pref.jp/applicants.pdf', doc_title: '志願状況', published_at: '2026-02-01', source_page_or_table: 'p.2', quoted_evidence: '志願者数', last_verified_at: '2026-07-14', last_http_status: '200' },
    ],
    flags: [],
  }
}

describe('validateBundle', () => {
  it('固定code・指標別出典・非重複募集単位を受理する', () => {
    const result = validateBundle(validBundle())
    assert.equal(result.pref, '架空県')
    assert.equal(result.stats[0].comparable, true)
    assert.match(generateSql(result, 'synthetic'), /begin;[\s\S]*commit;/)
  })

  it('同名旧新校をschool_record_keyで別identityとして受理する', () => {
    const bundle = validBundle()
    for (const collection of ['units', 'stats', 'sources']) {
      for (const row of bundle[collection]) row.school_record_key = 'school-current'
    }
    bundle.units.push({
      ...bundle.units[0],
      school_record_key: 'school-predecessor',
      unit_key: 'general-old',
    })
    bundle.stats.push({
      ...bundle.stats[0],
      school_record_key: 'school-predecessor',
      unit_key: 'general-old',
      year: '2025',
    })
    bundle.sources.push(
      ...bundle.sources.map((source) => ({
        ...source,
        school_record_key: 'school-predecessor',
        unit_key: 'general-old',
        year: '2025',
      })),
    )
    const result = validateBundle(bundle)
    assert.equal(result.units.length, 2)
    assert.match(generateSql(result, 'synthetic'), /s\.record_key=i\.school_record_key/)
  })

  it('master未登録のtrackを拒否する', () => {
    const bundle = validBundle()
    bundle.stats[0].selection_track_code = 'feature'
    for (const source of bundle.sources) source.selection_track_code = 'feature'
    assert.throws(() => validateBundle(bundle), /master未登録/)
  })

  it('比較可能行の指標別出典不足を拒否する', () => {
    const bundle = validBundle()
    bundle.sources = bundle.sources.filter((source) => source.fact_kind_code !== 'applicants')
    assert.throws(() => validateBundle(bundle), /capacity\/applicantsの指標別出典/)
  })

  it('県教委の公式hostとして未登録のURLを拒否する', () => {
    const bundle = validBundle()
    bundle.sources[0].official_url = 'https://example.com/capacity.pdf'
    assert.throws(() => validateBundle(bundle), /公式hostとして未登録/)
  })

  it('Wave 1の県別公式hostを受理する', () => {
    const cases = [
      ['秋田県', 'https://www.pref.akita.lg.jp/document.pdf'],
      ['山形県', 'https://www.pref.yamagata.jp/document.pdf'],
      ['福島県', 'https://www.pref.fukushima.lg.jp/document.pdf'],
    ]
    for (const [pref, officialUrl] of cases) {
      const bundle = validBundle()
      for (const collection of ['units', 'stats', 'sources', 'flags']) {
        for (const row of bundle[collection]) row.pref = pref
      }
      for (const source of bundle.sources) source.official_url = officialUrl
      assert.equal(validateBundle(bundle).pref, pref)
    }
  })

  it('Wave 2の県別公式hostを受理する', () => {
    const cases = [
      ['富山県', 'https://www.pref.toyama.jp/document.pdf'],
      ['石川県', 'https://www.pref.ishikawa.lg.jp/document.pdf'],
      ['福井県', 'https://www.pref.fukui.lg.jp/document.pdf'],
    ]
    for (const [pref, officialUrl] of cases) {
      const bundle = validBundle()
      for (const collection of ['units', 'stats', 'sources', 'flags']) {
        for (const row of bundle[collection]) row.pref = pref
      }
      for (const source of bundle.sources) source.official_url = officialUrl
      assert.equal(validateBundle(bundle).pref, pref)
    }
  })

  it('Wave 3の県別公式hostを受理する', () => {
    const cases = [
      ['新潟県', 'https://www.pref.niigata.lg.jp/document.pdf'],
      ['長野県', 'https://www.pref.nagano.lg.jp/document.pdf'],
      ['山梨県', 'https://www.pref.yamanashi.jp/document.pdf'],
    ]
    for (const [pref, officialUrl] of cases) {
      const bundle = validBundle()
      for (const collection of ['units', 'stats', 'sources', 'flags']) {
        for (const row of bundle[collection]) row.pref = pref
      }
      for (const source of bundle.sources) source.official_url = officialUrl
      assert.equal(validateBundle(bundle).pref, pref)
    }
  })

  it('Wave 4の北海道教育委員会公式hostを受理する', () => {
    const bundle = validBundle()
    for (const collection of ['units', 'stats', 'sources', 'flags']) {
      for (const row of bundle[collection]) row.pref = '北海道'
    }
    for (const source of bundle.sources) {
      source.official_url = 'https://www.dokyoi.pref.hokkaido.lg.jp/document.pdf'
    }
    assert.equal(validateBundle(bundle).pref, '北海道')
  })

  it('Wave 5Aの県別公式hostを受理する', () => {
    const cases = [
      ['茨城県', 'https://kyoiku.pref.ibaraki.jp/document.pdf'],
      ['栃木県', 'https://www.pref.tochigi.lg.jp/document.pdf'],
      ['群馬県', 'https://www.pref.gunma.jp/document.pdf'],
    ]
    for (const [pref, officialUrl] of cases) {
      const bundle = validBundle()
      for (const collection of ['units', 'stats', 'sources', 'flags']) {
        for (const row of bundle[collection]) row.pref = pref
      }
      for (const source of bundle.sources) source.official_url = officialUrl
      assert.equal(validateBundle(bundle).pref, pref)
    }
  })

  it('Wave 5Bの都県別公式hostを受理する', () => {
    const cases = [
      ['埼玉県', 'https://www.pref.saitama.lg.jp/document.pdf'],
      ['千葉県', 'https://www.pref.chiba.lg.jp/document.pdf'],
      ['神奈川県', 'https://www.pref.kanagawa.jp/document.xlsx'],
      ['東京都', 'https://www.kyoiku.metro.tokyo.lg.jp/document.pdf'],
    ]
    for (const [pref, officialUrl] of cases) {
      const bundle = validBundle()
      for (const collection of ['units', 'stats', 'sources', 'flags']) {
        for (const row of bundle[collection]) row.pref = pref
      }
      for (const source of bundle.sources) source.official_url = officialUrl
      assert.equal(validateBundle(bundle).pref, pref)
    }
  })

  it('公式host名を含む偽装ドメインを拒否する', () => {
    const bundle = validBundle()
    for (const collection of ['units', 'stats', 'sources', 'flags']) {
      for (const row of bundle[collection]) row.pref = '秋田県'
    }
    for (const source of bundle.sources) source.official_url = 'https://pref.akita.lg.jp.example.com/document.pdf'
    assert.throws(() => validateBundle(bundle), /公式hostとして未登録/)
  })

  it('到達不能な指標別出典だけでprimary_totalを比較可能にしない', () => {
    const bundle = validBundle()
    bundle.sources[1].last_http_status = '404'
    assert.throws(() => validateBundle(bundle), /applicants出典は到達確認済み/)
  })

  it('比較不能行のreason_code不足を拒否する', () => {
    const bundle = validBundle()
    bundle.stats[0].map_role_code = 'detail_only'
    bundle.stats[0].is_ratio_comparable = 'false'
    assert.throws(() => validateBundle(bundle), /比較不能行にreason_code/)
  })

  it('同年度の募集単位membership重複を拒否する', () => {
    const bundle = validBundle()
    bundle.units.push({ ...bundle.units[0], unit_key: 'general-duplicate' })
    bundle.stats.push({ ...bundle.stats[0], unit_key: 'general-duplicate' })
    bundle.sources.push(...bundle.sources.map((source) => ({ ...source, unit_key: 'general-duplicate' })))
    assert.throws(() => validateBundle(bundle), /membershipが重複/)
  })
})
