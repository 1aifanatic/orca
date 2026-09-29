// A message handed to Claude during a turn that Claude then ends without taking it: the chat stops
// reading working, and the message is drawn as sent. Against the production runtime, adapter,
// record store and host, with only the CLI process scripted.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { computeAgentSessionPayloadFingerprint } from '../../shared/agent-session-mutation-envelope'
import { owesStructuredAgentSessionWork } from '../../shared/structured-agent-session-owed-work'
import { hostTestMessage } from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import type { StructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-host'
import { createScriptedClaudeRuntime } from './structured-claude-scripted-runtime-test-support'

const SESSION = 'claude-turn-end-settlement'
const CALLER = { callerKey: 'client-1' }

let claude = createScriptedClaudeRuntime([SESSION])
let operations = 0

afterEach(async () => {
  vi.restoreAllMocks()
  await claude.dispose()
  claude = createScriptedClaudeRuntime([SESSION])
})

async function send(host: StructuredAgentSessionHost, text: string): Promise<string> {
  const body = hostTestMessage(text)
  const sent = await host.send(CALLER, {
    envelope: {
      sessionId: SESSION,
      clientOperationId: `${Date.now()}-${(++operations).toString(16).padStart(32, '0')}`,
      expectedRuntimeFence: host.deps.store.getRecord(SESSION)?.lease.runtimeFence ?? 0,
      payloadFingerprint: computeAgentSessionPayloadFingerprint({
        method: 'agentSession.send',
        sessionId: SESSION,
        fields: { body }
      })
    },
    body
  })
  if (!sent.ok) {
    throw new Error(JSON.stringify(sent.refusal))
  }
  return sent.value.clientMessageId
}

describe('a Claude turn that ends without taking a message handed to it', () => {
  it.each([false, true])(
    'settles the message in doubt when its result arrives (is_error: %s)',
    async (isError) => {
      const host = await claude.install()
      await expect(host.attach(CALLER, claude.attachParams(SESSION, null))).resolves.toMatchObject({
        ok: true
      })
      await send(host, 'write a story')
      const child = claude.child(SESSION)
      await vi.waitFor(() => expect(child.sent).toHaveLength(1))
      const providerSession = String(child.launch.options.sessionId)
      child.handlers.onMessage?.({ ...child.sent[0], uuid: 'user-echo' })
      await host.flushStreamedEvents(SESSION)
      const steer = await send(host, 'make it shorter')
      await vi.waitFor(() => expect(child.sent).toHaveLength(2))

      child.handlers.onMessage?.({
        type: 'result',
        subtype: isError ? 'error_during_execution' : 'success',
        is_error: isError,
        session_id: providerSession,
        uuid: 'result-1'
      })
      await host.flushStreamedEvents(SESSION)

      await vi.waitFor(async () => {
        const snapshot = await host.journalSnapshot(SESSION)
        expect(snapshot.submissions.find((entry) => entry.clientMessageId === steer)).toMatchObject(
          {
            dispatchState: 'unknown',
            reason: 'turn_settled_before_acknowledgement',
            recovered: true
          }
        )
        const fence = host.deps.store.getRecord(SESSION)?.lease.runtimeFence ?? 0
        expect(owesStructuredAgentSessionWork(snapshot.items, snapshot.submissions, fence)).toBe(
          false
        )
      })
    }
  )
})
