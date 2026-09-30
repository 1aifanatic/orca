import './mock-descendant-sweep'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { SubprocessHandle } from './session-subprocess-handle'
import { TerminalHost, type TerminalHostOptions } from './terminal-host'

type SpawnSubprocess = TerminalHostOptions['spawnSubprocess']

describe('TerminalHost attach-only sessions', () => {
  let host: TerminalHost
  let spawnSubprocess: Mock<SpawnSubprocess>
  let emitData: (data: string) => void = () => {}

  beforeEach(() => {
    spawnSubprocess = vi.fn<SpawnSubprocess>(() => {
      let onExit: ((code: number) => void) | undefined
      const subprocess: SubprocessHandle = {
        pid: 99999,
        getForegroundProcess: vi.fn(() => null),
        write: vi.fn(),
        resize: vi.fn(),
        kill: vi.fn(() => onExit?.(0)),
        terminateOwnedTree: () => 'unavailable' as const,
        forceKill: vi.fn(() => onExit?.(137)),
        signal: vi.fn(),
        onData: vi.fn((callback: (data: string) => void) => {
          emitData = callback
        }),
        onExit: vi.fn((callback: (code: number) => void) => {
          onExit = callback
        }),
        dispose: vi.fn()
      }
      return subprocess
    })
    host = new TerminalHost({ spawnSubprocess })
  })

  afterEach(async () => {
    await host.dispose()
  })

  it('attaches only to an existing stable session', async () => {
    await host.createOrAttach({
      sessionId: 'stable-pane-session',
      cols: 80,
      rows: 24,
      streamClient: { onData: vi.fn(), onExit: vi.fn() }
    })

    const result = await host.createOrAttach({
      sessionId: 'stable-pane-session',
      cols: 120,
      rows: 40,
      attachOnly: true,
      streamClient: { onData: vi.fn(), onExit: vi.fn() }
    })

    expect(result.isNew).toBe(false)
    expect(spawnSubprocess).toHaveBeenCalledOnce()
  })

  it("reports an existing session's OSC 133 state with the attach, never with a create", async () => {
    const created = await host.createOrAttach({
      sessionId: 'stable-pane-session',
      cols: 80,
      rows: 24,
      streamClient: { onData: vi.fn(), onExit: vi.fn() }
    })
    const attach = () =>
      host.createOrAttach({
        sessionId: 'stable-pane-session',
        cols: 80,
        rows: 24,
        attachOnly: true,
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })

    expect(created.shellCommand).toBeUndefined()
    expect((await attach()).shellCommand).toBe('unmarked')
    emitData('\x1b]133;C\x07opencode run')
    expect((await attach()).shellCommand).toBe('running')
    emitData('\x1b]133;D;0\x07\x1b]133;A\x07$ ')
    expect((await attach()).shellCommand).toBe('at-prompt')
  })

  it('does not create when an attach-only stable session is absent', async () => {
    await expect(
      host.createOrAttach({
        sessionId: 'missing-stable-pane-session',
        cols: 80,
        rows: 24,
        attachOnly: true,
        streamClient: { onData: vi.fn(), onExit: vi.fn() }
      })
    ).rejects.toThrow('Session not found: missing-stable-pane-session')
    expect(spawnSubprocess).not.toHaveBeenCalled()
  })
})
