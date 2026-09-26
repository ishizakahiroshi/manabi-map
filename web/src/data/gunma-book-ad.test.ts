import { describe, expect, it } from 'vitest'
import type { Ownership, SchoolType } from '../types/school'
import { showsGunmaBookAd } from './gunma-book-ad'

describe('群馬の過去問試験掲載の対象', () => {
  it.each<Ownership>(['prefectural', 'municipal', 'union'])('群馬の公立高校（%s）へ表示する', ownership => {
    expect(showsGunmaBookAd({ prefecture: '群馬県', type: 'high_school', ownership })).toBe(true)
  })
  it.each<[string, SchoolType, Ownership]>([
    ['群馬県', 'high_school', 'private'],
    ['群馬県', 'high_school', 'national'],
    ['群馬県', 'kosen', 'prefectural'],
    ['群馬県', 'kosen', 'national'],
    ['栃木県', 'high_school', 'prefectural'],
    ['', 'high_school', 'prefectural'],
  ])('%s / %s / %s へ表示しない', (prefecture, type, ownership) => {
    expect(showsGunmaBookAd({ prefecture, type, ownership })).toBe(false)
  })

  it('閉校した学校には表示しない', () => {
    expect(showsGunmaBookAd({
      prefecture: '群馬県',
      type: 'high_school',
      ownership: 'prefectural',
      lifecycle_status_code: 'closed',
    })).toBe(false)
  })

  it('高校から外部募集を行わない中高一貫校には表示しない', () => {
    expect(showsGunmaBookAd({
      prefecture: '群馬県',
      type: 'high_school',
      ownership: 'prefectural',
      recruitment_status_code: 'no_external_high_school_intake',
    })).toBe(false)
  })

  it('開校予定・在校生のみ・募集終了には表示しない', () => {
    expect(showsGunmaBookAd({
      prefecture: '群馬県',
      type: 'high_school',
      ownership: 'prefectural',
      lifecycle_status_code: 'planned',
    })).toBe(false)
    expect(showsGunmaBookAd({
      prefecture: '群馬県',
      type: 'high_school',
      ownership: 'prefectural',
      lifecycle_status_code: 'closing',
    })).toBe(false)
    expect(showsGunmaBookAd({
      prefecture: '群馬県',
      type: 'high_school',
      ownership: 'prefectural',
      recruitment_status_code: 'stopped',
    })).toBe(false)
  })

  it('募集開始前と募集状態未確認の公立高校には表示する', () => {
    expect(showsGunmaBookAd({
      prefecture: '群馬県',
      type: 'high_school',
      ownership: 'municipal',
      recruitment_status_code: 'not_started',
    })).toBe(true)
    expect(showsGunmaBookAd({
      prefecture: '群馬県',
      type: 'high_school',
      ownership: 'union',
      recruitment_status_code: 'unknown',
    })).toBe(true)
  })
})
