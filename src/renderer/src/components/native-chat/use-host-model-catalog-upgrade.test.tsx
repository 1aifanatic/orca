// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

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

const PAIRED_TARGET = { kind: 'environment', environmentId: 'server-1' } as const
const UNKNOWN = { origin: 'unknown' }
const LISTING = { origin: 'unknown', listingInProgress: true }
const HOST_CATALOG = {
  origin: 'probe',
  models: [{ id: 'gpt-hosted', label: 'GPT Hosted', isDefault: true, efforts: [] }],
  fetchedAt: 1_000
}

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: no test here sends a pick over a fence, so mutate is never called.
const mutate = vi.fn(async () => null) as unknown as StructuredAgentSessionMutate

type Props = { hidden?: boolean; attached?: boolean }

function renderOptions(initial: Props = {}) {
  return renderHook(
    (props: Props) =>
      useStructuredAgentSessionOptions({
        agent: 'codex',
        sessionId: 'session-1',
        target: PAIRED_TARGET,
        transportEnabled: props.attached === true,
        isVisible: !props.hidden,
        providerVisible: props.attached === true && !props.hidden,
        fence: props.attached ? 1 : null,
        turnId: null,
        unloadedTurnRevisions: undefined,
        mutate,
        launch: { kind: 'new', seedOptions: { model: 'gpt-5.5' }, heldOptions: {} }
      }),
    { initialProps: initial }
  )
}

type Deferred = {
  promise: Promise<unknown>
  resolve: (value: unknown) => void
  reject: (error: unknown) => void
}

function deferred(): Deferred {
  let resolve!: (value: unknown) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<unknown>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Each catalog read takes the next answer; `options` reads never settle unless given. */
function answerCatalog(answers: (() => Promise<unknown>)[]): void {
  let index = 0
  mocks.call.mockImplementation((_target: unknown, method: string) => {
    if (method === 'agentSession.modelCatalog') {
      const next = answers[index]
      index += 1
      return next ? next() : new Promise(() => {})
    }
    return new Promise(() => {})
  })
}

function catalogReads(): unknown[] {
  return mocks.call.mock.calls
    .filter(([, method]) => method === 'agentSession.modelCatalog')
    .map(([, , params]) => params)
}

function model(snapshot: readonly SessionOptionDescriptor[]): SessionOptionDescriptor {
  return snapshot.find((entry) => entry.id === 'model')!
}

function modelChoices(snapshot: readonly SessionOptionDescriptor[]): string[] {
  const descriptor = model(snapshot)
  return descriptor.kind.type === 'select' ? descriptor.kind.choices.map((c) => c.value) : []
}

const flush = (): Promise<void> => act(async () => {})

describe('host model catalog read', () => {
  beforeEach(() => {
    mocks.call.mockReset()
  })

  it('reads a warm catalog once and never holds the picker', async () => {
    const first = deferred()
    answerCatalog([() => first.promise])
    const { result, unmount } = renderOptions()
    await flush()
    // A read in flight is not a reason to hold the picker.
    expect(model(result.current.optionSnapshot).choicesPending).toBeUndefined()
    first.resolve(HOST_CATALOG)
    await flush()
    expect(catalogReads()).toEqual([{ agent: 'codex', sessionId: 'session-1' }])
    expect(modelChoices(result.current.optionSnapshot)).toContain('gpt-hosted')
    expect(model(result.current.optionSnapshot).choicesPending).toBeUndefined()
    unmount()
  })

  it('waits once for a listing the host reports, holding the picker until it lands', async () => {
    const waited = deferred()
    answerCatalog([() => Promise.resolve(LISTING), () => waited.promise])
    const { result, unmount } = renderOptions()
    await flush()
    expect(catalogReads()).toEqual([
      { agent: 'codex', sessionId: 'session-1' },
      { agent: 'codex', sessionId: 'session-1', waitForListing: true }
    ])
    const held = model(result.current.optionSnapshot)
    expect(held).toMatchObject({ choicesPending: true, settable: false })
    // The label stays: the pill still names the launch's model.
    expect(held.kind.type === 'select' ? held.kind.currentValue : null).toBe('gpt-5.5')
    await act(async () => {
      expect(await result.current.setStructuredOption('model', 'gpt-5.5')).toBe(false)
    })

    waited.resolve(HOST_CATALOG)
    await flush()
    expect(modelChoices(result.current.optionSnapshot)).toContain('gpt-hosted')
    expect(model(result.current.optionSnapshot).choicesPending).toBeUndefined()
    expect(catalogReads()).toHaveLength(2)
    unmount()
  })

  it('releases the picker on the seed when the waiting read fails or times out', async () => {
    for (const failure of [
      () => Promise.resolve(UNKNOWN),
      () => Promise.reject(Object.assign(new Error('timed out'), { code: 'runtime_timeout' })),
      () => Promise.reject(Object.assign(new Error('gone'), { code: 'not_connected' }))
    ]) {
      mocks.call.mockReset()
      answerCatalog([() => Promise.resolve(LISTING), failure])
      const { result, unmount } = renderOptions()
      await flush()
      expect(catalogReads()).toHaveLength(2)
      expect(model(result.current.optionSnapshot).choicesPending).toBeUndefined()
      expect(model(result.current.optionSnapshot).settable).toBe(true)
      expect(modelChoices(result.current.optionSnapshot)).not.toContain('gpt-hosted')
      unmount()
    }
  })

  it('asks a host that reports no listing nothing more', async () => {
    answerCatalog([() => Promise.resolve(UNKNOWN)])
    const { result, unmount } = renderOptions()
    await flush()
    expect(catalogReads()).toHaveLength(1)
    expect(model(result.current.optionSnapshot).choicesPending).toBeUndefined()
    unmount()
  })

  it('releases the picker when the running provider reports its own list first', async () => {
    const live = deferred()
    answerCatalog([() => Promise.resolve(LISTING), () => new Promise(() => {})])
    const catalogAnswers = mocks.call.getMockImplementation()!
    mocks.call.mockImplementation((target: unknown, method: string, params: unknown) =>
      method === 'agentSession.options' ? live.promise : catalogAnswers(target, method, params)
    )
    const { result, unmount } = renderOptions({ attached: true })
    await flush()
    expect(model(result.current.optionSnapshot).choicesPending).toBe(true)
    live.resolve({
      models: [{ id: 'gpt-live', label: 'GPT Live', isDefault: true, efforts: [] }],
      current: { model: 'gpt-live', confirmed: ['model'] }
    })
    await flush()
    expect(model(result.current.optionSnapshot).choicesPending).toBeUndefined()
    expect(modelChoices(result.current.optionSnapshot)).toContain('gpt-live')
    unmount()
  })

  it('drops a waited answer that lands after the pane hid', async () => {
    const waited = deferred()
    answerCatalog([() => Promise.resolve(LISTING), () => waited.promise])
    const { result, rerender, unmount } = renderOptions()
    await flush()
    rerender({ hidden: true })
    await flush()
    expect(model(result.current.optionSnapshot).choicesPending).toBeUndefined()
    waited.resolve(HOST_CATALOG)
    await flush()
    expect(modelChoices(result.current.optionSnapshot)).not.toContain('gpt-hosted')
    unmount()
  })

  it('drops a waited answer that lands after the chat attached to a new record', async () => {
    const waited = deferred()
    answerCatalog([() => Promise.resolve(LISTING), () => waited.promise])
    const { result, rerender, unmount } = renderOptions()
    await flush()
    rerender({ attached: true })
    await flush()
    expect(model(result.current.optionSnapshot).choicesPending).toBeUndefined()
    waited.resolve(HOST_CATALOG)
    await flush()
    expect(modelChoices(result.current.optionSnapshot)).not.toContain('gpt-hosted')
    unmount()
  })
})
