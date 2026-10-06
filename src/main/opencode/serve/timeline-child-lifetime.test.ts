import { afterEach, expect, it } from 'vitest'
import {
  closeProviderTimelineRigs,
  openProviderTimelineRig,
  providerItemId
} from '../../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { OpenCodeTimelineTranslator } from './timeline-translator'

afterEach(closeProviderTimelineRigs)

it.each([1, 2] as const)(
  'keeps child approvals and tools alive after the root settles in dialect %s',
  async (major) => {
    const rig = await openProviderTimelineRig({ ownThread: () => 'root' })
    const translator = new OpenCodeTimelineTranslator({ sessionId: 'root', major })
    translator.registerSession({ id: 'child', parentID: 'root' })
    const apply = (events: ReturnType<typeof translator.input>) =>
      events.forEach((event) => rig.assembler.apply(event))
    apply(translator.input('send', 1000, 'msg_root'))
    const ask = translator.translate({
      type: 'permission.asked',
      data: {
        id: 'ask',
        sessionID: 'child',
        permission: 'bash',
        patterns: ['echo ok'],
        action: 'shell',
        resources: ['echo ok']
      }
    })
    apply(ask.events)
    apply(translator.tool('tool', 'shell', { command: 'echo ok' }, 'running', 'child'))
    await rig.rows()
    const requestId = rig.assembler.requestItemId('permission:ask')
    expect(requestId).toBeTruthy()
    apply(translator.end('root', 1100, 'completed', 'success').events)
    expect(translator.pending.has('permission:ask')).toBe(true)
    expect(rig.assembler.requestItemId('permission:ask')).toBe(requestId)
    expect((await rig.rows()).find((row) => row.itemId === requestId)?.body).toMatchObject({
      resolution: { state: 'pending' }
    })
    expect(
      (await rig.row(providerItemId('item', 'tool', { thread: 'child' })))?.body
    ).toMatchObject({ state: 'running' })
    translator.registerSession({ id: 'other-child', parentID: 'root' })
    apply(
      translator.translate({
        type: 'permission.asked',
        data: { id: 'other-ask', sessionID: 'other-child', permission: 'bash', action: 'shell' }
      }).events
    )
    const otherId = rig.assembler.requestItemId('permission:other-ask')
    apply(translator.end('child', 1150, 'completed', 'success').events)
    expect(translator.pending.has('permission:ask')).toBe(false)
    expect((await rig.rows()).find((row) => row.itemId === requestId)?.body).toMatchObject({
      resolution: { state: 'cancelled' }
    })
    expect(
      (await rig.row(providerItemId('item', 'tool', { thread: 'child' })))?.body
    ).toMatchObject({ state: 'failed' })
    expect(translator.pending.has('permission:other-ask')).toBe(true)
    expect((await rig.rows()).find((row) => row.itemId === otherId)?.body).toMatchObject({
      resolution: { state: 'pending' }
    })
    apply(translator.withdraw('ask').events)
    expect((await rig.rows()).find((row) => row.itemId === requestId)?.body).toMatchObject({
      resolution: { state: 'cancelled' }
    })
    rig.assembler.apply({
      type: 'session.ended',
      verdict: { state: 'interrupted', completedAt: 1200 }
    })
    expect(
      (await rig.row(providerItemId('item', 'tool', { thread: 'child' })))?.body
    ).toMatchObject({ state: 'failed' })
    expect((await rig.rows()).find((row) => row.itemId === otherId)?.body).toMatchObject({
      resolution: { state: 'cancelled' }
    })
  }
)

it.each([1, 2] as const)(
  'ignores ended child text while allowing its next execution in dialect %s',
  async (major) => {
    const rig = await openProviderTimelineRig({ ownThread: () => 'root' })
    const translator = new OpenCodeTimelineTranslator({ sessionId: 'root', major })
    translator.registerSession({ id: 'child', parentID: 'root' })
    const apply = (events: ReturnType<typeof translator.input>) =>
      events.forEach((event) => rig.assembler.apply(event))
    apply(translator.textDelta('old-text', 'assistant', 'finished', 'child'))
    apply(translator.end('child', 1100, 'completed', 'success').events)
    apply(translator.textDelta('old-text', 'assistant', ' late', 'child'))
    apply(translator.textDelta('new-text', 'assistant', 'new execution', 'child'))
    apply(translator.end('child', 1200, 'completed', 'success').events)
    expect(
      (await rig.row(providerItemId('item', 'old-text', { thread: 'child' })))?.body
    ).toMatchObject({ blocks: [{ type: 'text', text: 'finished' }] })
    expect(
      (await rig.row(providerItemId('item', 'new-text', { thread: 'child' })))?.body
    ).toMatchObject({ blocks: [{ type: 'text', text: 'new execution' }] })
  }
)
