import { describe, expect, it, vi } from 'vitest'
import { RuntimePtyForegroundAgent } from './runtime-pty-foreground-agent'
import type { RuntimePtyController } from './runtime-pty-controller-contract'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import { resolveRemoteForegroundEvidence } from '../providers/agent-foreground-process-batch'
import type { ProcessTableRow } from '../../shared/process-table-snapshot'
import type { RemoteForegroundEvidence } from '../../shared/foreground-process-evidence'
import type { TerminalProcessInspection } from '../../shared/terminal-process-inspection'

function setup(remote = false) {
  const pty: Pick<
    RuntimePtyWorktreeRecord,
    | 'connectionId'
    | 'incarnationId'
    | 'connected'
    | 'launchAgent'
    | 'foregroundAgent'
    | 'foregroundAgentIncarnationId'
  > = {
    connectionId: remote ? 'ssh-host' : null,
    incarnationId: 'generation-1',
    connected: true,
    launchAgent: null,
    foregroundAgent: 'claude'
  }
  const confirm = vi.fn<() => Promise<string | null>>().mockResolvedValue(null)
  let controller: RuntimePtyController = {
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => 'zsh',
    confirmForegroundProcess: confirm
  }
  const touched = vi.fn()
  const agent = new RuntimePtyForegroundAgent({
    getController: () => controller,
    getPty: () => pty,
    touchSnapshot: touched,
    finishDelayedSnapshot: vi.fn()
  })
  return {
    pty,
    agent,
    confirm,
    touched,
    replace: (next: RuntimePtyController) => {
      controller = next
    }
  }
}

describe('foreground identity on unknown observations', () => {
  it.each([null, '', 'node.exe', 'other-tool'])(
    'keeps the published Claude identity on %j',
    async (process) => {
      const h = setup()
      h.confirm.mockResolvedValue(process)
      await h.agent.refresh('pty-1')
      expect(h.pty.foregroundAgent).toBe('claude')
      expect(h.touched).not.toHaveBeenCalled()
      h.confirm.mockResolvedValue('zsh')
      await h.agent.refresh('pty-1')
      expect(h.pty.foregroundAgent).toBeNull()
      expect(h.touched).toHaveBeenCalledOnce()
    }
  )
  it('keeps a live local agent on the cached read without a fresh scan', async () => {
    const h = setup()
    h.pty.foregroundAgent = null
    h.replace({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'claude',
      confirmForegroundProcess: h.confirm
    })
    await h.agent.refresh('pty-1')
    expect(h.pty.foregroundAgent).toBe('claude')
    expect(h.confirm).not.toHaveBeenCalled()
  })
  // The Windows daemon tracker keeps the last agent name until an async scan retires it.
  it.each(['cmd.exe', 'zsh'])(
    'confirms an exit on a fresh %s read while the cached name still says claude',
    async (shell) => {
      const h = setup()
      const getForegroundProcess = vi.fn(async () => 'claude')
      h.confirm.mockResolvedValue(shell)
      h.replace({
        write: () => true,
        kill: () => true,
        getForegroundProcess,
        confirmForegroundProcess: h.confirm
      })
      const result = await h.agent.confirm('pty-1')
      expect(result?.judgement.verdict).toBe('exited')
      expect(h.pty.foregroundAgent).toBeNull()
      expect(getForegroundProcess).not.toHaveBeenCalled()
    }
  )
  it('does not let a pending cached refresh answer an exit confirmation', async () => {
    const h = setup()
    let answerCached: (value: string) => void = () => {}
    const getForegroundProcess = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          answerCached = resolve
        })
    )
    h.confirm.mockResolvedValue('cmd.exe')
    h.replace({
      write: () => true,
      kill: () => true,
      getForegroundProcess,
      confirmForegroundProcess: h.confirm
    })
    const refreshed = h.agent.refresh('pty-1')
    await vi.waitFor(() => expect(getForegroundProcess).toHaveBeenCalledOnce())
    const confirmed = h.agent.confirm('pty-1')
    answerCached('claude')
    await refreshed
    expect((await confirmed)?.judgement.verdict).toBe('exited')
    expect(h.pty.foregroundAgent).toBeNull()
    expect(h.confirm).toHaveBeenCalledOnce()
  })
  it('lets an exit confirmation reuse a pending refresh that fell through to a fresh read', async () => {
    const h = setup()
    let answerCached: (value: string) => void = () => {}
    const getForegroundProcess = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          answerCached = resolve
        })
    )
    h.confirm.mockResolvedValue('cmd.exe')
    h.replace({
      write: () => true,
      kill: () => true,
      getForegroundProcess,
      confirmForegroundProcess: h.confirm
    })
    const refreshed = h.agent.refresh('pty-1')
    await vi.waitFor(() => expect(getForegroundProcess).toHaveBeenCalledOnce())
    const confirmed = h.agent.confirm('pty-1')
    answerCached('cmd.exe')
    await refreshed
    expect((await confirmed)?.judgement.verdict).toBe('exited')
    expect(h.pty.foregroundAgent).toBeNull()
    expect(h.confirm).toHaveBeenCalledOnce()
  })
  it('lets a refresh reuse a pending fresh exit read', async () => {
    const h = setup()
    const getForegroundProcess = vi.fn(async () => 'claude')
    h.confirm.mockResolvedValue('cmd.exe')
    h.replace({
      write: () => true,
      kill: () => true,
      getForegroundProcess,
      confirmForegroundProcess: h.confirm
    })
    const confirmed = h.agent.confirm('pty-1')
    await h.agent.refresh('pty-1')
    await confirmed
    expect(h.confirm).toHaveBeenCalledOnce()
    expect(getForegroundProcess).not.toHaveBeenCalled()
    expect(h.pty.foregroundAgent).toBeNull()
  })
  it('keeps the per-turn hook recovery on the cached read', async () => {
    const h = setup()
    h.replace({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'claude',
      confirmForegroundProcess: h.confirm
    })
    const result = await h.agent.confirm('pty-1', 0, false)
    expect(result?.judgement.verdict).toBe('live')
    expect(h.confirm).not.toHaveBeenCalled()
  })
  it('rejects a result for a replaced terminal incarnation', async () => {
    const h = setup()
    let answer: (value: string) => void = () => {}
    h.confirm.mockImplementation(
      () =>
        new Promise((resolve) => {
          answer = resolve
        })
    )
    const pending = h.agent.refresh('pty-1')
    await vi.waitFor(() => expect(h.confirm).toHaveBeenCalled())
    h.pty.incarnationId = 'generation-2'
    answer('zsh')
    await pending
    expect(h.pty.foregroundAgent).toBe('claude')
  })
  it.each([
    ['an old relay without evidence', 'claude', 'missing'],
    ['stale evidence', 'claude', 'stale'],
    ['evidence for another incarnation', 'claude', 'wrong-incarnation'],
    ['an SSH-to-Windows host', 'claude', 'windows'],
    ['another program in front', 'claude', 'vim'],
    ['an old host that cannot mark the shell', 'claude', 'old-host-shell'],
    ['the shell back at its prompt', null, 'shell']
  ] as const)('on SSH, %s leaves foregroundAgent %j', async (_label, expected, kind) => {
    const h = setup(true)
    h.replace({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'zsh',
      inspectProcess: async (): Promise<TerminalProcessInspection> => ({
        foregroundProcess: 'zsh',
        hasChildProcesses: false,
        ...(kind === 'missing' ? {} : { foregroundProcessEvidence: hostEvidence(kind) })
      })
    })
    await h.agent.refresh('pty-1')
    expect(h.pty.foregroundAgent).toBe(expected)
  })
  it('stamps each read that names the agent with the incarnation it saw', async () => {
    const h = setup()
    h.confirm.mockResolvedValue('claude')
    await h.agent.refresh('pty-1')
    expect(h.pty.foregroundAgentIncarnationId).toBe('generation-1')
    // A same-id respawn running the same agent must not keep the predecessor's stamp.
    h.pty.incarnationId = 'generation-2'
    await h.agent.confirm('pty-1')
    expect(h.pty.foregroundAgent).toBe('claude')
    expect(h.pty.foregroundAgentIncarnationId).toBe('generation-2')
  })
  it('clears foregroundAgent from the same read that confirms an exit', async () => {
    const h = setup()
    h.confirm.mockResolvedValue('zsh')
    const result = await h.agent.confirm('pty-1')
    expect(result?.judgement.verdict).toBe('exited')
    expect(h.pty.foregroundAgent).toBeNull()
    expect(h.touched).toHaveBeenCalledOnce()
  })
})

/** Host evidence built by the same builder the relay and daemon use, from one process table. */
function hostEvidence(
  kind: 'stale' | 'wrong-incarnation' | 'windows' | 'vim' | 'old-host-shell' | 'shell'
): RemoteForegroundEvidence {
  const shell: ProcessTableRow = {
    pid: 10,
    ppid: 1,
    pgid: 10,
    tpgid: kind === 'vim' ? 11 : 10,
    tty: '/dev/pts/1',
    startTime: '100',
    stat: 'Ss',
    command: '-zsh'
  }
  const rows: ProcessTableRow[] =
    kind === 'vim'
      ? [shell, { ...shell, pid: 11, ppid: 10, pgid: 11, stat: 'S+', command: 'vim notes.md' }]
      : [shell]
  const evidence = resolveRemoteForegroundEvidence(
    { rootPid: 10, fallbackProcess: 'zsh' },
    {
      ptyId: 'pty-1',
      ptyIncarnationId: kind === 'wrong-incarnation' ? 'old' : 'generation-1',
      authorityGeneration: 'host-1',
      observationEpoch: 1,
      capturedAgeMs: kind === 'stale' ? 10000 : 0,
      platform: kind === 'windows' ? 'win32' : 'linux'
    },
    rows
  )
  if (kind === 'old-host-shell' && evidence.verdict === 'live') {
    const { shellForeground: _omitted, ...legacy } = evidence
    return legacy
  }
  return evidence
}
