import { describe, it, expect } from 'vitest'
import { shortSchoolName, escapeHtml, band, topDev, botDev, devLabel } from './format'
import type { School } from '../types/school'

function makeSchool(devs: (number | null)[]): School {
  return {
    id: 'test-id',
    name: 'テスト校',
    ownership: 'prefectural',
    gender_type: 'coed',
    type: 'high_school',
    address: '',
    latitude: 0,
    longitude: 0,
    prefecture: '群馬県',
    departments: devs.map((d, i) => ({ id: `d${i}`, name: `学科${i}`, deviation: d })),
    course_times: ['fulltime'],
    campus_type: 'main',
    main_school_name: null,
    total_students: null,
    enrollment_year: null,
    male_ratio: null,
    is_recruiting: true,
    is_integrated: false,
    official_url: null,
  } as unknown as School
}

describe('shortSchoolName', () => {
  it('群馬県立 + 高等学校を剥がす', () => {
    expect(shortSchoolName('群馬県立前橋高等学校')).toBe('前橋高校')
  })
  it('他県の県立も剥がす', () => {
    expect(shortSchoolName('埼玉県立浦和高等学校')).toBe('浦和高校')
    expect(shortSchoolName('神奈川県立横浜翠嵐高等学校')).toBe('横浜翠嵐高校')
  })
  it('東京都立を剥がす', () => {
    expect(shortSchoolName('東京都立日比谷高等学校')).toBe('日比谷高校')
  })
  it('市名+市立+同市名 は市名までに', () => {
    expect(shortSchoolName('前橋市立前橋高等学校')).toBe('前橋高校')
  })
  it('市名+市立+別名 は「市立」だけ剥がし市名は残す', () => {
    expect(shortSchoolName('桐生市立商業高等学校')).toBe('桐生商業高校')
  })
  it('国立接頭辞と高等専門学校を剥がす', () => {
    expect(shortSchoolName('国立群馬工業高等専門学校')).toBe('群馬工業高専')
  })
  it('中等教育学校は中等に', () => {
    expect(shortSchoolName('群馬県立中央中等教育学校')).toBe('中央中等')
  })
  it('「立」を含まない公立正式名（北海道・宮城・長野）は school 情報付きで剥がす', () => {
    const hokkaido = { ownership: 'prefectural', prefecture: '北海道' } as const
    const miyagi = { ownership: 'prefectural', prefecture: '宮城県' } as const
    const nagano = { ownership: 'prefectural', prefecture: '長野県' } as const
    expect(shortSchoolName('北海道札幌南高等学校', hokkaido)).toBe('札幌南高校')
    expect(shortSchoolName('宮城県仙台第一高等学校', miyagi)).toBe('仙台第一高校')
    expect(shortSchoolName('長野県松本深志高等学校', nagano)).toBe('松本深志高校')
  })
  it('地名の「立科」型（蓼科）や school 情報なしでは接頭辞に触れない', () => {
    const nagano = { ownership: 'prefectural', prefecture: '長野県' } as const
    expect(shortSchoolName('長野県蓼科高等学校', nagano)).toBe('蓼科高校')
    expect(shortSchoolName('北海道札幌南高等学校')).toBe('北海道札幌南高校')
  })
  it('私立の「北海道◯◯」ブランド名は剥がさない', () => {
    const privateHokkaido = { ownership: 'private', prefecture: '北海道' } as const
    expect(shortSchoolName('北海道科学大学高等学校', privateHokkaido)).toBe('北海道科学大学高校')
  })
  it('school 情報付きでも「立」あり県は従来どおり', () => {
    const aomori = { ownership: 'prefectural', prefecture: '青森県' } as const
    expect(shortSchoolName('青森県立青森高等学校', aomori)).toBe('青森高校')
  })
})

describe('escapeHtml', () => {
  it('特殊文字 5 種を全てエスケープ', () => {
    expect(escapeHtml(`<a href="x" onclick='y'>&amp;`)).toBe(
      '&lt;a href=&quot;x&quot; onclick=&#39;y&#39;&gt;&amp;amp;',
    )
  })
})

describe('band', () => {
  it('境界 70/60/50/40/30 を含めた区分け', () => {
    expect(band(75)).toBe(70)
    expect(band(70)).toBe(70)
    expect(band(69)).toBe(60)
    expect(band(60)).toBe(60)
    expect(band(59)).toBe(50)
    expect(band(50)).toBe(50)
    expect(band(49)).toBe(40)
    expect(band(40)).toBe(40)
    expect(band(39)).toBe(30)
    expect(band(0)).toBe(30)
  })
})

describe('topDev / botDev / devLabel', () => {
  it('null を除外して max/min を返す', () => {
    const s = makeSchool([55, null, 62, 48])
    expect(topDev(s)).toBe(62)
    expect(botDev(s)).toBe(48)
    expect(devLabel(s)).toBe('48〜62')
  })
  it('全 null なら「−」', () => {
    const s = makeSchool([null, null])
    expect(topDev(s)).toBe(null)
    expect(botDev(s)).toBe(null)
    expect(devLabel(s)).toBe('−')
  })
  it('単一値は単数表示', () => {
    const s = makeSchool([55])
    expect(devLabel(s)).toBe('55')
  })
})
