// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
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
  holdStructuredAgentSessionLaunchOption: vi.fn(),
  getStructuredAgentSessionLaunchSelection: () => null
}))

import type { SessionOptionDescriptor } from '../../../../shared/native-chat-session-options'
import type { StructuredAgentSessionMutate } from './use-structured-agent-session-mutate'
import { HOST_MODEL_CATALOG_REREAD_DELAYS_MS } from './use-host-model-catalog-upgrade'
import { useStructuredAgentSessionOptions } from './use-structured-agent-session-options'

const PAIRED_TARGET = { kind: 'environment', environmentId: 'server-1' } as const
const UNKNOWN = { origin: 'unknown' }
const HOST_CATALOG = {
  origin: 'probe',
  models: [{ id: 'gpt-hosted', label: 'GPT Hosted', isDefault: true, efforts: [] }],
  fetchedAt: 1_000
}
const LIVE_OPTIONS = {
  models: [{ id: 'gpt-5.5', label: 'GPT-5.5', isDefault: true, efforts: [] }],
  current: { model: 'gpt-5.5', confirmed: ['model'] }
}
const REREAD_SPAN_MS = HOST_MODEL_CATALOG_REREAD_DELAYS_MS.reduce((sum, delay) => sum + delay, 0)

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: no test here picks an option, so mutate is never called.
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

function catalogReads(): number {
  return mocks.call.mock.calls.filter(([, method]) => method === 'agentSession.modelCatalog').length
}

function modelChoices(snapshot: readonly SessionOptionDescriptor[]): string[] {
  const model = snapshot.find((entry) => entry.id === 'model')
  return model?.kind.type === 'select' ? model.kind.choices.map((choice) => choice.value) : []
}

function selectedModel(snapshot: readonly SessionOptionDescriptor[]): string | null {
  const model = snapshot.find((entry) => entry.id === 'model')
  return model?.kind.type === 'select' ? (model.kind.currentValue ?? null) : null
}

/** Each catalog read takes the next answer; the last one repeats. */
function answerCatalog(...answers: (() => Promise<unknown>)[]): void {
  let index = 0
  mocks.call.mockImplementation((_target: unknown, method: string) => {
    if (method === 'agentSession.modelCatalog') {
      const next = answers[Math.min(index, answers.length - 1)]
      index += 1
      return next()
    }
    if (method === 'agentSession.options') {
      return Promise.resolve(LIVE_OPTIONS)
    }
    return new Promise(() => {})
  })
}

const advance = (ms: number): Promise<void> => act(() => vi.advanceTimersByTimeAsync(ms))

describe('host model catalog re-read while the host lists in the background', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.call.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('delivers the host list once its background listing lands, then stops asking', async () => {
    answerCatalog(
      () => Promise.resolve(UNKNOWN),
      () => Promise.resolve(UNKNOWN),
      () => Promise.resolve(HOST_CATALOG)
    )
    const { result, unmount } = renderOptions()
    await advance(0)
    expect(catalogReads()).toBe(1)
    expect(modelChoices(result.current.optionSnapshot)).not.toContain('gpt-hosted')

    await advance(HOST_MODEL_CATALOG_REREAD_DELAYS_MS[0] + HOST_MODEL_CATALOG_REREAD_DELAYS_MS[1])
    expect(catalogReads()).toBe(3)
    // The host's list, plus its saved choice, which stays selected while the list changes under it.
    expect(modelChoices(result.current.optionSnapshot)).toEqual(['gpt-hosted', 'gpt-5.5'])
    expect(selectedModel(result.current.optionSnapshot)).toBe('gpt-5.5')

    await advance(REREAD_SPAN_MS)
    expect(catalogReads()).toBe(3)
    unmount()
  })

  it('stops after the bounded schedule when the host never lists', async () => {
    answerCatalog(() => Promise.resolve(UNKNOWN))
    const { result, unmount } = renderOptions()
    await advance(REREAD_SPAN_MS * 3)
    expect(catalogReads()).toBe(1 + HOST_MODEL_CATALOG_REREAD_DELAYS_MS.length)
    expect(modelChoices(result.current.optionSnapshot).length).toBeGreaterThan(0)
    unmount()
  })

  it('stops when the pane hides or unmounts', async () => {
    answerCatalog(() => Promise.resolve(UNKNOWN))
    const { rerender, unmount } = renderOptions()
    await advance(0)
    rerender({ hidden: true })
    await advance(REREAD_SPAN_MS)
    expect(catalogReads()).toBe(1)

    rerender({})
    await advance(0)
    expect(catalogReads()).toBe(2)
    unmount()
    await advance(REREAD_SPAN_MS)
    expect(catalogReads()).toBe(2)
  })

  it('stops once the running provider reports its own list', async () => {
    answerCatalog(() => Promise.resolve(UNKNOWN))
    const { result, unmount } = renderOptions({ attached: true })
    await advance(0)
    expect(selectedModel(result.current.optionSnapshot)).toBe('gpt-5.5')
    await advance(REREAD_SPAN_MS)
    expect(catalogReads()).toBe(1)
    unmount()
  })

  it('does not re-read a host that predates the surface', async () => {
    for (const code of ['method_not_found', 'forbidden']) {
      mocks.call.mockReset()
      answerCatalog(() => Promise.reject(Object.assign(new Error(code), { code })))
      const { result, unmount } = renderOptions()
      await advance(REREAD_SPAN_MS)
      expect(catalogReads()).toBe(1)
      expect(selectedModel(result.current.optionSnapshot)).toBe('gpt-5.5')
      unmount()
    }
  })
})
