import { describe, it, expect } from 'vitest'
import type { UserKind } from '../contexts/AuthContext'
import { SITE_MOVE } from '../data/site-move'
import {
  decideSiteMoveNotice,
  formatSwitchDateLabel,
  isSiteMoveNoticeDismissed,
  resolveSiteMoveDevEnv,
  switchStartMs,
  toJstDate,
  type SiteMoveNoticeInput,
} from './siteMove'

const DAY_MS = 24 * 60 * 60 * 1000
const SWITCH_DATE = '2026-10-15'
/** 2026-10-15 0:00（日本時間） */
const START = Date.UTC(2026, 9, 14, 15, 0, 0)
const CONFIG = {
  oldHost: 'manabi-map.app',
  newHost: 'school.manabi-map.app',
  switchDate: SWITCH_DATE,
  noticeDays: 28,
}
const NO_DISMISSALS = { accountBefore: null, after: null }
const ALL_KINDS: UserKind[] = ['anon', 'google', 'line', null]

function input(overrides: Partial<SiteMoveNoticeInput> = {}): SiteMoveNoticeInput {
  return {
    hostname: 'manabi-map.app',
    nowMs: START - 7 * DAY_MS,
    config: CONFIG,
    userKind: 'anon',
    hasUserData: true,
    dismissals: NO_DISMISSALS,
    ...overrides,
  }
}

describe('switchStartMs / toJstDate', () => {
  it('切替日の 0:00（日本時間）を返す', () => {
    expect(switchStartMs(SWITCH_DATE)).toBe(START)
  })
  it('null・形式違い・実在しない日付は null', () => {
    expect(switchStartMs(null)).toBe(null)
    expect(switchStartMs('')).toBe(null)
    expect(switchStartMs('2026/10/15')).toBe(null)
    expect(switchStartMs('2026-10-15T10:00')).toBe(null)
    expect(switchStartMs('2026-02-30')).toBe(null)
    expect(switchStartMs('2026-13-01')).toBe(null)
  })
  it('日本時間の日付にする', () => {
    expect(toJstDate(START)).toBe('2026-10-15')
    expect(toJstDate(START - 1)).toBe('2026-10-14')
  })
})

describe('decideSiteMoveNotice: 切替日が未設定', () => {
  it('本番の設定（切替日 null）では、どのホスト・利用者にも出さない', () => {
    expect(SITE_MOVE.switchDate).toBe(null)
    for (const hostname of [SITE_MOVE.oldHost, SITE_MOVE.newHost, 'localhost']) {
      for (const userKind of ALL_KINDS) {
        for (const hasUserData of [true, false]) {
          expect(decideSiteMoveNotice(input({ hostname, userKind, hasUserData, config: SITE_MOVE }))).toBe('none')
        }
      }
    }
  })
  it('切替日の形式が正しくないときも出さない', () => {
    expect(decideSiteMoveNotice(input({ config: { ...CONFIG, switchDate: '2026-02-30' } }))).toBe('none')
  })
})

describe('decideSiteMoveNotice: 旧住所（切替日の前）', () => {
  it('ゲストでお気に入りかメモを持つ人には予告 1', () => {
    expect(decideSiteMoveNotice(input())).toBe('guest-before')
  })
  it('データを持たないゲストには出さない', () => {
    expect(decideSiteMoveNotice(input({ hasUserData: false }))).toBe('none')
  })
  it('予告 1 は閉じた記録があっても出す（閉じられない）', () => {
    const dismissals = { accountBefore: SWITCH_DATE, after: SWITCH_DATE }
    expect(decideSiteMoveNotice(input({ dismissals }))).toBe('guest-before')
  })
  it('Google・LINE でログインしている人には予告 2（データの有無は見ない）', () => {
    for (const userKind of ['google', 'line'] as const) {
      expect(decideSiteMoveNotice(input({ userKind, hasUserData: false }))).toBe('account-before')
      expect(decideSiteMoveNotice(input({ userKind, hasUserData: true }))).toBe('account-before')
    }
  })
  it('予告 2 は閉じたら出さない。切替日が変わったら、また出す', () => {
    const closed = { accountBefore: SWITCH_DATE, after: null }
    expect(decideSiteMoveNotice(input({ userKind: 'google', dismissals: closed }))).toBe('none')
    const closedForOldDate = { accountBefore: '2026-10-01', after: null }
    expect(decideSiteMoveNotice(input({ userKind: 'google', dismissals: closedForOldDate }))).toBe('account-before')
  })
  it('お知らせ 3 の閉じた記録は予告 2 に効かない', () => {
    const dismissals = { accountBefore: null, after: SWITCH_DATE }
    expect(decideSiteMoveNotice(input({ userKind: 'line', dismissals }))).toBe('account-before')
  })
  it('未ログイン（読み込み中を含む）には出さない', () => {
    expect(decideSiteMoveNotice(input({ userKind: null }))).toBe('none')
  })
  it('切替日の終わりまで出し、翌日からは出さない', () => {
    expect(decideSiteMoveNotice(input({ nowMs: START + DAY_MS - 1 }))).toBe('guest-before')
    expect(decideSiteMoveNotice(input({ nowMs: START + DAY_MS }))).toBe('none')
    expect(decideSiteMoveNotice(input({ userKind: 'google', nowMs: START + DAY_MS }))).toBe('none')
  })
  it('ホスト名の大文字・末尾のドットを吸収する', () => {
    expect(decideSiteMoveNotice(input({ hostname: 'Manabi-Map.APP.' }))).toBe('guest-before')
  })
})

describe('decideSiteMoveNotice: 新住所', () => {
  const onNew = (overrides: Partial<SiteMoveNoticeInput> = {}) =>
    input({ hostname: 'school.manabi-map.app', nowMs: START, ...overrides })

  it('切替日から全員にお知らせ 3', () => {
    for (const userKind of ALL_KINDS) {
      for (const hasUserData of [true, false]) {
        expect(decideSiteMoveNotice(onNew({ userKind, hasUserData }))).toBe('after')
      }
    }
  })
  it('切替日の前（並行公開の期間）は出さない', () => {
    expect(decideSiteMoveNotice(onNew({ nowMs: START - 1 }))).toBe('none')
  })
  it('設定の日数が過ぎたら出さない', () => {
    expect(decideSiteMoveNotice(onNew({ nowMs: START + 28 * DAY_MS - 1 }))).toBe('after')
    expect(decideSiteMoveNotice(onNew({ nowMs: START + 28 * DAY_MS }))).toBe('none')
  })
  it('日数が 0 以下・数でないときは出さない', () => {
    expect(decideSiteMoveNotice(onNew({ config: { ...CONFIG, noticeDays: 0 } }))).toBe('none')
    expect(decideSiteMoveNotice(onNew({ config: { ...CONFIG, noticeDays: Number.NaN } }))).toBe('none')
  })
  it('閉じたら出さない。切替日が変わったら、また出す', () => {
    expect(decideSiteMoveNotice(onNew({ dismissals: { accountBefore: null, after: SWITCH_DATE } }))).toBe('none')
    expect(decideSiteMoveNotice(onNew({ dismissals: { accountBefore: null, after: '2026-10-01' } }))).toBe('after')
    expect(decideSiteMoveNotice(onNew({ dismissals: { accountBefore: SWITCH_DATE, after: null } }))).toBe('after')
  })
})

describe('decideSiteMoveNotice: 旧住所でも新住所でもない', () => {
  it('localhost・プレビュー・ほかのサブドメインには出さない', () => {
    for (const hostname of [
      'localhost',
      '127.0.0.1',
      'manabi-map.pages.dev',
      'abc123.manabi-map.pages.dev',
      'www.manabi-map.app',
      'kanji.manabi-map.app',
    ]) {
      for (const nowMs of [START - DAY_MS, START + DAY_MS]) {
        for (const userKind of ALL_KINDS) {
          expect(decideSiteMoveNotice(input({ hostname, nowMs, userKind }))).toBe('none')
        }
      }
    }
  })
})

describe('decideSiteMoveNotice: 開発時の強制表示', () => {
  it('ホスト名・利用者の種類・データの有無を見ずに返す', () => {
    expect(decideSiteMoveNotice(input({ hostname: 'localhost', userKind: null, hasUserData: false, force: 'guest-before' })))
      .toBe('guest-before')
    expect(decideSiteMoveNotice(input({ hostname: 'localhost', userKind: 'anon', force: 'account-before' })))
      .toBe('account-before')
    expect(decideSiteMoveNotice(input({ hostname: 'localhost', nowMs: START - DAY_MS, force: 'after' })))
      .toBe('after')
  })
  it('閉じた記録は見る', () => {
    const dismissals = { accountBefore: SWITCH_DATE, after: SWITCH_DATE }
    expect(decideSiteMoveNotice(input({ hostname: 'localhost', dismissals, force: 'account-before' }))).toBe('none')
    expect(decideSiteMoveNotice(input({ hostname: 'localhost', dismissals, force: 'after' }))).toBe('none')
  })
  it('切替日が無ければ強制でも出さない', () => {
    expect(decideSiteMoveNotice(input({ config: { ...CONFIG, switchDate: null }, force: 'after' }))).toBe('none')
  })
})

describe('isSiteMoveNoticeDismissed', () => {
  it('切替日が null なら閉じた扱いにしない', () => {
    expect(isSiteMoveNoticeDismissed('after', { accountBefore: null, after: 'x' }, null)).toBe(false)
  })
  it('予告 1 と none は閉じた扱いにしない', () => {
    const all = { accountBefore: SWITCH_DATE, after: SWITCH_DATE }
    expect(isSiteMoveNoticeDismissed('guest-before', all, SWITCH_DATE)).toBe(false)
    expect(isSiteMoveNoticeDismissed('none', all, SWITCH_DATE)).toBe(false)
  })
})

describe('formatSwitchDateLabel', () => {
  it('日本語は「10月15日」、英語は「October 15」', () => {
    expect(formatSwitchDateLabel('2026-10-15', 'ja')).toBe('10月15日')
    expect(formatSwitchDateLabel('2026-10-15', 'en')).toBe('October 15')
    expect(formatSwitchDateLabel('2027-01-05', 'ja')).toBe('1月5日')
    expect(formatSwitchDateLabel('2027-01-05', 'en')).toBe('January 5')
  })
})

describe('resolveSiteMoveDevEnv', () => {
  const NOW = Date.UTC(2026, 8, 24, 3, 0, 0) // 2026-09-24 12:00（日本時間）
  const NULL_CONFIG = { ...CONFIG, switchDate: null }

  it('関係するクエリが無ければ null', () => {
    expect(resolveSiteMoveDevEnv('', NULL_CONFIG, NOW)).toBe(null)
    expect(resolveSiteMoveDevEnv('?q=abc&siteMoveNotice=9', NULL_CONFIG, NOW)).toBe(null)
  })
  it('siteMoveNotice=1|2 は、切替日を今日から 14 日後に見立てる', () => {
    expect(resolveSiteMoveDevEnv('?siteMoveNotice=1', NULL_CONFIG, NOW)).toEqual({
      hostname: null, switchDate: '2026-10-08', force: 'guest-before', reset: false,
    })
    expect(resolveSiteMoveDevEnv('?siteMoveNotice=2', NULL_CONFIG, NOW)?.force).toBe('account-before')
  })
  it('siteMoveNotice=3 は、切替日を今日に見立てる', () => {
    expect(resolveSiteMoveDevEnv('?siteMoveNotice=3', NULL_CONFIG, NOW)).toEqual({
      hostname: null, switchDate: '2026-09-24', force: 'after', reset: false,
    })
  })
  it('siteMoveHost でホスト名を見立て、実物の判定が通る', () => {
    const onOld = resolveSiteMoveDevEnv('?siteMoveHost=old', NULL_CONFIG, NOW)!
    expect(onOld.hostname).toBe('manabi-map.app')
    expect(decideSiteMoveNotice(input({
      hostname: onOld.hostname!, nowMs: NOW, config: { ...CONFIG, switchDate: onOld.switchDate },
      userKind: 'google', hasUserData: false,
    }))).toBe('account-before')

    const onNew = resolveSiteMoveDevEnv('?siteMoveHost=new', NULL_CONFIG, NOW)!
    expect(onNew.hostname).toBe('school.manabi-map.app')
    expect(decideSiteMoveNotice(input({
      hostname: onNew.hostname!, nowMs: NOW, config: { ...CONFIG, switchDate: onNew.switchDate },
      userKind: null, hasUserData: false,
    }))).toBe('after')
  })
  it('siteMoveSwitch は正しい日付のときだけ使う。設定に切替日があればそれを使う', () => {
    expect(resolveSiteMoveDevEnv('?siteMoveHost=old&siteMoveSwitch=2026-11-01', NULL_CONFIG, NOW)?.switchDate)
      .toBe('2026-11-01')
    expect(resolveSiteMoveDevEnv('?siteMoveHost=old&siteMoveSwitch=2026-02-30', NULL_CONFIG, NOW)?.switchDate)
      .toBe('2026-10-08')
    expect(resolveSiteMoveDevEnv('?siteMoveHost=old', CONFIG, NOW)?.switchDate).toBe(SWITCH_DATE)
  })
  it('siteMoveReset=1 で閉じた記録を消す指示を返す', () => {
    expect(resolveSiteMoveDevEnv('?siteMoveReset=1', NULL_CONFIG, NOW)?.reset).toBe(true)
    expect(resolveSiteMoveDevEnv('?siteMoveNotice=2&siteMoveReset=1', NULL_CONFIG, NOW)?.reset).toBe(true)
  })
})
