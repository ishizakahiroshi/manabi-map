import { afterEach, describe, expect, it, vi } from 'vitest'

type MockError = { message: string }
type MockResponse = { data: unknown[] | null; error: MockError | null }
type MockCall = { table: string; operation: string; args: unknown[] }

const mocks = vi.hoisted(() => {
  type Slot =
    | { kind: 'state'; value: unknown }
    | { kind: 'ref'; current: unknown }
    | { kind: 'memo'; value: unknown; deps: readonly unknown[] }
    | { kind: 'effect'; cleanup?: () => void; deps: readonly unknown[] }

  const slots: Slot[] = []
  const calls: MockCall[] = []
  const state = {
    session: { user: { id: '00000000-0000-4000-8000-000000000001' } } as { user: { id: string } } | null,
    toast: vi.fn(),
    maintenance: false,
  }
  let cursor = 0
  let currentResult: unknown
  let renderTarget: (() => unknown) | null = null
  let pendingEffects: Array<() => void> = []
  let rendering = false
  let rerenderRequested = false

  const sameDeps = (left: readonly unknown[], right: readonly unknown[]) =>
    left.length === right.length && left.every((value, index) => Object.is(value, right[index]))

  const requestRender = () => {
    if (!renderTarget) return
    if (rendering) {
      rerenderRequested = true
      return
    }
    renderNow()
  }

  const renderNow = () => {
    if (!renderTarget || rendering) return
    rendering = true
    cursor = 0
    pendingEffects = []
    currentResult = renderTarget()
    for (const runEffect of pendingEffects) runEffect()
    rendering = false
    if (rerenderRequested) {
      rerenderRequested = false
      renderNow()
    }
  }

  const react = {
    useState<T>(initial: T | (() => T)) {
      const index = cursor++
      if (!slots[index]) {
        slots[index] = {
          kind: 'state',
          value: typeof initial === 'function' ? (initial as () => T)() : initial,
        }
      }
      const slot = slots[index] as Extract<Slot, { kind: 'state' }>
      const setState = (next: T | ((previous: T) => T)) => {
        const previous = slot.value as T
        slot.value = typeof next === 'function' ? (next as (previous: T) => T)(previous) : next
        requestRender()
      }
      return [slot.value as T, setState] as const
    },
    useRef<T>(initial: T) {
      const index = cursor++
      if (!slots[index]) slots[index] = { kind: 'ref', current: initial }
      return slots[index] as Extract<Slot, { kind: 'ref' }> & { current: T }
    },
    useCallback<T extends (...args: any[]) => any>(callback: T, deps: readonly unknown[]) {
      const index = cursor++
      const previous = slots[index]
      if (!previous || previous.kind !== 'memo' || !sameDeps(previous.deps, deps)) {
        slots[index] = { kind: 'memo', value: callback, deps }
      }
      return (slots[index] as Extract<Slot, { kind: 'memo' }>).value as T
    },
    useEffect(effect: () => void | (() => void), deps: readonly unknown[]) {
      const index = cursor++
      const previous = slots[index]
      if (previous?.kind === 'effect' && sameDeps(previous.deps, deps)) return
      pendingEffects.push(() => {
        if (previous?.kind === 'effect') previous.cleanup?.()
        const cleanup = effect()
        slots[index] = { kind: 'effect', cleanup: typeof cleanup === 'function' ? cleanup : undefined, deps }
      })
    },
  }

  const client: { from: (table: string) => any } = {
    from: (_table: string) => {
      throw new Error('Supabase mock was not configured')
    },
  }

  return {
    client,
    calls,
    state,
    react,
    harness: {
      mount(target: () => unknown) {
        slots.length = 0
        cursor = 0
        currentResult = undefined
        renderTarget = target
        renderNow()
      },
      rerender() {
        renderNow()
      },
      getResult<T>() {
        return currentResult as T
      },
      reset() {
        slots.length = 0
        cursor = 0
        currentResult = undefined
        renderTarget = null
        pendingEffects = []
        rendering = false
        rerenderRequested = false
      },
    },
  }
})

vi.mock('react', () => mocks.react)
vi.mock('../lib/supabase', () => ({ supabase: mocks.client }))
vi.mock('../lib/analytics', () => ({ trackEvent: vi.fn() }))
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ session: mocks.state.session }),
}))
vi.mock('../contexts/AppContext', () => ({
  useApp: () => ({ toast: mocks.state.toast }),
}))
vi.mock('../contexts/I18nContext', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}))
vi.mock('./useMaintenanceMode', () => ({
  useMaintenanceMode: () => ({ isOn: mocks.state.maintenance }),
}))

import { useUserData } from './useUserData'

const OK: MockResponse = { data: [], error: null }
const WRITE_OPERATIONS = new Set(['upsert', 'update', 'insert', 'delete'])

function response(data: unknown[] = []): MockResponse {
  return { data, error: null }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => { resolve = next })
  return { promise, resolve }
}

function configureClient(options: {
  selects?: Record<string, MockResponse>
  select?: (table: string) => Promise<MockResponse>
  upsert?: (table: string, payload: unknown, options: unknown) => Promise<MockResponse>
  onDelete?: (table: string, filters: Record<string, unknown>) => Promise<MockResponse>
  onUpdate?: (table: string, payload: unknown, filters: Record<string, unknown>) => void
}) {
  mocks.client.from = (table: string) => {
    const select = (...args: unknown[]) => {
      mocks.calls.push({ table, operation: 'select', args })
      return options.select?.(table) ?? Promise.resolve(options.selects?.[table] ?? OK)
    }
    const upsert = (payload: unknown, upsertOptions: unknown) => {
      mocks.calls.push({ table, operation: 'upsert', args: [payload, upsertOptions] })
      return options.upsert?.(table, payload, upsertOptions) ?? Promise.resolve(OK)
    }
    const update = (payload: unknown) => {
      mocks.calls.push({ table, operation: 'update', args: [payload] })
      const filters: Record<string, unknown> = {}
      const builder = {
        eq(column: string, value: unknown) {
          filters[column] = value
          mocks.calls.push({ table, operation: 'eq', args: [column, value] })
          return builder
        },
        not(column: string, operator: string, value: unknown) {
          mocks.calls.push({ table, operation: 'not', args: [column, operator, value] })
          options.onUpdate?.(table, payload, { ...filters, [`not:${column}`]: [operator, value] })
          return Promise.resolve(OK)
        },
      }
      return builder
    }
    const remove = () => {
      mocks.calls.push({ table, operation: 'delete', args: [] })
      const filters: Record<string, unknown> = {}
      const builder = {
        eq(column: string, value: unknown) {
          filters[column] = value
          mocks.calls.push({ table, operation: 'eq', args: [column, value] })
          return builder
        },
        then(resolve: (value: MockResponse) => unknown, reject: (reason: unknown) => unknown) {
          return (options.onDelete?.(table, { ...filters }) ?? Promise.resolve(OK)).then(resolve, reject)
        },
      }
      return builder
    }
    return { select, upsert, update, delete: remove }
  }
}

async function settle() {
  for (let index = 0; index < 12; index += 1) await Promise.resolve()
}

function mount() {
  mocks.harness.mount(() => useUserData())
  return mocks.harness.getResult<ReturnType<typeof useUserData>>()
}

function writes() {
  return mocks.calls.filter((call) => WRITE_OPERATIONS.has(call.operation))
}

describe('useUserData audit regressions', () => {
  afterEach(() => {
    mocks.harness.reset()
    mocks.calls.length = 0
    mocks.state.session = { user: { id: '00000000-0000-4000-8000-000000000001' } }
    mocks.state.maintenance = false
    mocks.state.toast.mockReset()
  })

  it('同意 OFF はセンチネル行と学科行の visibility を private に揃える', async () => {
    const schoolId = '00000000-0000-4000-8000-000000000010'
    const departmentRow = {
      user_id: mocks.state.session?.user.id,
      school_id: schoolId,
      department_id: '00000000-0000-4000-8000-000000000011',
      value: 62,
      note: null,
      visibility: 'submit_to_manabi',
    }
    const sentinelRow = {
      user_id: mocks.state.session?.user.id,
      school_id: schoolId,
      department_id: null,
      value: 0,
      note: '合成メモ',
      visibility: 'submit_to_manabi',
    }
    const deviationRows = [departmentRow, sentinelRow]
    configureClient({
      selects: {
        user_school_favorites: response(),
        user_school_notes: response(),
        user_school_deviations: response(deviationRows),
      },
      onUpdate: (_table, payload) => {
        for (const row of deviationRows) {
          if (row.department_id !== null) Object.assign(row, payload)
        }
      },
      upsert: (_table, payload) => {
        Object.assign(sentinelRow, payload)
        return Promise.resolve(OK)
      },
    })

    const data = mount()
    await settle()
    mocks.calls.length = 0

    await expect(data.saveMineConsent(schoolId, false)).resolves.toBe('success')

    expect(departmentRow.visibility).toBe('private')
    expect(sentinelRow.visibility).toBe('private')
    expect(writes().filter((call) => call.operation === 'upsert')).toHaveLength(1)
    expect(writes().filter((call) => call.operation === 'update')).toHaveLength(1)
    expect(mocks.calls.some((call) => call.operation === 'not' && call.args[0] === 'department_id')).toBe(true)
  })

  it('loadError 時の saveNote は Supabase を呼ばず空上書きを防ぐ', async () => {
    configureClient({
      selects: {
        user_school_favorites: response(),
        user_school_notes: { data: null, error: { message: 'synthetic notes load failure' } },
        user_school_deviations: response(),
      },
    })

    mount()
    await settle()
    const data = mocks.harness.getResult<ReturnType<typeof useUserData>>()
    expect(data.loadError).toBe(true)
    mocks.calls.length = 0

    await expect(
      data.saveNote('00000000-0000-4000-8000-000000000010', '', '合成通学メモ'),
    ).resolves.toBe('blocked')

    expect(writes()).toEqual([])
    expect(mocks.state.toast).toHaveBeenCalledWith('common.dataLoadFailed')
  })

  it('loadError 時の deleteNote は blocked を返し、成功扱いできない', async () => {
    const schoolId = '00000000-0000-4000-8000-000000000010'
    configureClient({
      selects: {
        user_school_favorites: response(),
        user_school_notes: { data: null, error: { message: 'synthetic notes load failure' } },
        user_school_deviations: response(),
      },
    })

    mount()
    await settle()
    mocks.calls.length = 0

    const result = await mocks.harness.getResult<ReturnType<typeof useUserData>>().deleteNote(schoolId)

    expect(result).toBe('blocked')
    expect(writes()).toEqual([])
    expect(mocks.state.toast).toHaveBeenCalledWith('common.dataLoadFailed')
  })

  it('deleteNote は本人のメモ行を削除し、失敗時は元に戻す', async () => {
    const schoolId = '00000000-0000-4000-8000-000000000010'
    configureClient({
      selects: {
        user_school_favorites: response(),
        user_school_notes: response([{ school_id: schoolId, note: '合成メモ', commute_note: '' }]),
        user_school_deviations: response(),
      },
      onDelete: async (_table, filters) => {
        expect(filters).toEqual({
          user_id: '00000000-0000-4000-8000-000000000001',
          school_id: schoolId,
        })
        return { data: null, error: { message: 'synthetic delete failure' } }
      },
    })

    mount()
    await settle()
    mocks.calls.length = 0
    const data = mocks.harness.getResult<ReturnType<typeof useUserData>>()

    await expect(data.deleteNote(schoolId)).rejects.toEqual({ message: 'synthetic delete failure' })
    const restored = mocks.harness.getResult<ReturnType<typeof useUserData>>().notes[schoolId]
    expect(restored).toEqual({ school_id: schoolId, note: '合成メモ', commute_note: '' })
    expect(writes().filter((call) => call.operation === 'delete')).toHaveLength(1)
  })

  it('deleteMine は学校単位の全記録を削除する', async () => {
    const schoolId = '00000000-0000-4000-8000-000000000010'
    const departmentId = '00000000-0000-4000-8000-000000000011'
    configureClient({
      selects: {
        user_school_favorites: response(),
        user_school_notes: response(),
        user_school_deviations: response([
          { school_id: schoolId, department_id: departmentId, value: 38, note: null, visibility: 'private' },
          { school_id: schoolId, department_id: null, value: 0, note: '合成記録', visibility: 'private' },
        ]),
      },
      onDelete: async (_table, filters) => {
        expect(filters).toEqual({
          user_id: '00000000-0000-4000-8000-000000000001',
          school_id: schoolId,
        })
        return OK
      },
    })

    mount()
    await settle()
    const data = mocks.harness.getResult<ReturnType<typeof useUserData>>()

    await expect(data.deleteMine(schoolId)).resolves.toBe('success')

    expect(mocks.harness.getResult<ReturnType<typeof useUserData>>().mine[schoolId]).toBeUndefined()
    expect(writes().filter((call) => call.operation === 'delete')).toHaveLength(1)
  })

  it('お気に入りの blocked 結果を追加契約で識別し、既存 boolean 契約も維持する', async () => {
    const schoolId = '00000000-0000-4000-8000-000000000010'
    configureClient({
      selects: {
        user_school_favorites: response([{ school_id: schoolId, priority: 3, status: 'interested' }]),
        user_school_notes: response(),
        user_school_deviations: response(),
      },
    })

    const data = mount()
    await settle()
    mocks.calls.length = 0
    mocks.state.maintenance = true
    mocks.harness.rerender()

    await expect(data.toggleFavoriteWithResult(schoolId)).resolves.toEqual({ status: 'blocked', isFavorite: true })
    await expect(data.toggleFavorite(schoolId)).resolves.toBe(true)
    expect(writes()).toEqual([])
  })

  it('maintenance 中の deleteMine は blocked を返し state と DB を変更しない', async () => {
    const schoolId = '00000000-0000-4000-8000-000000000010'
    configureClient({
      selects: {
        user_school_favorites: response(),
        user_school_notes: response(),
        user_school_deviations: response([
          { school_id: schoolId, department_id: '00000000-0000-4000-8000-000000000011', value: 38, note: null, visibility: 'private' },
        ]),
      },
    })

    mount()
    await settle()
    const before = mocks.harness.getResult<ReturnType<typeof useUserData>>().mine[schoolId]
    mocks.calls.length = 0
    mocks.state.maintenance = true
    mocks.harness.rerender()

    const result = await mocks.harness.getResult<ReturnType<typeof useUserData>>().deleteMine(schoolId)

    expect(result).toBe('blocked')
    expect(mocks.harness.getResult<ReturnType<typeof useUserData>>().mine[schoolId]).toEqual(before)
    expect(writes()).toEqual([])
    expect(mocks.state.toast).toHaveBeenCalledWith('maintenance.toast')
  })

  it('maintenance 中の保存系 mutation は全て blocked を返し state と DB を変更しない', async () => {
    const schoolId = '00000000-0000-4000-8000-000000000010'
    const departmentId = '00000000-0000-4000-8000-000000000011'
    configureClient({
      selects: {
        user_school_favorites: response([{ school_id: schoolId, priority: 2, status: 'interested' }]),
        user_school_notes: response([{ school_id: schoolId, note: '合成メモ', commute_note: '' }]),
        user_school_deviations: response([{
          school_id: schoolId,
          department_id: departmentId,
          value: 38,
          note: null,
          visibility: 'private',
        }]),
      },
    })

    mount()
    await settle()
    const data = mocks.harness.getResult<ReturnType<typeof useUserData>>()
    const before = {
      favorites: data.favorites,
      notes: data.notes,
      mine: data.mine,
    }
    mocks.calls.length = 0
    mocks.state.maintenance = true
    mocks.harness.rerender()

    await expect(data.setPriority(schoolId, 4)).resolves.toBe('blocked')
    await expect(data.saveNote(schoolId, '変更後', '通学メモ')).resolves.toBe('blocked')
    await expect(data.saveMineValue(schoolId, departmentId, 55)).resolves.toBe('blocked')
    await expect(data.saveMineNote(schoolId, '個人メモ変更後')).resolves.toBe('blocked')
    await expect(data.saveMineConsent(schoolId, true)).resolves.toBe('blocked')

    const after = mocks.harness.getResult<ReturnType<typeof useUserData>>()
    expect(after.favorites).toEqual(before.favorites)
    expect(after.notes).toEqual(before.notes)
    expect(after.mine).toEqual(before.mine)
    expect(writes()).toEqual([])
  })

  it('setPriority の連打は DB 書込を直列化し最後の値へ収束する', async () => {
    let firstResolve!: (result: MockResponse) => void
    let secondResolve!: (result: MockResponse) => void
    const first = new Promise<MockResponse>((resolve) => { firstResolve = resolve })
    const second = new Promise<MockResponse>((resolve) => { secondResolve = resolve })
    let upsertCount = 0
    configureClient({
      selects: {
        user_school_favorites: response([{
          school_id: '00000000-0000-4000-8000-000000000010',
          priority: 2,
          status: 'interested',
        }]),
        user_school_notes: response(),
        user_school_deviations: response(),
      },
      upsert: () => {
        upsertCount += 1
        return upsertCount === 1 ? first : second
      },
    })

    const data = mount()
    await settle()
    mocks.calls.length = 0

    const firstSave = data.setPriority('00000000-0000-4000-8000-000000000010', 1)
    await settle()
    const secondSave = data.setPriority('00000000-0000-4000-8000-000000000010', 3)
    await settle()
    expect(writes().filter((call) => call.operation === 'upsert')).toHaveLength(1)

    firstResolve(OK)
    await settle()
    expect(writes().filter((call) => call.operation === 'upsert')).toHaveLength(2)
    secondResolve(OK)
    await expect(firstSave).resolves.toBe('success')
    await expect(secondSave).resolves.toBe('success')

    const priorityWrites = writes()
      .filter((call) => call.operation === 'upsert')
      .map((call) => (call.args[0] as { priority: number }).priority)
    expect(priorityWrites).toEqual([1, 3])
    expect(mocks.harness.getResult<ReturnType<typeof useUserData>>().favorites['00000000-0000-4000-8000-000000000010'].priority).toBe(3)
  })

  it('userId 切替直後の render は旧ユーザーの個人データを返さず、B の完了後だけ B を返す', async () => {
    const userA = '00000000-0000-4000-8000-000000000001'
    const userB = '00000000-0000-4000-8000-000000000002'
    const schoolA = '00000000-0000-4000-8000-000000000010'
    const schoolB = '00000000-0000-4000-8000-000000000020'
    configureClient({
      select: (table) => {
        const isB = mocks.state.session?.user.id === userB
        const rows: Record<string, unknown[]> = {
          user_school_favorites: [{ school_id: isB ? schoolB : schoolA, priority: 3, status: 'interested' }],
          user_school_notes: [{ school_id: isB ? schoolB : schoolA, note: isB ? 'B の合成メモ' : 'A の合成メモ', commute_note: '' }],
          user_school_deviations: [{ school_id: isB ? schoolB : schoolA, department_id: null, value: 0, note: isB ? 'B の合成記録' : 'A の合成記録', visibility: 'private' }],
        }
        return Promise.resolve(response(rows[table]))
      },
    })

    mount()
    await settle()
    expect(Object.keys(mocks.harness.getResult<ReturnType<typeof useUserData>>().favorites)).toEqual([schoolA])

    mocks.state.session = { user: { id: userB } }
    mocks.harness.rerender()
    const duringSwitch = mocks.harness.getResult<ReturnType<typeof useUserData>>()
    expect(duringSwitch.favorites).toEqual({})
    expect(duringSwitch.notes).toEqual({})
    expect(duringSwitch.mine).toEqual({})
    expect(duringSwitch.loading).toBe(true)
    expect(duringSwitch.loadError).toBe(false)

    await settle()
    const afterSwitch = mocks.harness.getResult<ReturnType<typeof useUserData>>()
    expect(Object.keys(afterSwitch.favorites)).toEqual([schoolB])
    expect(Object.keys(afterSwitch.notes)).toEqual([schoolB])
    expect(Object.keys(afterSwitch.mine)).toEqual([schoolB])
    expect(afterSwitch.notes[schoolB].note).toBe('B の合成メモ')
    expect(afterSwitch.notes[userA]).toBeUndefined()
  })

  it('sign out 直後の render は旧ユーザーの個人データと件数を返さない', async () => {
    const schoolId = '00000000-0000-4000-8000-000000000010'
    configureClient({
      selects: {
        user_school_favorites: response([{ school_id: schoolId, priority: 3, status: 'interested' }]),
        user_school_notes: response([{ school_id: schoolId, note: '合成メモ', commute_note: '' }]),
        user_school_deviations: response([{ school_id: schoolId, department_id: null, value: 0, note: '合成記録', visibility: 'private' }]),
      },
    })

    mount()
    await settle()
    mocks.state.session = null
    mocks.harness.rerender()

    const afterSignOut = mocks.harness.getResult<ReturnType<typeof useUserData>>()
    expect(afterSignOut.favorites).toEqual({})
    expect(afterSignOut.notes).toEqual({})
    expect(afterSignOut.mine).toEqual({})
    expect(afterSignOut.loading).toBe(false)
    expect(afterSignOut.loadError).toBe(false)
  })

  it('古いユーザーの遅延 load response は新ユーザーの state を上書きしない', async () => {
    const userA = '00000000-0000-4000-8000-000000000001'
    const userB = '00000000-0000-4000-8000-000000000002'
    const schoolA = '00000000-0000-4000-8000-000000000010'
    const schoolB = '00000000-0000-4000-8000-000000000020'
    const pending = {
      user_school_favorites: deferred<MockResponse>(),
      user_school_notes: deferred<MockResponse>(),
      user_school_deviations: deferred<MockResponse>(),
    }
    const bRows: Record<string, MockResponse> = {
      user_school_favorites: response([{ school_id: schoolB, priority: 2, status: 'interested' }]),
      user_school_notes: response([{ school_id: schoolB, note: 'B の合成メモ', commute_note: '' }]),
      user_school_deviations: response(),
    }
    configureClient({
      select: (table) => mocks.state.session?.user.id === userA
        ? pending[table as keyof typeof pending].promise
        : Promise.resolve(bRows[table] ?? OK),
    })

    mount()
    mocks.state.session = { user: { id: userB } }
    mocks.harness.rerender()
    await settle()
    expect(Object.keys(mocks.harness.getResult<ReturnType<typeof useUserData>>().favorites)).toEqual([schoolB])

    pending.user_school_favorites.resolve(response([{ school_id: schoolA, priority: 3, status: 'interested' }]))
    pending.user_school_notes.resolve(response([{ school_id: schoolA, note: 'A の遅延メモ', commute_note: '' }]))
    pending.user_school_deviations.resolve(response([{ school_id: schoolA, department_id: null, value: 0, note: 'A の遅延記録', visibility: 'private' }]))
    await settle()

    const result = mocks.harness.getResult<ReturnType<typeof useUserData>>()
    expect(Object.keys(result.favorites)).toEqual([schoolB])
    expect(result.notes[schoolB]?.note).toBe('B の合成メモ')
    expect(result.notes[schoolA]).toBeUndefined()
    expect(result.mine[schoolA]).toBeUndefined()
  })

  it('userId が null になったロードは loading=false で終わる', async () => {
    mocks.state.session = null
    configureClient({})

    const data = mount()
    await settle()

    expect(data.loading).toBe(false)
    expect(data.loadError).toBe(false)
    expect(mocks.calls).toEqual([])
  })
})
