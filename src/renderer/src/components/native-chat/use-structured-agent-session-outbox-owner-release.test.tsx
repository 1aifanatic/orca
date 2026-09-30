// @vitest-environment happy-dom

// A message the chat said was not sent goes out again on a new owner only on a host known to be
// older. A host whose capability probe has not answered, or failed, says nothing about that, so
// the message waits for its Retry.

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

import { createStructuredAgentSessionOutboxEntry } from '../../../../shared/structured-agent-session-outbox'
import { writeOutbox } from './structured-agent-session-outbox-storage'
import { useStructuredAgentSessionOutbox } from './use-structured-agent-session-outbox'

type SendRequest = { envelope?: { clientOperationId?: string } }

function requestId(params: SendRequest | undefined): string {
  return String(params?.envelope?.clientOperationId)
}

function sentIds(): string[] {
  return mocks.call.mock.calls.map((call) => requestId(call[2]))
}

async function settle(): Promise<void> {
  await act(() => new Promise<void>((resolve) => setTimeout(resolve, 50)))
}

function mount(fence: number) {
  return renderHook(
    ({ fence: current }: { fence: number }) =>
      useStructuredAgentSessionOutbox({
        sessionId: 'session-1',
        target: { kind: 'environment', environmentId: 'env-1' },
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
  expect(hook.result.current.outbox[0]?.lastFailure).toBeDefined()
  return hook
}

describe('a refused message when the chat gets a new owner', () => {
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
    expect(hook.result.current.outbox[0]?.lastFailure).toBeDefined()
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
    'execution_owner_reconciling'
  ] as const)('is sent again, same id, on a host known to be older, after %s', async (code) => {
    mocks.probe.mockResolvedValue(false)
    // Held under an id already sent once, which a settled refusal would otherwise have replaced.
    writeOutbox('session-1', [
      {
        ...createStructuredAgentSessionOutboxEntry({
          clientMessageId: 'op-held',
          sessionId: 'session-1',
          text: 'hello',
          attachments: [],
          queuedAt: 1
        }),
        lastAttemptAt: 2,
        lastFailure: { kind: 'refused', code }
      }
    ])
    mocks.call.mockResolvedValue({ ok: true, replayed: false, fence: 2, value: { queued: {} } })
    const hook = mount(1)
    await settle()
    expect(sentIds()).toEqual([])
    hook.rerender({ fence: 2 })
    await settle()
    expect(sentIds()).toEqual(['op-held'])
  })

  // A new owner answers none of these, so a copy the user retyped is never joined by the original.
  it.each(['agent_session_journal_unreadable', 'agent_session_operation_capacity'])(
    'waits for its Retry on a host known to be older, after %s',
    async (code) => {
      mocks.probe.mockResolvedValue(false)
      const hook = await refusedOnce(code)
      hook.rerender({ fence: 2 })
      await settle()
      expect(sentIds()).toHaveLength(1)
      expect(hook.result.current.outbox[0]?.lastFailure).toBeDefined()
    }
  )

  it('waits for its Retry on a host known to be older when the send never reached it', async () => {
    mocks.probe.mockResolvedValue(false)
    mocks.call.mockRejectedValueOnce(new Error('send failed'))
    const hook = mount(1)
    await settle()
    act(() => void hook.result.current.send('hello'))
    await settle()
    expect(hook.result.current.outbox[0]?.lastFailure).toEqual({ kind: 'failed' })
    hook.rerender({ fence: 2 })
    await settle()
    expect(sentIds()).toHaveLength(1)
  })
})
