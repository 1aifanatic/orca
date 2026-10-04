import { afterEach, describe, expect, it } from 'vitest'
import {
  agentJournalToolCallLifecycle,
  interruptedAgentJournalToolCall
} from '../../../shared/agent-journal-tool-call-lifecycle'
import type { AgentJournalToolCallItem } from '../../../shared/agent-session-journal-types'
import {
  closeProviderTimelineRigs,
  openProviderTimelineRig,
  providerItemId,
  runningTool,
  type ProviderTimelineRig
} from './provider-timeline-assembler-test-support'

afterEach(closeProviderTimelineRigs)

async function toolBody(
  rig: ProviderTimelineRig,
  item = 'call-a'
): Promise<AgentJournalToolCallItem> {
  const body = (await rig.row(providerItemId('item', item)))?.body
  if (body?.kind !== 'tool-call') {
    throw new Error(`no tool row for ${item}`)
  }
  return body
}

async function lifecycle(rig: ProviderTimelineRig, item = 'call-a'): Promise<string | undefined> {
  return agentJournalToolCallLifecycle(await toolBody(rig, item))
}

async function openTool(): Promise<ProviderTimelineRig> {
  const rig = await openProviderTimelineRig()
  rig.assembler.apply({ type: 'turn.open', turn: 'turn-1', at: 1_000 })
  rig.assembler.apply({ type: 'item.open', item: 'call-a', body: runningTool('shell') })
  return rig
}

describe('provider timeline: how a call its turn or session ended reads', () => {
  it('reads interrupted when a stop interrupts its turn, keeping failed for older builds', async () => {
    const rig = await openTool()
    rig.assembler.apply({
      type: 'turn.end',
      at: 2_000,
      state: 'interrupted',
      outcome: 'cancellation'
    })
    expect(await toolBody(rig)).toMatchObject({ state: 'failed', endedAs: 'interrupted' })
    expect(await lifecycle(rig)).toBe('interrupted')
  })

  it('reads interrupted when a newer turn supersedes its turn', async () => {
    const rig = await openTool()
    rig.assembler.apply({ type: 'turn.open', turn: 'turn-2', at: 2_000 })
    expect(await lifecycle(rig)).toBe('interrupted')
  })

  it('reads interrupted when the session ends on an observed child exit', async () => {
    const rig = await openTool()
    rig.assembler.apply({
      type: 'session.ended',
      verdict: { state: 'interrupted', completedAt: 3_000 }
    })
    expect(await lifecycle(rig)).toBe('interrupted')
  })

  it('reads interrupted when a restarted host ends the session a previous one opened it in', async () => {
    const rig = await openTool()
    const restarted = rig.restart()
    restarted.apply({
      type: 'session.ended',
      verdict: { state: 'interrupted', completedAt: 3_000 }
    })
    expect(await lifecycle(rig)).toBe('interrupted')
  })

  it('keeps the provider cancelling a call, and a later turn end does not restate it', async () => {
    const rig = await openTool()
    rig.assembler.apply({
      type: 'item.close',
      item: 'call-a',
      body: interruptedAgentJournalToolCall(runningTool('shell'))
    })
    expect(await lifecycle(rig)).toBe('interrupted')
    rig.assembler.apply({ type: 'turn.end', at: 2_000, state: 'completed' })
    expect(await lifecycle(rig)).toBe('interrupted')
  })

  it('still reads failed when the provider completed the turn around a call it never closed', async () => {
    const rig = await openTool()
    rig.assembler.apply({ type: 'turn.end', at: 2_000, state: 'completed' })
    const body = await toolBody(rig)
    expect(body).toMatchObject({ state: 'failed' })
    expect(body).not.toHaveProperty('endedAs')
  })

  it('still reads failed when the host lost the child, which proves no interruption', async () => {
    const rig = await openTool()
    rig.assembler.apply({ type: 'session.ended', verdict: { state: 'unverifiable' } })
    expect(await lifecycle(rig)).toBe('failed')
  })

  it('still reads failed when a new provider session replaces the one it ran in', async () => {
    const rig = await openTool()
    rig.assembler.apply({ type: 'session.reset', namespace: 'provider-session-2' })
    expect(await lifecycle(rig)).toBe('failed')
  })

  it('leaves a call that finished before the stop as it finished', async () => {
    const rig = await openTool()
    rig.assembler.apply({
      type: 'item.close',
      item: 'call-a',
      body: { ...runningTool('shell'), state: 'completed' }
    })
    rig.assembler.apply({ type: 'turn.end', at: 2_000, state: 'interrupted' })
    expect(await lifecycle(rig)).toBe('completed')
  })
})
