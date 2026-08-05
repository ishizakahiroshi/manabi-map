import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  type Slot =
    | { kind: 'state'; value: unknown }
    | { kind: 'ref'; current: unknown }
    | { kind: 'effect'; cleanup?: () => void; deps: readonly unknown[] }

  const slots: Slot[] = []
  const auth = {
    loading: false,
    session: {
      access_token: 'synthetic-token-a',
      user: { id: '00000000-0000-4000-8000-000000000001' },
    } as { access_token: string; user: { id: string } } | null,
  }
  let cursor = 0
  let result: unknown

  const sameDeps = (left: readonly unknown[], right: readonly unknown[]) =>
    left.length === right.length && left.every((value, index) => Object.is(value, right[index]))

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
        slot.value = typeof next === 'function' ? (next as (previous: T) => T)(slot.value as T) : next
      }
      return [slot.value as T, setState] as const
    },
    useRef<T>(initial: T) {
      const index = cursor++
      if (!slots[index]) slots[index] = { kind: 'ref', current: initial }
      return slots[index] as Extract<Slot, { kind: 'ref' }> & { current: T }
    },
    useEffect(effect: () => void | (() => void), deps: readonly unknown[]) {
      const index = cursor++
      const previous = slots[index]
      if (previous?.kind === 'effect' && sameDeps(previous.deps, deps)) return
      if (previous?.kind === 'effect') previous.cleanup?.()
      const cleanup = effect()
      slots[index] = { kind: 'effect', cleanup: typeof cleanup === 'function' ? cleanup : undefined, deps }
    },
  }

  return {
    auth,
    react,
    render<T>(target: () => T) {
      cursor = 0
      result = target()
      return result
    },
    getResult<T>() {
      return result as T
    },
    reset() {
      slots.length = 0
      cursor = 0
      result = undefined
      auth.loading = false
      auth.session = {
        access_token: 'synthetic-token-a',
        user: { id: '00000000-0000-4000-8000-000000000001' },
      }
    },
  }
})

vi.mock('react', () => mocks.react)
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => mocks.auth,
}))

import { useIsAdmin } from './useIsAdmin'

async function settle() {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
}

describe('useIsAdmin transient failures', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    mocks.reset()
  })

  it('404 は直前に確認した管理者状態を保持する', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce({ ok: false, status: 404 })
    vi.stubGlobal('fetch', fetchMock)

    mocks.render(() => useIsAdmin())
    await settle()
    mocks.render(() => useIsAdmin())
    expect(mocks.getResult<ReturnType<typeof useIsAdmin>>().isAdmin).toBe(true)

    mocks.auth.session = {
      access_token: 'synthetic-token-b',
      user: { id: '00000000-0000-4000-8000-000000000001' },
    }
    mocks.render(() => useIsAdmin())
    await settle()
    mocks.render(() => useIsAdmin())

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(mocks.getResult<ReturnType<typeof useIsAdmin>>().isAdmin).toBe(true)
  })
})
