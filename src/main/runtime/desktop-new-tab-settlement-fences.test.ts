import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAgentPromptSubmissionRuntime } from './agent-prompt-submission-runtime-test-fixture'
import {
  WRITE_ACCEPTED,
  writeRefused,
  writeUnverifiable,
  type WriteSettlement
} from '../../shared/pty-write-settlement'
import {
  BRACKETED_PASTE_START,
  wrapTerminalBracketedPasteText
} from '../../shared/terminal-bracketed-paste-text'

vi.mock('../git/worktree', () => ({
  listWorktrees: vi
    .fn()
    .mockResolvedValue([
      { path: '/tmp/worktree-a', head: 'abc', branch: 'test', isBare: false, isMainWorktree: false }
    ]),
  listWorktreesStrict: vi
    .fn()
    .mockResolvedValue([
      { path: '/tmp/worktree-a', head: 'abc', branch: 'test', isBare: false, isMainWorktree: false }
    ])
}))

async function settlementRuntime(agent: 'claude' | 'codex' = 'claude') {
  const { runtime, handle } = await createAgentPromptSubmissionRuntime(() => undefined, agent)
  const writes: string[] = []
  let settle: (result: WriteSettlement) => void = () => {}
  let entered: () => void = () => {}
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const controller = {
    write: vi.fn((_id: string, data: string) => {
      writes.push(data)
      return true
    }),
    writeWithSettlement: vi.fn((_id: string, data: string) => {
      writes.push(data)
      entered()
      return new Promise<WriteSettlement>((resolve) => {
        settle = resolve
      })
    }),
    kill: () => true,
    getForegroundProcess: async () => null
  }
  runtime.setPtyController(controller)
  return {
    runtime,
    handle,
    writes,
    controller,
    started,
    settle: (result: WriteSettlement) => settle(result)
  }
}

describe('desktop prompt transport settlement preserves lifecycle fences', () => {
  afterEach(() => vi.useRealTimers())

  for (const boundary of [
    'generation',
    'controller',
    'close',
    'contact',
    'permission',
    'abort',
    'foreground'
  ] as const) {
    it(`stops after a settled prefix when ${boundary} changes during transport wait`, async () => {
      const rig = await settlementRuntime(boundary === 'permission' ? 'codex' : 'claude')
      const abort = new AbortController()
      let foreground = true
      const pending = rig.runtime.sendTerminalAgentPrompt(rig.handle, 'x'.repeat(70_000), {
        inputKind: 'launch',
        desktopNewTab: { submit: true },
        signal: abort.signal,
        beforeWrite: () => {
          if (!foreground) {
            throw new Error('agent_not_in_foreground')
          }
        }
      })
      const failed = pending.catch((error: unknown) => error)
      await rig.started
      expect(rig.writes).toEqual([BRACKETED_PASTE_START])
      if (boundary === 'generation') {
        rig.runtime.synchronizePtyOutputSequenceFromProvider(
          'pty-prompt',
          { value: 0, generation: 'reset' },
          0
        )
      } else if (boundary === 'controller') {
        rig.runtime.setPtyController({ ...rig.controller })
      } else if (boundary === 'close') {
        await rig.runtime.closeTerminal(rig.handle)
      } else if (boundary === 'contact') {
        rig.runtime.markPtyLivenessUnverifiable('pty-prompt', 'execution host contact lost')
      } else if (boundary === 'permission') {
        rig.runtime.onPtyData('pty-prompt', '\x1b]0;Codex waiting for permission\x07', Date.now())
      } else if (boundary === 'abort') {
        abort.abort()
      } else {
        foreground = false
      }
      rig.settle(WRITE_ACCEPTED)
      expect(await failed).toBeInstanceOf(Error)
      expect(rig.writes).toEqual([BRACKETED_PASTE_START])
    })
  }

  it('cancels a never-settling controller write without waiting or sending more bytes', async () => {
    const rig = await settlementRuntime()
    const abort = new AbortController()
    const pending = rig.runtime.sendTerminalAgentPrompt(rig.handle, 'x'.repeat(70_000), {
      inputKind: 'launch',
      desktopNewTab: { submit: true },
      signal: abort.signal
    })
    const failed = pending.catch((error: unknown) => error)
    await rig.started
    abort.abort()
    expect(await failed).toMatchObject({ message: 'terminal_not_writable' })
    expect(rig.writes).toEqual([BRACKETED_PASTE_START])
  })

  for (const settlement of [
    writeRefused('provider_refused_write'),
    writeUnverifiable('transport_settlement_lost', true)
  ]) {
    it(`stops a partial prefix on ${settlement.outcome} without end marker or Enter`, async () => {
      const rig = await settlementRuntime()
      rig.controller.writeWithSettlement.mockImplementation(async (_id, data) => {
        rig.writes.push(data)
        return rig.writes.length === 2 ? settlement : WRITE_ACCEPTED
      })
      await expect(
        rig.runtime.sendTerminalAgentPrompt(rig.handle, 'x'.repeat(70_000), {
          inputKind: 'launch',
          desktopNewTab: { submit: true }
        })
      ).rejects.toThrow('terminal_not_writable')
      expect(rig.writes).toEqual([BRACKETED_PASTE_START, 'x'.repeat(16_384)])
      expect(rig.controller.write).not.toHaveBeenCalled()
    })
  }

  it('does not revive shared cleanup after a provider throws following a possible handoff', async () => {
    const rig = await settlementRuntime()
    rig.controller.writeWithSettlement.mockImplementation(async (_id, data) => {
      rig.writes.push(data)
      if (rig.writes.length === 2) {
        throw new Error('transport callback lost')
      }
      return WRITE_ACCEPTED
    })
    await expect(
      rig.runtime.sendTerminalAgentPrompt(rig.handle, 'x'.repeat(70_000), {
        inputKind: 'launch',
        desktopNewTab: { submit: true }
      })
    ).rejects.toThrow('terminal_not_writable')
    expect(rig.writes).toEqual([BRACKETED_PASTE_START, 'x'.repeat(16_384)])
  })

  it('never retries an unconfirmed first Enter', async () => {
    vi.useFakeTimers()
    const rig = await settlementRuntime('codex')
    rig.controller.writeWithSettlement.mockImplementation(async (_id, data) => {
      rig.writes.push(data)
      return data === '\r' ? writeUnverifiable('transport_settlement_lost', true) : WRITE_ACCEPTED
    })
    const pending = rig.runtime.sendTerminalAgentPrompt(rig.handle, 'hello', {
      inputKind: 'launch',
      desktopNewTab: { submit: true }
    })
    const failed = pending.catch((error: unknown) => error)
    await vi.runAllTimersAsync()
    expect(await failed).toMatchObject({ message: 'terminal_not_writable' })
    expect(rig.writes).toEqual([wrapTerminalBracketedPasteText('hello'), '\r'])
  })
})
