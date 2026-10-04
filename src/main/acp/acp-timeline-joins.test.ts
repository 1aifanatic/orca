import { afterEach, describe, expect, it } from 'vitest'
import { createCodexProviderTimelineIdentityScheme } from '../codex/codex-provider-timeline-identity'
import {
  closeProviderTimelineRigs,
  messageText,
  openProviderTimelineRig
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import type { ProviderTimelineEvent } from '../native-chat/agent-session-timeline/provider-timeline-event'
import { AcpTimelineTranslator } from './acp-timeline-translator'

afterEach(closeProviderTimelineRigs)

describe('ACP joins through the v3 assembler', () => {
  it('keeps provider message and tool ids apart across ACP sessions', async () => {
    const rig = await openProviderTimelineRig()
    for (const sessionId of ['session-a', 'session-b']) {
      const translator = new AcpTimelineTranslator({
        sessionId,
        journalItems: () => rig.journal.snapshot().items
      })
      for (const update of [
        {
          sessionUpdate: 'agent_message_chunk',
          messageId: 'same-message',
          content: { type: 'text', text: sessionId }
        },
        {
          sessionUpdate: 'tool_call',
          toolCallId: 'same-tool',
          title: sessionId,
          status: 'completed'
        }
      ]) {
        for (const event of translator.notification(
          'session/update',
          { sessionId, update },
          1100
        )) {
          expect(rig.assembler.apply(event).admission.accepted).toBe(true)
        }
      }
    }
    const rows = await rig.rows()
    expect(
      rows.filter((row) => row.body.kind === 'message').map((row) => messageText(row.body))
    ).toEqual(['session-a', 'session-b'])
    expect(rows.flatMap((row) => (row.body.kind === 'tool-call' ? [row.body.name] : []))).toEqual([
      'session-a',
      'session-b'
    ])
  })

  it('resumes named text in its existing ordinal row and closes the same joined stream', async () => {
    const rig = await openProviderTimelineRig({
      scheme: createCodexProviderTimelineIdentityScheme({
        sessionId: 'session-timeline',
        primaryThreadId: () => 'provider-1'
      }),
      ownThread: () => 'provider-1'
    })
    const translator = new AcpTimelineTranslator({
      sessionId: 'provider-1',
      journalItems: () => rig.journal.snapshot().items
    })
    const apply = (events: ProviderTimelineEvent[]) => {
      for (const event of events) {
        expect(rig.assembler.apply(event).admission.accepted).toBe(true)
      }
    }
    const chunk = (text: string) =>
      translator.notification(
        'session/update',
        {
          sessionId: 'provider-1',
          update: {
            sessionUpdate: 'agent_message_chunk',
            messageId: 'm1',
            content: { type: 'text', text }
          }
        },
        1100
      )
    apply(translator.openPrompt('send-1', 1000).events)
    apply(chunk('Hel'))
    const before = (await rig.rows()).find((row) => row.body.kind === 'message')!
    rig.assembler = rig.restart({ generation: 'gen-2' })
    const delta = chunk('lo')[0]!
    if (delta.type !== 'text.delta') {
      throw new Error('Expected a translated text delta')
    }
    expect(delta.join).toEqual({ thread: 'provider-1', turn: 'prompt:send-1' })
    apply([delta, { type: 'text.close', item: delta.item, join: delta.join }])
    expect(rig.assembler.apply(delta).dropped).toBe('item-settled')
    const messages = (await rig.rows()).filter((row) => row.body.kind === 'message')
    expect(messages).toHaveLength(1)
    expect(messages[0]!.itemId).toBe(before.itemId)
    expect(messageText(messages[0]!.body)).toBe('Hello')
  })

  it('lets the assembler recover request incarnations and the open turn after a restart', async () => {
    const rig = await openProviderTimelineRig()
    const build = () =>
      new AcpTimelineTranslator({
        sessionId: 'provider-1',
        journalItems: () => rig.journal.snapshot().items
      })
    const params = {
      sessionId: 'provider-1',
      toolCall: { toolCallId: 'call-1', title: 'Run?' },
      options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }]
    }
    const translator = build()
    for (const event of translator.openPrompt('send-1', 1000).events) {
      rig.assembler.apply(event)
    }
    const event = translator.request('session/request_permission', params, 0).events[0]!
    if (event.type !== 'request.open') {
      throw new Error('Expected a translated request')
    }
    expect(event.join).toEqual({ thread: 'provider-1' })
    rig.assembler.apply(event)
    rig.assembler.apply({ type: 'request.withdrawn', request: event.request })
    const first = (await rig.rows()).find((row) => row.body.kind === 'approval')!
    rig.assembler = rig.restart({ generation: 'gen-2' })
    for (const reopened of build().request('session/request_permission', params, 0).events) {
      expect(rig.assembler.apply(reopened).admission.accepted).toBe(true)
    }
    const approvals = (await rig.rows()).filter((row) => row.body.kind === 'approval')
    expect(approvals).toHaveLength(2)
    expect(approvals[1]!.itemId).not.toBe(first.itemId)
    expect(approvals[1]!.turnScope).toEqual(first.turnScope)
    expect(approvals[1]!.body).toMatchObject({ resolution: { state: 'pending' } })
  })
})
