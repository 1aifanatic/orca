import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProviderTimelineLane } from './provider-timeline-lane'
import {
  AGENT,
  GENERATION,
  NAMESPACE,
  SESSION,
  closeProviderTimelineRigs,
  openProviderTimelineRig,
  openUnboundProviderTimelineAssembler,
  pendingApproval,
  providerItemId,
  runningTool
} from './provider-timeline-assembler-test-support'

afterEach(closeProviderTimelineRigs)

describe('awaited provider timeline admission', () => {
  it('holds one refused event and preserves order until the journal can accept it', async () => {
    const rig = await openProviderTimelineRig()
    const abort = new AbortController()
    let refusing = true
    let refused = 0
    const lane = new ProviderTimelineLane({
      sessionId: SESSION,
      agent: AGENT,
      generation: GENERATION,
      namespace: NAMESPACE,
      signal: abort.signal,
      sink: {
        ...rig.eventSink,
        tryAppendTransition: (transition) => {
          if (refusing) {
            refused += 1
            return { accepted: false, reason: 'backpressure' }
          }
          return (
            rig.eventSink.tryAppendTransition?.(transition) ?? { accepted: false, reason: 'closed' }
          )
        }
      }
    })
    const first = lane.apply([{ type: 'item.open', item: 'tool', body: runningTool('read') }])
    const second = lane.apply([
      { type: 'item.close', item: 'tool', body: { ...runningTool('read'), state: 'completed' } }
    ])
    await vi.waitFor(() => expect(refused).toBeGreaterThan(0))
    expect(await rig.rows()).toEqual([])
    refusing = false
    await Promise.all([first, second])
    expect((await rig.row(providerItemId('item', 'tool')))?.body).toMatchObject({
      state: 'completed'
    })
    lane.dispose()
    abort.abort()
  })

  it('abandons a held event on close without writing its queued successor', async () => {
    const rig = await openProviderTimelineRig()
    const abort = new AbortController()
    let refused = 0
    const lane = new ProviderTimelineLane({
      sessionId: SESSION,
      agent: AGENT,
      generation: GENERATION,
      namespace: NAMESPACE,
      signal: abort.signal,
      sink: {
        ...rig.eventSink,
        tryAppendTransition: () => {
          refused += 1
          return { accepted: false, reason: 'backpressure' }
        }
      }
    })
    const first = expect(
      lane.apply([{ type: 'item.open', item: 'a', body: runningTool('read') }])
    ).rejects.toBeDefined()
    const second = expect(
      lane.apply([{ type: 'item.open', item: 'b', body: runningTool('edit') }])
    ).rejects.toBeDefined()
    await vi.waitFor(() => expect(refused).toBeGreaterThan(0))
    abort.abort()
    await Promise.all([first, second])
    expect(await rig.rows()).toEqual([])
    lane.dispose()
  })

  it('refuses over-capacity history instead of waiting for a journal that is not bound yet', async () => {
    const rig = await openProviderTimelineRig()
    const abort = new AbortController()
    const lane = new ProviderTimelineLane({
      sessionId: SESSION,
      agent: AGENT,
      generation: GENERATION,
      namespace: NAMESPACE,
      signal: abort.signal,
      sink: {
        ...rig.eventSink,
        tryAppendTransition: () => ({ accepted: false, reason: 'backpressure' })
      }
    })
    await expect(
      lane.apply([{ type: 'item.open', item: 'a', body: runningTool('read') }], true)
    ).rejects.toMatchObject({ reason: 'historyTooLarge' })
    lane.dispose()
    abort.abort()
  })
})

it('exposes a request identity only after the journal selects its incarnation', async () => {
  const rig = await openProviderTimelineRig()
  const unbound = openUnboundProviderTimelineAssembler(rig.journal)
  unbound.assembler.apply({ type: 'request.open', request: 'ask', body: pendingApproval })
  expect(unbound.assembler.requestItemId('ask')).toBeNull()
  await unbound.bind()
  expect(unbound.assembler.requestItemId('ask')).toBe(
    providerItemId('request', 'ask', { generation: 'gen-unbound' })
  )
  unbound.assembler.apply({ type: 'request.withdrawn', request: 'ask' })
  await unbound.drained()
  unbound.assembler.apply({ type: 'request.open', request: 'ask', body: pendingApproval })
  await unbound.drained()
  expect(unbound.assembler.requestItemId('ask')).toBe(
    providerItemId('request', 'ask', { generation: 'gen-unbound', incarnation: 2 })
  )
})
