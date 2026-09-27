import { describe, expect, it } from 'vitest'
import { canonicalJson, contentCounts, diffInputs, normalizeInput } from './pipeline'
import { known, pipelineFixture } from './pipeline.fixture'

describe('content pipeline normalization and generation diff', () => {
  it('normalizes set order without changing input or reading/stroke sequence', () => {
    const input = pipelineFixture()
    const original = structuredClone(input)
    const ordered = normalizeInput(input)
    input.dataset.characters.reverse()
    input.dataset.collections.reverse()
    for (const row of input.dataset.collections) if (row.members.state === 'available') row.members.value.reverse()
    expect(canonicalJson(normalizeInput(input))).toBe(canonicalJson(ordered))
    expect(ordered.dataset.characters.find((row) => row.id === 'U+4E00')?.strokes).toEqual(original.dataset.characters[0].strokes)
    const frozen = structuredClone(original)
    normalizeInput(original)
    expect(original).toEqual(frozen)
  })

  it('reports addition, change, exclusion, provenance and missingness without claiming source deletion', () => {
    const diff = diffInputs(normalizeInput(pipelineFixture()), normalizeInput(pipelineFixture(2)))
    expect(diff.characters).toEqual({ added: ['U+56DB'], changed: ['U+4E00'], excluded: ['U+4E8C'] })
    expect(diff.sources.changed).toEqual(['invented'])
    expect(diff.stateChanges).toEqual([
      { path: 'characters/U+4E00/meanings', before: 'available', after: 'unverified' },
      { path: 'collections/non-elementary-joyo/members', before: 'not_collected', after: 'available' },
    ])
    expect(diff.exclusionMeaning).toBe('absent-from-candidate-not-source-deletion')
  })

  it('separates counts of states from unknown curriculum member totals', () => {
    expect(contentCounts(normalizeInput(pipelineFixture()))).toEqual({ sources: 1, characters: 3, collections: 3,
      facts_available: 17, facts_not_collected: 1, facts_unverified: 0, facts_not_applicable: 0 })
  })

  it.each(['not_collected', 'unverified', 'not_applicable'] as const)('retains %s and transitions back to available', (state) => {
    const input = pipelineFixture()
    input.dataset.characters[0].radical = { state, reason: 'Invented state reason' }
    const before = normalizeInput(input)
    expect(before.dataset.characters[0].radical).toEqual({ state, reason: 'Invented state reason' })
    input.dataset.characters[0].radical = known(1)
    expect(diffInputs(before, normalizeInput(input)).stateChanges).toContainEqual({ path: 'characters/U+4E00/radical', before: state, after: 'available' })
  })

  it.each(['<svg/>', '<?xml version="1.0"?>', 'https://example.invalid/fixture', '//example.invalid/fixture', 'https:example.invalid', 'data:image/svg+xml,x', '\uD800', '\u0000'])('rejects text payload %j', (value) => {
    const input = pipelineFixture()
    input.dataset.sources[0].title = value
    expect(() => normalizeInput(input)).toThrow(/preparation text/)
  })

  it.each([
    ['unknown field', (d: ReturnType<typeof pipelineFixture>) => Object.assign(d.dataset, { profiles: [] })],
    ['unknown source', (d: ReturnType<typeof pipelineFixture>) => { d.dataset.characters[0].radical = { state: 'available', value: 1, sourceIds: ['unknown'] } }],
    ['duplicate character', (d: ReturnType<typeof pipelineFixture>) => d.dataset.characters.push(d.dataset.characters[0])],
    ['duplicate source', (d: ReturnType<typeof pipelineFixture>) => d.dataset.sources.push(d.dataset.sources[0])],
    ['orphan member', (d: ReturnType<typeof pipelineFixture>) => { d.dataset.collections[0].members = known(['U+FFFF']) }],
    ['overlapping grade', (d: ReturnType<typeof pipelineFixture>) => d.dataset.collections.push({ scope: 'elementary-2', members: known(['U+4E00']) })],
    ['Unicode selector', (d: ReturnType<typeof pipelineFixture>) => { d.dataset.characters[0].character += '\uFE00' }],
    ['unverified numeric value', (d: ReturnType<typeof pipelineFixture>) => Object.assign(d.dataset.characters[0].radical, { state: 'unverified', reason: 'Invented reason' })],
    ['raw strokes', (d: ReturnType<typeof pipelineFixture>) => Object.assign(d.dataset.characters[0].strokes, { value: '<svg/>' })],
    ['target level', (d: ReturnType<typeof pipelineFixture>) => Object.assign(d, { targetLevel: '4' })],
    ['missing version', (d: ReturnType<typeof pipelineFixture>) => { d.sourceVersion = '' }],
  ] as const)('rejects %s without repair', (_label, mutate) => {
    const input = pipelineFixture()
    mutate(input)
    expect(() => normalizeInput(input)).toThrow()
  })

  it('preserves supplementary and compatibility scalars without Unicode folding', () => {
    const input = pipelineFixture()
    for (const character of ['\u{20000}', '\uFA11']) {
      const row = structuredClone(input.dataset.characters[0])
      row.character = character; row.id = `U+${character.codePointAt(0)!.toString(16).toUpperCase()}`
      input.dataset.characters.push(row)
    }
    expect(normalizeInput(input).dataset.characters.map((row) => row.id)).toContain('U+FA11')
    expect(normalizeInput(input).dataset.characters.map((row) => row.id)).toContain('U+20000')
  })
})
