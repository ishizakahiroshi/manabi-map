/** C3 preparation contract. Version 1 accepts synthetic content only, never learner records. */
export type ContentFact<T> =
  | { state: 'available'; value: T; sourceIds: string[] }
  | { state: 'not_collected' | 'unverified' | 'not_applicable'; reason: string }

export interface ContentSource {
  id: string
  title: string
  sourceVersion: string
  /** Test authorship only. Real source attribution/licensing needs the later import contract. */
  kind: 'synthetic'
}

/** Normalized drawing commands; not raw SVG markup. Coordinates use a 0–109 viewBox. */
export interface StrokeCommand {
  command: 'M' | 'L' | 'Q' | 'C'
  points: number[]
}

export interface KanjiContent {
  /** Uppercase Unicode scalar identifier, e.g. U+4E00. No compatibility folding. */
  id: string
  character: string
  readings: ContentFact<{ on: string[]; kun: string[] }>
  strokeCount: ContentFact<number>
  radical: ContentFact<number>
  meanings: ContentFact<Record<string, string[]>>
  strokes: ContentFact<StrokeCommand[][]>
}

/** Content coverage is independent of the profile's selected examination level. */
export type ContentScope = 'elementary-1' | 'elementary-2' | 'elementary-3'
  | 'elementary-4' | 'elementary-5' | 'elementary-6' | 'joyo' | 'non-elementary-joyo'

export interface ContentCollection {
  scope: ContentScope
  members: ContentFact<string[]>
}

export interface SyntheticKanjiDataset {
  format: 'kanji-content-preparation'
  schemaVersion: 1
  synthetic: true
  sources: ContentSource[]
  characters: KanjiContent[]
  collections: ContentCollection[]
}
