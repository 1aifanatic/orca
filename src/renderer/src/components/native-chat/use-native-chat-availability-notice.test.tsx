// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { useNativeChatAvailabilityNotice } from './use-native-chat-availability-notice'
import { agentSessionFailureWords } from '../../../../shared/agent-session-failure-words'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import { agentJournalItemKey } from '../../../../shared/agent-session-journal-item-key'
import { structuredAgentSessionStartFailureRowIdentity } from '../../../../shared/structured-agent-session-start-failure-row-key'
import {
  structuredAgentSessionDeliveryNotices,
  structuredAgentSessionStartFailureFacts
} from './structured-agent-session-delivery-notices'

afterEach(cleanup)
describe('each agent names its own sign-in method before a send', () => {
  it.each([
    ['claude', 'Claude', 'claude auth login'],
    ['codex', 'Codex', 'codex login'],
    ['grok', 'Grok', 'grok login'],
    ['opencode', 'OpenCode', 'opencode auth login'],
    ['pi', 'Pi', '/login'],
    ['omp', 'OMP', 'Sign in to OMP.']
  ] as const)('uses %s copy without a post-send retry tail', (agent, agentLabel, command) => {
    const { result } = renderHook(() =>
      useNativeChatAvailabilityNotice({
        agent,
        agentLabel,
        unavailable: { reason: 'notSignedIn' },
        launchFailure: null,
        journalItems: []
      })
    )
    expect(result.current?.text).toContain(command)
    expect(result.current?.text).toContain(agentLabel)
    expect(result.current?.text).not.toContain('send your message again')
  })
})

it('keeps one auth explanation while an unechoed message still reads as unsent', () => {
  const failure = {
    kind: 'notSignedIn',
    account: 'system',
    detail: { text: 'Expired session token', audience: 'person' }
  } as const
  const authRow: AgentJournalRenderItem = {
    itemId: 'codex-error',
    revision: 1,
    sequence: 1,
    observedAt: 1,
    body: {
      kind: 'status',
      tone: 'error',
      ...agentSessionFailureWords(failure, { agentName: 'Codex', surface: 'row' })
    }
  }
  const { result } = renderHook(() =>
    useNativeChatAvailabilityNotice({
      agent: 'codex',
      agentLabel: 'Codex',
      unavailable: { reason: 'notSignedIn', account: 'system' },
      launchFailure: null,
      journalItems: [authRow]
    })
  )
  expect(result.current).toBeNull()
  const notices = structuredAgentSessionDeliveryNotices({
    pending: [],
    agentName: 'Codex',
    startFailures: structuredAgentSessionStartFailureFacts([authRow]),
    submissions: [
      {
        clientMessageId: 'send',
        fence: 1,
        payloadFingerprint: 'send',
        dispatchState: 'rejected',
        providerItemId: null,
        reason: 'Host sign-in guidance',
        rejection: failure,
        submittedAt: 1,
        resolvedAt: 2
      }
    ]
  })
  expect([...notices.values()].map((notice) => notice.text)).toEqual(['Your message was not sent.'])
})

it.each(['launch', 'history'] as const)(
  'leaves a missing Codex explanation to its existing %s refusal',
  (surface) => {
    const refusal = {
      kind: 'refused',
      code: 'agent_session_operation_invalid',
      details: {
        reason: 'attachFailed',
        codexInstallation: { installedVersion: null, minimumVersion: '0.136.0' }
      }
    } as const
    const row: AgentJournalRenderItem = {
      itemId: agentJournalItemKey(structuredAgentSessionStartFailureRowIdentity('generation-1')),
      revision: 1,
      sequence: 1,
      observedAt: 1,
      body: {
        kind: 'status',
        tone: 'error',
        ...agentSessionFailureWords(
          { kind: 'startFailed', refusal },
          { agentName: 'Codex', surface: 'row' }
        )
      }
    }
    const { result } = renderHook(() =>
      useNativeChatAvailabilityNotice({
        agent: 'codex',
        agentLabel: 'Codex',
        unavailable: { reason: 'cliMissing' },
        launchFailure: surface === 'launch' ? refusal : null,
        journalItems: surface === 'history' ? [row] : []
      })
    )
    expect(result.current).toBeNull()
  }
)
