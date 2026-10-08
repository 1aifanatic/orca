// @vitest-environment happy-dom
import {
  createResumeModalFixture,
  offered,
  failure,
  type RestartRpc,
  type ResumeStatusStream
} from './native-chat-resume-modal.test-support'
import { act } from 'react'
import { expect, it, vi, type Mock } from 'vitest'
import { NativeChatResumeOnRestartModal } from './NativeChatResumeOnRestartModal'
import { NativeChatResumeStatusSegment } from './status-bar/NativeChatResumeStatusSegment'
import type { ResumeCandidate, ResumeFailure } from './native-chat-resume-on-restart-grouping'
import { requestNativeChatResumeOnRestartDialog } from './native-chat-resume-on-restart-dialog'
import {
  continueNativeChatRestartOffer,
  getNativeChatRestartOffer,
  refreshNativeChatRestartOffer
} from './native-chat-resume-on-restart-store'

const rpc: Mock<RestartRpc> = vi.hoisted(() => vi.fn<RestartRpc>())
const statusStream: ResumeStatusStream = vi.hoisted(() => ({
  emit: (_event: Parameters<ResumeStatusStream['emit']>[0]) => {},
  snapshot: new Map()
}))
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: rpc,
  subscribeStructuredAgentSessionStatus: async (
    _target: unknown,
    emit: (event: Parameters<ResumeStatusStream['emit']>[0]) => void
  ) => {
    statusStream.emit = emit
    emit({ type: 'snapshot', sessions: [...statusStream.snapshot.values()] })
    return { unsubscribe: () => {} }
  }
}))
vi.mock('@/lib/activate-ai-vault-structured-session', () => ({
  activateAiVaultStructuredSession: vi.fn(async () => true)
}))
vi.mock('sonner', () => ({ toast: vi.fn() }))

const { mount, button, checkbox, offerIds, toasts, fakeHost, runStatus } = createResumeModalFixture(
  rpc,
  statusStream
)

it('resumes a 21-chat selection with one action and no redundant listing', async () => {
  const candidates = Array.from({ length: 21 }, (_, index) => ({
    ...offered[0]!,
    sessionId: `chat-${index}`
  }))
  rpc.mockImplementation(async (_target, method) =>
    method === 'agentSession.restartResumable'
      ? { sessions: candidates, failed: [] }
      : {
          sessions: [],
          failed: [],
          continued: candidates.map(({ sessionId }) => ({ sessionId, outcome: 'continued' }))
        }
  )
  await refreshNativeChatRestartOffer()
  await continueNativeChatRestartOffer(candidates.map(({ sessionId }) => sessionId))
  expect(rpc.mock.calls.map((call) => [call[1], call[2]])).toEqual([
    ['agentSession.restartResumable', undefined],
    ['agentSession.restartContinue', { sessionIds: candidates.map(({ sessionId }) => sessionId) }]
  ])
  expect(toasts()).toEqual([['Resumed 21 chats']])
})

it('uses the host unconfirmed result after a lost bulk reply without reporting a failure', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  let reads = 0
  rpc.mockImplementation(async (_target, method) => {
    if (method === 'agentSession.restartContinue') {
      throw new Error('reply lost')
    }
    return reads++ === 0
      ? { sessions: offered, failed: [] }
      : {
          sessions: [],
          failed: [
            { ...failure('a'), outcome: 'unconfirmed' },
            { ...failure('b'), outcome: 'unconfirmed' }
          ]
        }
  })
  try {
    await refreshNativeChatRestartOffer()
    await continueNativeChatRestartOffer(['a', 'b'])
    expect(toasts()).toEqual([['Couldn’t confirm 2 chats were resumed']])
    expect(getNativeChatRestartOffer().failed.map((row) => row.outcome)).toEqual([
      'unconfirmed',
      'unconfirmed'
    ])
  } finally {
    warn.mockRestore()
  }
})

it('publishes a refusal reply without needing a second host read', async () => {
  let reads = 0
  rpc.mockImplementation(async (_target, method) => {
    if (method === 'agentSession.restartResumable') {
      if (reads++ > 0) {
        throw new Error('listing unavailable')
      }
      return { sessions: offered, failed: [] }
    }
    return {
      sessions: [offered[1]],
      failed: [failure('a')],
      continued: [{ sessionId: 'a', outcome: 'refused' }]
    }
  })
  await mount(<NativeChatResumeOnRestartModal />)
  await act(async () => checkbox(1).click())
  await act(async () => button('Resume 1 chat').click())
  expect(reads).toBe(1)
  expect(offerIds()).toEqual(['b'])
  expect(getNativeChatRestartOffer().failed.map((row) => row.sessionId)).toEqual(['a'])
  expect(toasts()).toEqual([['1 chat couldn’t be resumed']])
})

it('keeps the run in flight after every feed verdict until the fallback list is published', async () => {
  const answer = Promise.withResolvers<{
    continued: { sessionId: string; outcome: 'continued' }[]
  }>()
  const listing = Promise.withResolvers<{ sessions: ResumeCandidate[]; failed: ResumeFailure[] }>()
  let reads = 0
  rpc.mockImplementation(async (_target, method) =>
    method === 'agentSession.restartContinue'
      ? answer.promise
      : reads++ === 0
        ? { sessions: offered, failed: [] }
        : listing.promise
  )
  await mount(
    <>
      <NativeChatResumeOnRestartModal />
      <NativeChatResumeStatusSegment iconOnly={false} />
    </>
  )
  await act(async () => button('Resume 2 chats').click())
  await act(async () => button('Resuming chats 0/2').click())
  await act(async () => {
    for (const { sessionId } of offered) {
      statusStream.emit({
        type: 'status',
        session: {
          sessionId,
          workspaceId: 'workspace',
          agent: 'codex',
          status: 'idle',
          latestPrompt: '',
          updatedAt: 1,
          restartResume: { phase: 'continued' }
        }
      })
    }
    answer.resolve({
      continued: offered.map(({ sessionId }) => ({ sessionId, outcome: 'continued' }))
    })
  })
  expect(button('Resuming chats 2/2')).toBeTruthy()
  expect(button('Resuming…').disabled).toBe(true)
  expect(document.body.textContent).not.toContain('chats to resume')
  await act(async () => listing.resolve({ sessions: [], failed: [] }))
  expect(offerIds()).toEqual([])
  expect(button('Done').disabled).toBe(false)
  expect(document.body.textContent).not.toContain('Resuming chats')
})

it('a retry hides its old failure, then a dismissed final failure leaves Need you', async () => {
  const host = fakeHost(
    { sessions: [], failed: [failure('b', 'agent_session_conflict')] },
    () => 'refused',
    'agent_session_conflict'
  )
  host.hold('b')
  await mount(<NativeChatResumeOnRestartModal />)
  await act(async () => requestNativeChatResumeOnRestartDialog())
  await act(async () => button('Retry').click())
  expect(runStatus('Prompt b')).toMatch(/Waiting to start/)
  expect(document.querySelector('[role="dialog"]')?.textContent).not.toContain('Another Orca')
  expect(document.querySelector('[aria-label*="Couldn’t resume"]')).toBeNull()
  await host.release('b')
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Need you1')
  const dismiss = document.querySelector<HTMLButtonElement>('button[aria-label^="Dismiss"]')
  expect(dismiss).not.toBeNull()
  await act(async () => dismiss?.click())
  expect(getNativeChatRestartOffer().failed).toEqual([])
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Need you0')
  expect(runStatus('Prompt b')).toBeNull()
})
