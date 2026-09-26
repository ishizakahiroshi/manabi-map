import { describe, expect, it } from 'vitest'
import { activeBookAds, eligibleForBookAd, isSafeBookCover, parseBookAdCatalog } from './bookAdCatalog'
import { syntheticBookAd as ad } from './bookAdCatalog.fixture'
import { PREFECTURES } from './prefecture'

const catalog = (entry: unknown = ad) => ({ version: 1, enabled: true, ads: [entry] })
const credentialUrl = new URL(ad.links[0].href)
credentialUrl.username = 'synthetic'
describe('runtime book ad catalog', () => {
  it('matches each of the 47 prefectures without leaking to other prefectures', () => {
    expect(PREFECTURES).toHaveLength(47)
    for (const prefecture of PREFECTURES) {
      const parsed = parseBookAdCatalog(catalog({ ...ad, prefectureCode: prefecture.code }))
      for (const target of PREFECTURES) expect(activeBookAds(parsed, target.code)).toHaveLength(target.code === prefecture.code ? 1 : 0)
    }
  })
  it('preserves provider URLs/HTML and strips unpublished extra fields', () => {
    const parsed = parseBookAdCatalog(catalog({ ...ad, privateNote: 'synthetic unpublished memo' }))
    expect(parsed.ads[0]).toEqual(ad)
  })
  it('honors global/per-ad stop and exact start/end boundaries', () => {
    const start = '2027-01-01T00:00:00.000Z'
    const end = '2027-02-01T00:00:00.000Z'
    const parsed = parseBookAdCatalog(catalog({ ...ad, startsAt: start, endsAt: end }))
    expect(activeBookAds(parsed, '10', Date.parse(start) - 1)).toHaveLength(0)
    expect(activeBookAds(parsed, '10', Date.parse(start))).toHaveLength(1)
    expect(activeBookAds(parsed, '10', Date.parse(end))).toHaveLength(0)
    expect(activeBookAds({ ...parsed, enabled: false }, '10', Date.parse(start))).toHaveLength(0)
    expect(activeBookAds(parseBookAdCatalog(catalog({ ...ad, enabled: false })), '10')).toHaveLength(0)
  })
  it.each([
    { prefectureCode: '48' }, { enabled: 'true' }, { examYear: '2027' }, { title: '' },
    { endsAt: '2027-02-30T00:00:00.000Z' }, { startsAt: '2027-01-01' },
    { startsAt: '2027-02-01T00:00:00.000Z', endsAt: '2027-01-01T00:00:00.000Z' },
    { links: [] }, { links: [...ad.links].reverse() },
    ...['javascript:alert(1)', 'https://www.amazon.co.jp.evil.example/x', credentialUrl.href, 'http://www.amazon.co.jp/x'].map(href => ({ links: [{ store: 'amazon', href }, ad.links[1]] })),
  ])('rejects malformed catalog entries: %j', patch => {
    expect(() => parseBookAdCatalog(catalog({ ...ad, ...patch }))).toThrow()
  })
  it('rejects duplicate IDs and unsupported versions', () => {
    expect(() => parseBookAdCatalog({ ...catalog(), ads: [ad, ad] })).toThrow()
    expect(() => parseBookAdCatalog({ ...catalog(), version: 2 })).toThrow()
  })
  it('accepts only small provider image snippets unchanged', () => {
    expect(isSafeBookCover(ad.coverHtml)).toBe(true)
    expect(isSafeBookCover(ad.coverHtml!.replaceAll('&', '&amp;'))).toBe(true)
  })
  it.each([
    '<script>alert(1)</script>', '<svg onload="alert(1)"></svg>',
    ad.coverHtml!.replace('<img ', '<img onerror="alert(1)" '),
    ad.coverHtml!.replace('margin:2px', 'position:fixed;inset:0'),
    ad.coverHtml!.replace('hbb.afl.rakuten.co.jp', 'evil.example'),
    ad.coverHtml!.replace('thumbnail.image.rakuten.co.jp', 'evil.example'),
    ad.coverHtml!.replace('128x128', '240x240'),
    ad.coverHtml!.replace('<a ', '<a href="https://evil.example/" '),
    ad.coverHtml!.replace('https:', 'javascript:'),
    ad.coverHtml!.replace('https:', 'https&colon;'),
    ad.coverHtml! + '<iframe src="https://evil.example"></iframe>',
  ])('rejects executable, remote or oversized cover markup', html => expect(isSafeBookCover(html)).toBe(false))
  it('preserves school eligibility guards for all prefectures', () => {
    const school = { type: 'high_school', ownership: 'prefectural' }
    for (const ownership of ['prefectural', 'municipal', 'union']) expect(eligibleForBookAd({ ...school, ownership })).toBe(true)
    for (const ownership of ['private', 'national', 'unknown']) expect(eligibleForBookAd({ ...school, ownership })).toBe(false)
    expect(eligibleForBookAd({ ...school, type: 'kosen' })).toBe(false)
    for (const lifecycle_status_code of ['planned', 'closing', 'closed']) expect(eligibleForBookAd({ ...school, lifecycle_status_code })).toBe(false)
    for (const recruitment_status_code of ['stopped', 'no_external_high_school_intake']) expect(eligibleForBookAd({ ...school, recruitment_status_code })).toBe(false)
  })
})
