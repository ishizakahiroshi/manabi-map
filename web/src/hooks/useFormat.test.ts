import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  type Locale = 'ja' | 'en'
  type Vars = Record<string, string | number>
  type Message = string | ((vars: Vars) => string)

  const state: { locale: Locale } = { locale: 'ja' }
  const messages: Record<Locale, Record<string, Message>> = {
    ja: {
      'labels.own.metropolitan': '都立',
      'labels.course.fulltime': '全日制',
      'labels.enrollment': ({ count, year }) => `約 ${count} 人（${year} 年）`,
      'detail.lifecyclePlanned': '開校予定',
      'detail.lifecycleClosing': '在校生のみ',
      'detail.lifecycleClosed': '閉校',
      'detail.recruitmentUnknown': '未確認',
      'detail.recruitmentNotStarted': '募集開始前',
      'detail.recruitmentNoExternal': '高校段階の外部募集なし',
      'detail.recruitmentStopped': '募集終了',
    },
    en: {
      'labels.own.metropolitan': 'Metropolitan',
      'labels.course.fulltime': 'Day program',
      'labels.enrollment': ({ count, year }) => `About ${count} students (${year})`,
      'detail.lifecyclePlanned': 'Planned',
      'detail.lifecycleClosing': 'Current students only',
      'detail.lifecycleClosed': 'Closed',
      'detail.recruitmentUnknown': 'Unconfirmed',
      'detail.recruitmentNotStarted': 'Not started',
      'detail.recruitmentNoExternal': 'No external upper-secondary intake',
      'detail.recruitmentStopped': 'Recruitment ended',
    },
  }

  const t = (key: string, vars?: Vars): string => {
    const message = messages[state.locale][key]
    if (typeof message === 'function') return message(vars ?? {})
    return message ?? key
  }

  return { state, t }
})

vi.mock('react', () => ({
  useMemo: (factory: () => unknown) => factory(),
}))

vi.mock('../contexts/I18nContext', () => ({
  useI18n: () => ({ locale: mocks.state.locale, t: mocks.t }),
}))

import { useFormat } from './useFormat'

const school = {
  total_students: 1234,
  enrollment_year: 2026,
} as Parameters<ReturnType<typeof useFormat>['enrollmentLabel']>[0]

describe('useFormat locale contracts', () => {
  afterEach(() => {
    mocks.state.locale = 'ja'
  })

  it('ja formats ownership, course, status and numbers', () => {
    mocks.state.locale = 'ja'
    const fmt = useFormat()

    expect(fmt.ownFull({ ownership: 'prefectural', prefecture: '東京都' })).toBe('都立')
    expect(fmt.courseFull('fulltime')).toBe('全日制')
    expect(fmt.listStatusLabel({ lifecycle_status_code: 'closing', recruitment_status_code: 'stopped' }))
      .toBe('在校生のみ・募集終了')
    expect(fmt.enrollmentLabel(school)).toBe('約 1,234 人（2026 年）')
  })

  it('en formats ownership, course, status and numbers', () => {
    mocks.state.locale = 'en'
    const fmt = useFormat()

    expect(fmt.ownFull({ ownership: 'prefectural', prefecture: '東京都' })).toBe('Metropolitan')
    expect(fmt.courseFull('fulltime')).toBe('Day program')
    expect(fmt.listStatusLabel({ lifecycle_status_code: 'closing', recruitment_status_code: 'stopped' }))
      .toBe('Current students only・Recruitment ended')
    expect(fmt.enrollmentLabel(school)).toBe('About 1,234 students (2026)')
  })
})
