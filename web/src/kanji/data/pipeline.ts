import type { ContentFact, SyntheticKanjiDataset } from './types'
import { validateSyntheticKanjiDataset } from './validate'

/** Explicit generation envelope; versions are supplied by the author, never inferred. */
export interface KanjiContentInput {
  datasetVersion: string
  sourceVersion: string
  dataset: SyntheticKanjiDataset
}

/** Stable object keys; array order is retained unless explicitly defined as a set below. */
export function canonicalJson(value: unknown): string {
  function ordered(item: unknown): unknown {
    if (Array.isArray(item)) return item.map(ordered)
    if (item !== null && typeof item === 'object') {
      return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([key, child]) => [key, ordered(child)]))
    }
    return item
  }
  return JSON.stringify(ordered(value)) + '\n'
}

// Defense against markup/URL inputs, including inside otherwise valid free text.
// This is not a detector for real-world personal information: fixtures must be authored synthetically.
function checkText(value: unknown): void {
  if (typeof value === 'string') {
    if (/[\uD800-\uDFFF]/u.test(value) || /[<>]|[a-z][a-z0-9+.-]*:\/\/|\/\/[a-z0-9]|\b(?:https?|ftp|file|data|javascript|mailto):/i.test(value)
      || Array.from(value).some((char) => { const n = char.codePointAt(0)!; return n < 32 && ![9, 10, 13].includes(n) })) {
      throw new Error('Invalid preparation text: markup, URL, control or Unicode sequence')
    }
  } else if (Array.isArray(value)) value.forEach(checkText)
  else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) { checkText(key); checkText(child) }
  }
}

export function normalizeInput(input: unknown): KanjiContentInput {
  if (input === null || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).sort().join(',') !== 'dataset,datasetVersion,sourceVersion') {
    throw new Error('Expected dataset, datasetVersion and sourceVersion only')
  }
  const envelope = input as KanjiContentInput
  for (const version of [envelope.datasetVersion, envelope.sourceVersion]) {
    if (typeof version !== 'string' || !version.trim()) throw new Error('Explicit nonempty versions required')
  }
  validateSyntheticKanjiDataset(envelope.dataset)
  checkText(envelope)
  const result = structuredClone(envelope)
  const sortBy = <T>(rows: T[], key: (row: T) => string) => rows.sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0)
  sortBy(result.dataset.sources, (source) => source.id)
  sortBy(result.dataset.characters, (character) => character.id)
  sortBy(result.dataset.collections, (collection) => collection.scope)
  const normalizeFact = (fact: ContentFact<unknown>) => {
    if (fact.state === 'available') fact.sourceIds.sort()
  }
  for (const character of result.dataset.characters) {
    for (const field of FACT_FIELDS) normalizeFact(character[field])
  }
  for (const collection of result.dataset.collections) {
    normalizeFact(collection.members)
    if (collection.members.state === 'available') collection.members.value.sort()
  }
  return result
}

const FACT_FIELDS = ['readings', 'strokeCount', 'radical', 'meanings', 'strokes'] as const

export function contentCounts(input: KanjiContentInput): Record<string, number> {
  const { sources, characters, collections } = input.dataset
  const counts: Record<string, number> = {
    sources: sources.length, characters: characters.length, collections: collections.length,
    facts_available: 0, facts_not_collected: 0, facts_unverified: 0, facts_not_applicable: 0,
  }
  // Counts measure records/states, not an assumed total curriculum or unknown member counts.
  for (const character of characters) for (const key of FACT_FIELDS) counts[`facts_${character[key].state}`]++
  for (const collection of collections) counts[`facts_${collection.members.state}`]++
  return counts
}

export function diffInputs(previous: KanjiContentInput | null, next: KanjiContentInput) {
  function rows<T>(before: T[], after: T[], key: (row: T) => string) {
    const old = new Map(before.map((row) => [key(row), row]))
    const current = new Map(after.map((row) => [key(row), row]))
    return {
      added: [...current.keys()].filter((id) => !old.has(id)).sort(),
      changed: [...current.keys()].filter((id) => old.has(id) && canonicalJson(old.get(id)) !== canonicalJson(current.get(id))).sort(),
      excluded: [...old.keys()].filter((id) => !current.has(id)).sort(),
    }
  }
  const stateChanges: { path: string; before: string; after: string }[] = []
  const oldCharacters = new Map(previous?.dataset.characters.map((row) => [row.id, row]))
  for (const row of next.dataset.characters) {
    const old = oldCharacters.get(row.id)
    if (old) for (const field of FACT_FIELDS) {
      if (old[field].state !== row[field].state) stateChanges.push({ path: `characters/${row.id}/${field}`, before: old[field].state, after: row[field].state })
    }
  }
  const oldCollections = new Map(previous?.dataset.collections.map((row) => [row.scope, row]))
  for (const row of next.dataset.collections) {
    const old = oldCollections.get(row.scope)
    if (old && old.members.state !== row.members.state) stateChanges.push({ path: `collections/${row.scope}/members`, before: old.members.state, after: row.members.state })
  }
  return {
    format: 'kanji-content-diff', schemaVersion: 1, synthetic: true,
    exclusionMeaning: 'absent-from-candidate-not-source-deletion',
    previous: previous ? { datasetVersion: previous.datasetVersion, sourceVersion: previous.sourceVersion } : null,
    next: { datasetVersion: next.datasetVersion, sourceVersion: next.sourceVersion },
    sources: rows(previous?.dataset.sources ?? [], next.dataset.sources, (row) => row.id),
    characters: rows(previous?.dataset.characters ?? [], next.dataset.characters, (row) => row.id),
    collections: rows(previous?.dataset.collections ?? [], next.dataset.collections, (row) => row.scope),
    stateChanges,
  }
}
