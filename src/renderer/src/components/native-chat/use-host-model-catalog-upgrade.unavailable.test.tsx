// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ call: vi.fn() }))

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))

vi.mock('./native-chat-session-option-settings-write', () => ({
  enqueueSessionOptionSettingsWrite: vi.fn()
}))

vi.mock('@/lib/structured-agent-session-launch-options', () => ({
  holdStructuredAgentSessionLaunchOption: vi.fn(() => Promise.resolve({ kind: 'held' })),
  getStructuredAgentSessionLaunchSelection: () => null
}))

import type { SessionOptionDescriptor } from '../../../../shared/native-chat-session-options'
import type { StructuredAgentSessionMutate } from './use-structured-agent-session-mutate'
import { useStructuredAgentSessionOptions } from './use-structured-agent-session-options'

// The host's sign-in verdict as a chat holds it: kept until the next answer replaces it, read
// again on focus only while it blocks, and cleared by a failed read.

const LOCAL_TARGET = { kind: 'local' } as const
const SIGNED_OUT = { reason: 'notSignedIn', account: 'system' } as const
const HOST_CATALOG = {
  origin: 'probe',
  models: [{ id: 'gpt-hosted', label: 'GPT Hosted', isDefault: true, efforts: [] }],
  fetchedAt: 1_000
}

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: no test here sends a pick, so mutate is never called.
const mutate = vi.fn(async () => null) as unknown as StructuredAgentSessionMutate

let sessionId = ''
let sessionCount = 0

function renderOptions() {
  return renderHook(() =>
    useStructuredAgentSessionOptions({
      agent: 'codex',
      sessionId,
      target: LOCAL_TARGET,
      transportEnabled: false,
      isVisible: true,
      providerVisible: false,
      fence: null,
      turnId: null,
      unloadedTurnRevisions: undefined,
      mutate,
      launch: { kind: 'new', seedOptions: { model: 'gpt-5.5' }, heldOptions: {} }
    })
  )
}

type Answer = { resolve: (value: unknown) => void; reject: (error: unknown) => void }

/** Every catalog read waits for the test to answer it, in order. */
function catalogReads() {
  const pending: Answer[] = []
  mocks.call.mockImplementation((_target: unknown, method: string) =>
    method === 'agentSession.modelCatalog'
      ? new Promise((resolve, reject) => pending.push({ resolve, reject }))
      : new Promise(() => {})
  )
  return {
    count: () =>
      mocks.call.mock.calls.filter(([, method]) => method === 'agentSession.modelCatalog').length,
    params: (index: number) =>
      mocks.call.mock.calls.filter(([, method]) => method === 'agentSession.modelCatalog')[
        index
      ]?.[2],
    answer: async (index: number, value: unknown) => {
      pending[index]!.resolve(value)
      await act(async () => {})
    },
    fail: async (index: number) => {
      pending[index]!.reject(new Error('runtime_unavailable'))
      await act(async () => {})
    }
  }
}

function modelChoices(snapshot: readonly SessionOptionDescriptor[]): string[] {
  const descriptor = snapshot.find((entry) => entry.id === 'model')!
  return descriptor.kind.type === 'select' ? descriptor.kind.choices.map((c) => c.value) : []
}

const focusWindow = (): Promise<void> =>
  act(async () => {
    window.dispatchEvent(new Event('focus'))
  })

describe("a chat's sign-in verdict", () => {
  beforeEach(() => {
    mocks.call.mockReset()
    sessionCount += 1
    sessionId = `verdict-session-${sessionCount}`
  })
  // A mounted chat still blocked from an earlier test would read on this test's focus.
  afterEach(cleanup)

  it('holds the verdict through a re-read and lets only its answer clear it', async () => {
    const reads = catalogReads()
    const { result } = renderOptions()
    await reads.answer(0, { ...HOST_CATALOG, unavailable: SIGNED_OUT })
    expect(result.current.unavailable).toEqual(SIGNED_OUT)
    expect(modelChoices(result.current.optionSnapshot)).toContain('gpt-hosted')

    await act(async () => {
      result.current.recheckUnavailable?.()
    })
    expect(reads.count()).toBe(2)
    await reads.answer(1, { ...HOST_CATALOG, unavailable: SIGNED_OUT })
    await focusWindow()
    expect(reads.count()).toBe(3)
    // No enable flash while the re-read is out.
    expect(result.current.unavailable).toEqual(SIGNED_OUT)
    await reads.answer(2, HOST_CATALOG)
    expect(result.current.unavailable).toBeNull()
    expect(result.current.recheckUnavailable).toBeUndefined()
  })

  it('reads again on window focus or a recheck only while blocked', async () => {
    const reads = catalogReads()
    const { result } = renderOptions()
    await reads.answer(0, HOST_CATALOG)
    await focusWindow()
    expect(reads.count()).toBe(1)
    expect(result.current.recheckUnavailable).toBeUndefined()

    await act(async () => {
      result.current.recheckUnavailable?.()
    })
    expect(reads.count()).toBe(1)
  })

  it('clears on a failed read: unknown never blocks', async () => {
    const reads = catalogReads()
    const { result } = renderOptions()
    await reads.answer(0, { origin: 'unknown', unavailable: SIGNED_OUT })
    await focusWindow()
    await reads.fail(1)
    expect(result.current.unavailable).toBeNull()
  })

  it('follows a probe the host is re-running beside a catalog with one waiting read', async () => {
    const reads = catalogReads()
    const { result } = renderOptions()
    await reads.answer(0, { ...HOST_CATALOG, unavailable: SIGNED_OUT, listingInProgress: true })
    expect(reads.count()).toBe(2)
    expect(reads.params(1)).toEqual({ agent: 'codex', sessionId, waitForListing: true })
    // The catalog in hand is shown; only Send waits on the answer.
    const model = result.current.optionSnapshot.find((entry) => entry.id === 'model')!
    expect(model.choicesPending).toBeUndefined()
    expect(result.current.unavailable).toEqual(SIGNED_OUT)
    await reads.answer(1, HOST_CATALOG)
    expect(result.current.unavailable).toBeNull()
  })

  it('a blocked past-TTL re-read with no catalog does not set choicesPending', async () => {
    const reads = catalogReads()
    const { result } = renderOptions()
    await reads.answer(0, { origin: 'unknown', unavailable: SIGNED_OUT, listingInProgress: true })
    expect(reads.params(1)).toEqual({ agent: 'codex', sessionId, waitForListing: true })
    const model = result.current.optionSnapshot.find((entry) => entry.id === 'model')!
    expect(model.choicesPending).toBeUndefined()
  })
})
