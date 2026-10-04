// @vitest-environment happy-dom

// A message the host refused is back in the composer and never goes out again on its own, however
// the chat's agent owner moves; nor does one an older build held for a Retry. A send still in
// flight when the owner moves, on a host not known to record sends before starting an agent, goes
// out again under its id.

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const regained: (() => void)[] = []
  return { call: vi.fn(), probe: vi.fn(), regained }
})

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call
}))
vi.mock('@/runtime/runtime-rpc-client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runtimeEnvironmentSupportsCapability: mocks.probe
}))
vi.mock('@/runtime/runtime-host-contact-regained', () => ({
  subscribeRuntimeHostContactRegained: (_environmentId: string, listener: () => void) => {
    mocks.regained.push(listener)
    return () => {}
  }
}))

import type { AgentSessionWireRefusalCode } from '../../../../shared/agent-session-wire'
import { createStructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'
import { useStructuredAgentSessionOutbox } from './use-structured-agent-session-outbox'

type SendRequest = { envelope?: { clientOperationId?: string; expectedRuntimeFence?: number } }

// Stable, as the view passes it: a new object each render would re-run the owner-change requeue.
const TARGET = { kind: 'environment', environmentId: 'env-1' } as const

function requestId(params: SendRequest | undefined): string {
  return String(params?.envelope?.clientOperationId)
}

function sentIds(): string[] {
  return mocks.call.mock.calls.map((call) => requestId(call[2]))
}

/** Each send as `id@fence`, so a resend on a new owner is told from the first attempt. */
function sentAttempts(): string[] {
  return mocks.call.mock.calls.map((call) => {
    const params: SendRequest | undefined = call[2]
    return `${requestId(params)}@${String(params?.envelope?.expectedRuntimeFence)}`
  })
}

const QUEUED = { ok: true, replayed: false, fence: 2, value: { queued: {} } }

/** Saved by an older build, held for its Retry under an id already sent once. */
function heldEntry(clientMessageId: string, code: AgentSessionWireRefusalCode): unknown {
  return {
    ...createStructuredAgentSessionOutboxEntry({
      clientMessageId,
      sessionId: 'session-1',
      text: 'held',
      attachments: [],
      queuedAt: 1
    }),
    lastAttemptAt: 2,
    lastFailure: { kind: 'refused', code }
  }
}

function writeSaved(entries: unknown[]): void {
  localStorage.setItem(
    'orca:desktopStructuredAgentSessionOutbox:v1:session-1',
    JSON.stringify(entries)
  )
}

async function settle(): Promise<void> {
  await act(() => new Promise<void>((resolve) => setTimeout(resolve, 50)))
}

function mount(fence: number) {
  return renderHook(
    ({ fence: current }: { fence: number }) =>
      useStructuredAgentSessionOutbox({
        sessionId: 'session-1',
        target: TARGET,
        fence: current,
        submissions: []
      }),
    { initialProps: { fence } }
  )
}

function refusal(code: string) {
  return { ok: false, refusal: { code, message: code } }
}

async function refusedOnce(code: string) {
  mocks.call.mockResolvedValue(refusal(code))
  const hook = mount(1)
  await settle()
  act(() => void hook.result.current.send('hello'))
  await settle()
  expect(sentIds()).toHaveLength(1)
  // A first attempt the host refused proves no record: it is back in the composer.
  expect(hook.result.current.outbox).toEqual([])
  return hook
}

describe('a refused or held message when the chat gets a new owner', () => {
  beforeEach(() => {
    localStorage.clear()
    mocks.call.mockReset()
    mocks.probe.mockReset()
    mocks.regained.length = 0
  })

  afterEach(() => cleanup())

  it('is not sent on a current host whose capability probe fails after the owner moved', async () => {
    mocks.probe.mockResolvedValue(true)
    const hook = await refusedOnce('agent_session_checkpoint_stale')
    hook.rerender({ fence: 2 })
    await settle()
    mocks.probe.mockRejectedValueOnce(new Error('status timeout'))
    act(() => mocks.regained.forEach((listener) => listener()))
    await settle()
    expect(sentIds()).toHaveLength(1)
  })

  it('is not sent while the capability probe has not answered', async () => {
    mocks.probe.mockReturnValue(new Promise(() => {}))
    const hook = await refusedOnce('agent_session_checkpoint_stale')
    hook.rerender({ fence: 2 })
    await settle()
    expect(sentIds()).toHaveLength(1)
  })

  it.each([
    'agent_session_owner_restart_failed',
    'agent_session_checkpoint_stale',
    'agent_session_conflict',
    'agent_session_ownership_unknown',
    'execution_owner_reconciling',
    'agent_session_journal_unreadable',
    'agent_session_operation_capacity'
  ] as const)(
    'is never sent when an older build held it after %s, on a host known to be older, when the owner moves',
    async (code) => {
      mocks.probe.mockResolvedValue(false)
      writeSaved([heldEntry('op-held', code)])
      mocks.call.mockResolvedValue(QUEUED)
      const hook = mount(1)
      await settle()
      hook.rerender({ fence: 2 })
      await settle()
      expect(sentIds()).toEqual([])
      expect(hook.result.current.outbox).toMatchObject([
        { clientMessageId: 'op-held', legacyUnsettled: true }
      ])
    }
  )

  it('sends again under its id a send with no answer, on a host known to be older, once the owner moves', async () => {
    mocks.probe.mockResolvedValue(false)
    mocks.call.mockRejectedValueOnce(new Error('send failed')).mockResolvedValue(QUEUED)
    const hook = mount(1)
    await settle()
    act(() => void hook.result.current.send('hello'))
    await settle()
    expect(hook.result.current.outbox[0]?.state).toBe('unconfirmed')
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 1200)))
    expect(sentIds()).toHaveLength(2)
    expect(new Set(sentIds()).size).toBe(1)
    expect(hook.result.current.outbox).toEqual([])
  })

  // The owner change's requeue lands in the same commit as the drain's next send.
  it.each([
    ['a host known to be older', false],
    ['a host whose capability check has not answered', undefined]
  ])(
    'sends again the send in flight when the owner moves on %s, with one queued behind it',
    async (_label, supports) => {
      mocks.probe.mockReturnValue(
        supports === undefined ? new Promise(() => {}) : Promise.resolve(supports)
      )
      // The first owner never answers the first send.
      mocks.call.mockReturnValueOnce(new Promise(() => {})).mockResolvedValue(QUEUED)
      const hook = mount(1)
      await settle()
      act(() => void hook.result.current.send('first'))
      await settle()
      act(() => void hook.result.current.send('second'))
      await settle()
      const [first, second] = hook.result.current.outbox.map((entry) => entry.clientMessageId)
      hook.rerender({ fence: 2 })
      await settle()
      await settle()
      expect(sentAttempts()).toEqual([`${first}@1`, `${first}@2`, `${second}@2`])
      expect(hook.result.current.outbox).toEqual([])
    }
  )

  it('sends the send in flight again on a new owner, but not a message it refused', async () => {
    mocks.probe.mockResolvedValue(false)
    writeSaved([heldEntry('op-held', 'agent_session_checkpoint_stale')])
    mocks.call.mockReturnValueOnce(new Promise(() => {})).mockResolvedValue(QUEUED)
    const hook = mount(1)
    await settle()
    act(() => void hook.result.current.send('first'))
    await settle()
    act(() => void hook.result.current.send('second'))
    await settle()
    const [, first, second] = hook.result.current.outbox.map((entry) => entry.clientMessageId)
    hook.rerender({ fence: 2 })
    await settle()
    await settle()
    expect(sentAttempts()).toEqual([`${first}@1`, `${first}@2`, `${second}@2`])
    expect(hook.result.current.outbox).toMatchObject([
      { clientMessageId: 'op-held', legacyUnsettled: true }
    ])
  })
})
