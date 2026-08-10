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
  useMaintenanceMode: () => ({ isOn: false }),
}))

import { useUserData } from './useUserData'

const OK: MockResponse = { data: [], error: null }
const WRITE_OPERATIONS = new Set(['upsert', 'update', 'insert', 'delete'])

function response(data: unknown[] = []): MockResponse {
  return { data, error: null }
}

function configureClient(options: {
  selects?: Record<string, MockResponse>
  upsert?: (table: string, payload: unknown, options: unknown) => Promise<MockResponse>
  onDelete?: (table: string, filters: Record<string, unknown>) => Promise<MockResponse>
  onUpdate?: (table: string, payload: unknown, filters: Record<string, unknown>) => void
}) {
  mocks.client.from = (table: string) => {
    const select = (...args: unknown[]) => {
      mocks.calls.push({ table, operation: 'select', args })
      return Promise.resolve(options.selects?.[table] ?? OK)
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

    await data.saveMineConsent(schoolId, false)

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

    await data.saveNote('00000000-0000-4000-8000-000000000010', '', '合成通学メモ')

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

    await data.deleteMine(schoolId)

    expect(mocks.harness.getResult<ReturnType<typeof useUserData>>().mine[schoolId]).toBeUndefined()
    expect(writes().filter((call) => call.operation === 'delete')).toHaveLength(1)
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
    await Promise.all([firstSave, secondSave])

    const priorityWrites = writes()
      .filter((call) => call.operation === 'upsert')
      .map((call) => (call.args[0] as { priority: number }).priority)
    expect(priorityWrites).toEqual([1, 3])
    expect(mocks.harness.getResult<ReturnType<typeof useUserData>>().favorites['00000000-0000-4000-8000-000000000010'].priority).toBe(3)
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
