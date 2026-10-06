import { describe, expect, it, vi } from 'vitest'
import type { StructuredChatNamingDeps } from './structured-chat-naming'
import { createStructuredChatNamingHandler } from './structured-chat-naming'
import { firstStructuredChatNamingPrompt } from '../../shared/structured-chat-naming-eligibility'
import {
  claudeProviderHandle,
  codexProviderHandle
} from '../../shared/agent-session-provider-handle-encoding'
import {
  hostTestState,
  envelope
} from './agent-session-wire/structured-agent-session-host-test-harness'
import {
  hostTestAttachParams,
  hostTestMessage,
  HOST_TEST_SESSION,
  HOST_TEST_THREAD
} from './agent-session-wire/structured-agent-session-host-test-data'

describe.each(['claude', 'codex'] as const)('%s first-message naming status hook', (provider) => {
  it.each(['accepted', 'admitted'] as const)(
    'names a live %s send without awaiting generation',
    async (outcome) => {
      const { host, store, acquire, dispatch, log } = hostTestState()
      const handle =
        provider === 'claude'
          ? claudeProviderHandle(HOST_TEST_THREAD, null)
          : codexProviderHandle(HOST_TEST_THREAD)
      acquire.mockImplementation(async ({ fence }) => ({
        process: {
          hostId: 'local',
          pid: 4242,
          processStartTimeMs: 1_700_000_000_000,
          spawnToken: store.getRecord(HOST_TEST_SESSION)?.lease.reservedSpawnToken ?? 'spawn-a'
        },
        link: {
          linkId: `link-${fence}`,
          handle,
          origin: 'created',
          mintedAtFence: fence,
          observedAt: 100
        }
      }))
      dispatch.mockImplementation(async () =>
        outcome === 'admitted'
          ? { state: 'admitted' }
          : {
              state: 'accepted',
              providerIdentity:
                provider === 'claude'
                  ? { provider: 'claude', sessionId: HOST_TEST_THREAD, uuid: 'turn-1' }
                  : { provider: 'codex', threadId: HOST_TEST_THREAD, turnId: 'turn-1', ordinal: 1 }
            }
      )
      let finish: (value: string | null) => void = () => {
        throw new Error('Not initialized')
      }
      const generation = new Promise<string | null>((resolve) => {
        finish = resolve
      })
      const generate = vi.fn(() => generation)
      const deps: StructuredChatNamingDeps = {
        getStore: () => store,
        getSettings: () => ({}),
        hasOpenDispatch: () => false,
        readFirstPrompt: async (sessionId, hostStartedAt) =>
          firstStructuredChatNamingPrompt(await host.journalSnapshot(sessionId), hostStartedAt),
        generate,
        onNamed: vi.fn(),
        logger: log.logger
      }
      const naming = createStructuredChatNamingHandler(deps)
      const status = vi.fn(naming)
      host.deps.onSessionStatusChanged = status
      const attached = await host.attach(
        { callerKey: 'client-1' },
        hostTestAttachParams(null, {
          provider,
          agent: provider,
          providerHandle:
            provider === 'claude'
              ? { kind: 'claude', sessionId: HOST_TEST_THREAD, leafUuid: null }
              : { kind: 'codex', threadId: HOST_TEST_THREAD },
          accountHome: {
            variable: provider === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME',
            path: '/isolated/account'
          }
        })
      )
      expect(attached).toMatchObject({ ok: true })
      const body = hostTestMessage('Please repair the login flow')
      const sent = await host.send(
        { callerKey: 'client-1' },
        {
          envelope: envelope('agentSession.send', { body }),
          body
        }
      )
      expect(sent).toMatchObject({ ok: true })
      await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1))
      expect(
        status.mock.calls.some(
          ([summary, options]) =>
            summary.agent === provider && summary.status === 'working' && !options.replay
        )
      ).toBe(true)
      expect(store.getRecord(HOST_TEST_SESSION)?.conversationName).toBeUndefined()
      finish('auth/login')
      await vi.waitFor(() =>
        expect(store.getRecord(HOST_TEST_SESSION)?.conversationName).toBe('auth/login')
      )
    }
  )
})
