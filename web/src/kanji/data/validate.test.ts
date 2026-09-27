import { describe, expect, it } from 'vitest'
import type { ContentFact, ContentScope, SyntheticKanjiDataset } from './types'
import { validateSyntheticKanjiDataset } from './validate'

function known<T>(value: T): ContentFact<T> {
  return { state: 'available', value, sourceIds: ['invented-test'] }
}

/** Invented readings/meanings/geometry/counts; these are not teaching material. */
function fixture(): SyntheticKanjiDataset {
  const characters = Array.from('一二三四五六七').map((character) => ({
    id: `U+${character.codePointAt(0)!.toString(16).toUpperCase()}`,
    character,
    readings: known({ on: ['テスト'], kun: [] as string[] }),
    strokeCount: known(1),
    radical: known(1),
    meanings: known({ en: ['Invented test meaning'] }),
    strokes: known([[{ command: 'M' as const, points: [1, 2] }, { command: 'L' as const, points: [3, 4] }]]),
  }))
  return {
    format: 'kanji-content-preparation', schemaVersion: 1, synthetic: true,
    sources: [{ id: 'invented-test', title: 'Self-authored synthetic fixture', sourceVersion: 'test-1', kind: 'synthetic' }],
    characters,
    collections: [
      ...characters.slice(0, 6).map((character, index) => ({
        scope: `elementary-${index + 1}` as ContentScope, members: known([character.id]),
      })),
      { scope: 'joyo', members: known(characters.map((character) => character.id)) },
      { scope: 'non-elementary-joyo', members: known([characters[6].id]) },
    ],
  }
}

describe('synthetic kanji content preparation boundary', () => {
  it('validates an invented complete partition without coercing or mutating input', () => {
    const data = fixture()
    const before = JSON.stringify(data)
    expect(validateSyntheticKanjiDataset(data)).toBe(data)
    expect(JSON.stringify(data)).toBe(before)
  })

  it.each(['not_collected', 'unverified', 'not_applicable'] as const)('preserves %s without inventing a value', (state) => {
    const data = fixture()
    data.characters[0].strokes = { state, reason: 'Synthetic missingness example' }
    data.collections[0].members = { state, reason: 'Synthetic missingness example' }
    expect(validateSyntheticKanjiDataset(data).characters[0].strokes).toEqual({ state, reason: 'Synthetic missingness example' })
  })

  it.each([
    ['null', () => null],
    ['array', () => []],
    ['real data', (data: SyntheticKanjiDataset) => ({ ...data, synthetic: false })],
    ['future schema', (data: SyntheticKanjiDataset) => ({ ...data, schemaVersion: 2 })],
    ['learner information', (data: SyntheticKanjiDataset) => ({ ...data, profiles: [] })],
    ['skip code', (data: SyntheticKanjiDataset) => ({ ...data, characters: [{ ...data.characters[0], skip: '1-1-1' }] })],
    ['association scope', (data: SyntheticKanjiDataset) => ({ ...data, collections: [{ scope: 'kanken-4', members: known([data.characters[0].id]) }] })],
  ] as const)('rejects %s at the input boundary', (_name, mutate) => {
    expect(() => validateSyntheticKanjiDataset(mutate(fixture()))).toThrow(/Invalid kanji preparation data/)
  })

  it('requires a known source for every available fact', () => {
    const data = fixture()
    data.characters[0].radical = { state: 'available', value: 1, sourceIds: ['missing'] }
    expect(() => validateSyntheticKanjiDataset(data)).toThrow(/unknown source/)
    data.characters[0].radical = { state: 'available', value: 1, sourceIds: [] }
    expect(() => validateSyntheticKanjiDataset(data)).toThrow(/sourceIds/)
  })

  it('rejects unverified values smuggled into a missing fact and blank reasons', () => {
    const data = fixture()
    Object.assign(data.characters[0].radical, { state: 'unverified', reason: 'Not checked' })
    expect(() => validateSyntheticKanjiDataset(data)).toThrow(/fields/)
    data.characters[0].radical = { state: 'unverified', reason: ' ' }
    expect(() => validateSyntheticKanjiDataset(data)).toThrow(/reason/)
  })

  it('rejects duplicate identities and mismatching Unicode scalars', () => {
    const data = fixture()
    data.characters.push(data.characters[0])
    expect(() => validateSyntheticKanjiDataset(data)).toThrow(/unique scalar/)
    data.characters.pop()
    data.characters[0].character = 'A'
    expect(() => validateSyntheticKanjiDataset(data)).toThrow(/Han scalar/)
    data.characters[0].character = '二'
    expect(() => validateSyntheticKanjiDataset(data)).toThrow(/unique scalar/)
  })

  it('preserves supplementary Han scalars without UTF-16 splitting', () => {
    const data = fixture()
    const oldId = data.characters[0].id
    data.characters[0].character = '\u{20000}'
    data.characters[0].id = 'U+20000'
    for (const collection of data.collections) {
      if (collection.members.state === 'available') collection.members.value = collection.members.value.map((id) => id === oldId ? 'U+20000' : id)
    }
    expect(validateSyntheticKanjiDataset(data).characters[0].id).toBe('U+20000')
  })

  it.each([0, -1, 1.5, Infinity, NaN])('rejects invalid stroke counts %s', (value) => {
    const data = fixture()
    data.characters[0].strokeCount = known(value)
    expect(() => validateSyntheticKanjiDataset(data)).toThrow(/strokeCount/)
  })

  it('rejects empty known meanings/readings and noncanonical language tags', () => {
    const data = fixture()
    data.characters[0].meanings = known({})
    expect(() => validateSyntheticKanjiDataset(data)).toThrow(/meanings/)
    data.characters[0].meanings = known({ EN: ['Test'] })
    expect(() => validateSyntheticKanjiDataset(data)).toThrow(/canonical language/)
    data.characters[0].meanings = known({ en: ['Test'] })
    data.characters[0].readings = known({ on: [], kun: [] })
    expect(() => validateSyntheticKanjiDataset(data)).toThrow(/readings: empty/)
  })

  it('rejects count/geometry mismatch and unsafe or malformed commands', () => {
    const data = fixture()
    data.characters[0].strokeCount = known(2)
    expect(() => validateSyntheticKanjiDataset(data)).toThrow(/mismatch/)
    data.characters[0].strokeCount = known(1)
    data.characters[0].strokes = known([[{ command: 'L', points: [0, 1] }, { command: 'L', points: [2, 3] }]])
    expect(() => validateSyntheticKanjiDataset(data)).toThrow(/initial move/)
    data.characters[0].strokes = known([[{ command: 'M', points: [0, 1] }, { command: 'C', points: [2, 3] }]])
    expect(() => validateSyntheticKanjiDataset(data)).toThrow(/coordinates/)
    data.characters[0].strokes = known([[{ command: 'M', points: [0, 1] }, { command: 'L', points: [NaN, 3] }]])
    expect(() => validateSyntheticKanjiDataset(data)).toThrow(/coordinates/)
  })

  it('rejects unknown members, duplicates and overlapping elementary grades', () => {
    const data = fixture()
    data.collections[0].members = known(['U+FFFF'])
    expect(() => validateSyntheticKanjiDataset(data)).toThrow(/unknown character/)
    data.collections[0].members = known([data.characters[0].id, data.characters[0].id])
    expect(() => validateSyntheticKanjiDataset(data)).toThrow(/duplicate/)
    data.collections[0].members = data.collections[1].members
    expect(() => validateSyntheticKanjiDataset(data)).toThrow(/overlapping/)
  })

  it('checks the complete elementary/remaining partition when every collection is known', () => {
    const data = fixture()
    data.collections[7].members = known([data.characters[0].id])
    expect(() => validateSyntheticKanjiDataset(data)).toThrow(/overlap/)
    data.collections[7].members = known([data.characters[6].id])
    data.collections[6].members = known(data.characters.slice(0, 6).map((character) => character.id))
    expect(() => validateSyntheticKanjiDataset(data)).toThrow(/outside joyo/)
  })
})
