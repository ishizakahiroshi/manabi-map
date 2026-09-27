import type { SyntheticKanjiDataset } from './types'

type Row = Record<string, unknown>

function requireValue(condition: unknown, path: string): asserts condition {
  if (!condition) throw new Error(`Invalid kanji preparation data: ${path}`)
}

function row(value: unknown, keys: string[], path: string): Row {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), path)
  const result = value as Row
  requireValue(Object.keys(result).length === keys.length
    && keys.every((key) => Object.hasOwn(result, key)), `${path}: fields`)
  return result
}

function nonempty(value: unknown, path: string): asserts value is string {
  requireValue(typeof value === 'string' && value.trim().length > 0, path)
}

function strings(value: unknown, path: string, allowEmpty = false): string[] {
  requireValue(Array.isArray(value) && (allowEmpty || value.length > 0), path)
  value.forEach((item, index) => nonempty(item, `${path}[${index}]`))
  requireValue(new Set(value).size === value.length, `${path}: duplicate`)
  return value as string[]
}

function integer(value: unknown, max: number, path: string) {
  requireValue(typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= max, path)
}

const SCOPES = ['elementary-1', 'elementary-2', 'elementary-3', 'elementary-4',
  'elementary-5', 'elementary-6', 'joyo', 'non-elementary-joyo']

/** Validate untrusted JSON without coercion, I/O, or changing it. Unknown fields fail closed.
 * This checks synthetic structural consistency, not linguistic accuracy or source permissions.
 */
export function validateSyntheticKanjiDataset(input: unknown): SyntheticKanjiDataset {
  const data = row(input, ['format', 'schemaVersion', 'synthetic', 'sources', 'characters', 'collections'], 'dataset')
  requireValue(data.format === 'kanji-content-preparation' && data.schemaVersion === 1
    && data.synthetic === true, 'dataset: version/synthetic')
  requireValue(Array.isArray(data.sources) && data.sources.length > 0, 'sources')
  const sourceIds = new Set<string>()
  for (const item of data.sources) {
    const source = row(item, ['id', 'title', 'sourceVersion', 'kind'], 'source')
    nonempty(source.id, 'source.id')
    requireValue(/^[a-z][a-z0-9-]*$/.test(source.id) && !sourceIds.has(source.id), 'source.id: unique token')
    nonempty(source.title, 'source.title')
    nonempty(source.sourceVersion, 'source.sourceVersion')
    requireValue(source.kind === 'synthetic', 'source.kind')
    sourceIds.add(source.id)
  }

  function fact(value: unknown, path: string, validate: (value: unknown) => void): unknown {
    requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), path)
    const state = (value as Row).state
    if (state === 'available') {
      const item = row(value, ['state', 'value', 'sourceIds'], path)
      strings(item.sourceIds, `${path}.sourceIds`).forEach((id) => requireValue(sourceIds.has(id), `${path}: unknown source`))
      validate(item.value)
      return item.value
    }
    const item = row(value, ['state', 'reason'], path)
    requireValue(state === 'not_collected' || state === 'unverified' || state === 'not_applicable', `${path}.state`)
    nonempty(item.reason, `${path}.reason`)
    return undefined
  }

  requireValue(Array.isArray(data.characters), 'characters')
  const characterIds = new Set<string>()
  for (const item of data.characters) {
    const character = row(item, ['id', 'character', 'readings', 'strokeCount', 'radical', 'meanings', 'strokes'], 'character')
    nonempty(character.character, 'character.character')
    requireValue(/^\p{Script=Han}$/u.test(character.character), 'character: single Han scalar')
    const expectedId = `U+${character.character.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`
    requireValue(character.id === expectedId && !characterIds.has(expectedId), 'character.id: matching unique scalar')
    characterIds.add(expectedId)
    fact(character.readings, `${expectedId}.readings`, (value) => {
      const readings = row(value, ['on', 'kun'], 'readings')
      const on = strings(readings.on, 'readings.on', true)
      const kun = strings(readings.kun, 'readings.kun', true)
      requireValue(on.length + kun.length > 0, 'readings: empty')
    })
    const count = fact(character.strokeCount, `${expectedId}.strokeCount`, (value) => integer(value, 100, 'strokeCount'))
    fact(character.radical, `${expectedId}.radical`, (value) => integer(value, 214, 'radical'))
    fact(character.meanings, `${expectedId}.meanings`, (value) => {
      requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), 'meanings')
      const entries = Object.entries(value)
      requireValue(entries.length > 0, 'meanings: empty')
      for (const [lang, meanings] of entries) {
        let canonical: string | undefined
        try { canonical = Intl.getCanonicalLocales(lang)[0] } catch { /* Invalid language tag fails below. */ }
        requireValue(canonical === lang, 'meanings: canonical language')
        strings(meanings, `meanings.${lang}`)
      }
    })
    const strokes = fact(character.strokes, `${expectedId}.strokes`, (value) => {
      requireValue(Array.isArray(value) && value.length > 0 && value.length <= 100, 'strokes')
      for (const stroke of value) {
        requireValue(Array.isArray(stroke) && stroke.length >= 2, 'stroke: commands')
        stroke.forEach((raw, index) => {
          const command = row(raw, ['command', 'points'], 'stroke.command')
          requireValue(typeof command.command === 'string'
            && ['M', 'L', 'Q', 'C'].includes(command.command), 'stroke.command: type')
          requireValue(index === 0 ? command.command === 'M' : command.command !== 'M', 'stroke.command: initial move')
          const length = command.command === 'C' ? 6 : command.command === 'Q' ? 4 : 2
          requireValue(Array.isArray(command.points) && command.points.length === length
            && command.points.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 109), 'stroke.command: coordinates')
        })
      }
    })
    if (count !== undefined && strokes !== undefined) requireValue(count === (strokes as unknown[]).length, 'strokeCount: mismatch')
  }

  requireValue(Array.isArray(data.collections), 'collections')
  const scopes = new Set<string>()
  const available = new Map<string, string[]>()
  for (const item of data.collections) {
    const collection = row(item, ['scope', 'members'], 'collection')
    requireValue(typeof collection.scope === 'string' && SCOPES.includes(collection.scope)
      && !scopes.has(collection.scope), 'collection.scope: supported unique scope')
    scopes.add(collection.scope)
    const members = fact(collection.members, `${collection.scope}.members`, (value) => {
      strings(value, 'collection.members').forEach((id) => requireValue(characterIds.has(id), 'collection: unknown character'))
    })
    if (members !== undefined) available.set(collection.scope, members as string[])
  }
  const elementary = new Set<string>()
  for (const scope of SCOPES.slice(0, 6)) {
    for (const id of available.get(scope) ?? []) {
      requireValue(!elementary.has(id), 'elementary: overlapping grades')
      elementary.add(id)
    }
  }
  const joyo = available.get('joyo')
  const rest = available.get('non-elementary-joyo')
  if (joyo) for (const id of elementary) requireValue(joyo.includes(id), 'elementary: outside joyo')
  if (rest) for (const id of rest) {
    requireValue(!elementary.has(id), 'non-elementary: overlap')
    if (joyo) requireValue(joyo.includes(id), 'non-elementary: outside joyo')
  }
  if (joyo && rest && SCOPES.slice(0, 6).every((scope) => available.has(scope))) {
    requireValue(joyo.length === elementary.size + rest.length, 'joyo: incomplete partition')
  }
  return input as SyntheticKanjiDataset
}
