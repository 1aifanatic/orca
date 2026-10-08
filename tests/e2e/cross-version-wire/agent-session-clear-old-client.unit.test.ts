// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { expect, test } from 'vitest'
import { importReleaseCheckoutModule, materializeReleaseCheckout } from './release-checkout'
import {
  createQueuedMessageTestRig,
  QUEUED_RIG_CALLER as CALLER
} from '../../../src/main/native-chat/agent-session-wire/structured-agent-session-queued-message-rig.test-fixture'
import {
  HOST_TEST_SESSION as SESSION,
  hostTestOperationId
} from '../../../src/main/native-chat/agent-session-wire/structured-agent-session-host-test-data'
test('an older desktop releases its clear hold from the actual same-conversation result while its pane stays mounted', async () => {
  const checkout = await materializeReleaseCheckout('b6b4d68cd844c921c7c5191cef72d5adafc0dafa')
  const [commands, pending] = await Promise.all([
    importReleaseCheckoutModule(
      checkout,
      'src/renderer/src/components/native-chat/use-structured-agent-session-command-write.ts'
    ),
    importReleaseCheckoutModule(
      checkout,
      'src/renderer/src/components/native-chat/structured-agent-session-pending-sends.ts'
    )
  ])
  const useCommand = commands.useStructuredAgentSessionCommandWrite
  const held = pending.structuredAgentSessionSendsHeld
  if (typeof useCommand !== 'function' || typeof held !== 'function') {
    throw new Error('historical clear hold missing')
  }
  const rig = await createQueuedMessageTestRig({ restartable: true })
  try {
    const before = await rig.host.journalSnapshot(SESSION)
    const view = renderHook(() =>
      useCommand(SESSION, async () => {
        const fields = { command: 'clear' as const }
        const result = await rig.host.conversationCommand(CALLER, {
          ...fields,
          envelope: rig.envelope(fields, 'agentSession.conversationCommand', hostTestOperationId())
        })
        if (!result.ok) {
          throw new Error('clear failed')
        }
        expect(result.value.replacementSessionId).toBeUndefined()
        return { kind: 'done', value: result.value }
      })
    )
    let request: Promise<unknown> | undefined
    act(() => {
      request = view.result.current('clear')
    })
    expect(held(SESSION)).toBe(true)
    await act(async () => {
      expect(await request).toMatchObject({
        kind: 'done',
        value: { command: 'clear', state: 'completed' }
      })
    })
    expect(held(SESSION)).toBe(false)
    const after = await rig.host.journalSnapshot(SESSION)
    expect(after.cursor.epoch).toBe(before.cursor.epoch)
    expect(after.items.slice(0, before.items.length)).toEqual(before.items)
    expect(after.items.at(-1)?.body).toMatchObject({ presentation: 'context-cleared' })
  } finally {
    cleanup()
    await rig.dispose()
  }
}, 300_000)
