import type { ContentFact } from './types'
import type { KanjiContentInput } from './pipeline'

/** Entirely invented metadata, readings, meanings and lines; never educational material. */
export const known = <T>(value: T): ContentFact<T> => ({ state: 'available', value, sourceIds: ['invented'] })

export function pipelineFixture(generation = 1): KanjiContentInput {
  const characters = Array.from(generation === 1 ? '一二三' : '一三四').map((character) => ({
    id: `U+${character.codePointAt(0)!.toString(16).toUpperCase()}`, character,
    readings: known({ on: ['テストヨミ'], kun: [] as string[] }),
    strokeCount: known(1), radical: known(1),
    meanings: known({ en: ['Invented meaning'] }),
    strokes: known([[{ command: 'M' as const, points: [1, 2] }, { command: 'L' as const, points: [4, 8] }]]),
  }))
  if (generation === 2) characters[0].meanings = { state: 'unverified', reason: 'Invented pending check' }
  return {
    datasetVersion: `synthetic-${generation}`, sourceVersion: `invented-${generation}`,
    dataset: {
      format: 'kanji-content-preparation', schemaVersion: 1, synthetic: true,
      sources: [{ id: 'invented', title: 'Self authored synthetic content', sourceVersion: `invented-${generation}`, kind: 'synthetic' }],
      characters,
      collections: [
        { scope: 'elementary-1', members: known([characters[0].id]) },
        { scope: 'joyo', members: known(characters.map((row) => row.id)) },
        { scope: 'non-elementary-joyo', members: generation === 1
          ? { state: 'not_collected', reason: 'Invented missing collection' }
          : known(characters.slice(1).map((row) => row.id)) },
      ],
    },
  }
}
