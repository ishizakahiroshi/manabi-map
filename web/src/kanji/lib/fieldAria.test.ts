// lib/fieldAria.ts のテスト（C8 レビュー should 1）。

import { describe, expect, it } from 'vitest'
import { examFieldAria, nickFieldAria } from './fieldAria'

describe('nickFieldAria', () => {
  it('エラーが無ければ aria-invalid は付かず、aria-describedby はヒントだけ', () => {
    expect(nickFieldAria(false)).toEqual({
      ariaInvalid: undefined,
      ariaDescribedBy: 'kanji-edit-nick-hint',
    })
  })

  it('エラーがあれば aria-invalid が true になり、aria-describedby にエラー文の id も足す', () => {
    expect(nickFieldAria(true)).toEqual({
      ariaInvalid: true,
      ariaDescribedBy: 'kanji-edit-nick-hint kanji-edit-nick-error',
    })
  })
})

describe('examFieldAria', () => {
  it('エラーが無ければ aria-invalid も aria-describedby も付かない', () => {
    expect(examFieldAria(false)).toEqual({
      ariaInvalid: undefined,
      ariaDescribedBy: undefined,
    })
  })

  it('エラーがあれば aria-invalid が true になり、aria-describedby がエラー文の id になる', () => {
    expect(examFieldAria(true)).toEqual({
      ariaInvalid: true,
      ariaDescribedBy: 'kanji-edit-exam-error',
    })
  })
})
