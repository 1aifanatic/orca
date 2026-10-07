import { describe, expect, it, vi } from 'vitest'
import { executeAgentLaunch, type AgentLaunchExecution } from './agent-launch-executor'
import {
  deliverTerminalLaunchPrompt,
  promptReceipt,
  settledAtCreation
} from './agent-launch-prompt-delivery'
import type { AgentLaunchSurfaceFactory } from './agent-launch-surface-factories'
import type { AgentLaunchPrompt } from '../../shared/agent-launch-intent'

const prompt: AgentLaunchPrompt = {
  text: 'draft',
  delivery: 'draft',
  transport: { kind: 'desktop-new-tab', promptDelivery: 'draft' }
}
function execution(
  deliver: NonNullable<AgentLaunchSurfaceFactory['deliverTerminalPrompt']>,
  launchPrompt = prompt
): AgentLaunchExecution {
  return {
    runtime: {
      getClientSettings: () => ({}),
      getStructuredAgentSessionCreateSupport: async () => ({ supported: false, reason: 'agent' })
    },
    intent: {
      agent: 'claude',
      target: { kind: 'existing', worktree: 'folder:test' },
      prompt: launchPrompt
    },
    surfaces: {
      createStructuredSession: async () => {
        throw new Error('unexpected structured launch')
      },
      createTerminalAgent: async () => ({ handle: 'terminal', promptRodeLaunchCommand: true }),
      deliverTerminalPrompt: deliver
    }
  }
}

describe('desktop startup and live paste receipts', () => {
  it('native prefill is handed over at startup and is never pasted again', async () => {
    const delivered = vi.fn(async () => true)
    const result = await executeAgentLaunch(execution(delivered))
    expect(result.prompt).toEqual({ delivery: 'draft', outcome: 'handed-to-terminal' })
    expect(delivered).not.toHaveBeenCalled()
  })
  it('accepted unsubmitted paste is a draft receipt, not a submitted turn', async () => {
    const result = await deliverTerminalLaunchPrompt(
      execution(async () => true),
      'terminal',
      { freshLaunch: true }
    )
    expect(promptReceipt({ prompt }, result)).toEqual({
      prompt: { delivery: 'draft', outcome: 'handed-to-terminal' }
    })
  })
  it('a write refused before the first byte remains not delivered', async () => {
    expect(
      await deliverTerminalLaunchPrompt(
        execution(async () => false),
        'terminal',
        { freshLaunch: true }
      )
    ).toEqual({ outcome: 'not-delivered' })
  })
  it('interrupted desktop input cannot invite a resend after a write may have started', async () => {
    expect(
      await deliverTerminalLaunchPrompt(
        execution(async ({ onWriteUnconfirmed }) => {
          onWriteUnconfirmed?.()
          return false
        }),
        'terminal',
        { freshLaunch: true }
      )
    ).toEqual({ outcome: 'unconfirmed' })
  })
  it('empty compatibility picks have no prompt receipt or write obligation', async () => {
    const empty = { ...prompt, text: ' \n ' }
    const delivered = vi.fn(async () => true)
    expect(promptReceipt({ prompt: empty }, settledAtCreation({ prompt: empty }, {}))).toEqual({})
    expect(
      await deliverTerminalLaunchPrompt(execution(delivered, empty), 'terminal', {
        freshLaunch: true
      })
    ).toEqual({ outcome: 'not-delivered' })
    expect(delivered).not.toHaveBeenCalled()
  })
  it('generic draft policy remains caller-owned and does not paste', async () => {
    const delivered = vi.fn(async () => true)
    const generic = { text: 'draft', delivery: 'draft' } as const
    expect(settledAtCreation({ prompt: generic }, {})).toEqual({ outcome: 'not-delivered' })
    expect(
      await deliverTerminalLaunchPrompt(execution(delivered, generic), 'terminal', {
        freshLaunch: true
      })
    ).toEqual({ outcome: 'not-delivered' })
    expect(delivered).not.toHaveBeenCalled()
  })
})
