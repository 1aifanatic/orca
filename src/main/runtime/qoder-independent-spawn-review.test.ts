import { beforeEach, expect, it, vi } from 'vitest'
import filesystem from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildAgentResumeStartupPlan } from '../../shared/tui-agent-startup'
import { buildAiVaultResumeShellCommand } from '../../shared/ai-vault-resume-command'

await import('./orca-runtime-test-mocks.spec')
await import('./orca-runtime-test-lifecycle.spec')
const { OrcaRuntimeService } = await import('./orca-runtime-test-mocks.spec')
const {
  store,
  TEST_WORKTREE_PATH,
  TEST_FOLDER_WORKSPACE_KEY,
  createFolderWorkspaceRuntimeStore,
  makeFolderWorkspace,
  makeFolderProjectGroup
} = await import('./orca-runtime-test-fixtures.spec')
const { detectAgentCommandsOnHost } = await import('../preflight/agent-detection')
beforeEach(() =>
  vi
    .mocked(detectAgentCommandsOnHost)
    .mockReset()
    .mockResolvedValue(new Set(['qodercli']))
)

it.each([
  ['modern-only', ['qoder'], 'qoder'],
  ['legacy-only', ['qodercli'], 'qodercli'],
  ['both', ['qoder', 'qodercli'], 'qodercli']
] as const)(
  'fresh managed start reaches the production spawn boundary: %s',
  async (_, found, selected) => {
    vi.mocked(detectAgentCommandsOnHost).mockResolvedValueOnce(new Set(found))
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-independent-start' })
    const runtime = new OrcaRuntimeService({
      ...store,
      getSettings: () => ({ ...store.getSettings(), disabledTuiAgents: [], agentCmdOverrides: {} })
    })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      startupAgent: 'qoder',
      agentArgs: null,
      launchSource: 'orchestration',
      startupPrompt: 'qodercli remains prompt text'
    })
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        launchAgent: 'qoder',
        command: `${selected} --prompt-interactive 'qodercli remains prompt text'`
      })
    )
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn.mock.calls[0]?.[0].telemetry).toEqual({
      agent_kind: 'qoder',
      launch_source: 'orchestration',
      request_kind: 'new'
    })
  }
)

it('a modern-only repo-less folder start reaches the same production spawn boundary', async () => {
  vi.mocked(detectAgentCommandsOnHost).mockResolvedValueOnce(new Set(['qoder']))
  const spawn = vi.fn().mockResolvedValue({ id: 'pty-independent-folder' })
  const createTempDirectory = filesystem.mkdtemp
  const guard = vi.spyOn(filesystem, 'mkdtemp').mockImplementation((prefix, options) => {
    // CI has no .context parent; reject that prerequisite even on a developer checkout.
    expect(String(prefix)).not.toContain('.context')
    return createTempDirectory(prefix, options)
  })
  let folderPath: string | undefined
  try {
    folderPath = await filesystem.mkdtemp(join(tmpdir(), 'qoder-independent-folder-'))
    const folderStore = createFolderWorkspaceRuntimeStore(
      makeFolderWorkspace({ folderPath }),
      makeFolderProjectGroup({ parentPath: folderPath })
    )
    const runtime = new OrcaRuntimeService({
      ...folderStore,
      getSettings: () => ({ ...store.getSettings(), disabledTuiAgents: [], agentCmdOverrides: {} })
    })
    runtime.setPtyController({
      spawn,
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    await runtime.createTerminal(`id:${TEST_FOLDER_WORKSPACE_KEY}`, {
      startupAgent: 'qoder',
      agentArgs: null
    })
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({ launchAgent: 'qoder', command: 'qoder' })
    )
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(spawn.mock.calls[0]?.[0].cwd).toBe(folderPath)
    expect(spawn.mock.calls[0]?.[0].telemetry).toEqual({
      agent_kind: 'qoder',
      launch_source: 'unknown',
      request_kind: 'new'
    })
    expect((await filesystem.stat(folderPath)).isDirectory()).toBe(true)
    await expect(filesystem.stat(join(folderPath, '.git'))).rejects.toMatchObject({
      code: 'ENOENT'
    })
  } finally {
    guard.mockRestore()
    if (folderPath) {
      await filesystem.rm(folderPath, { recursive: true, force: true })
    }
  }
})

it('selects the installed command for a mobile Qoder history resume at creation', async () => {
  vi.mocked(detectAgentCommandsOnHost).mockResolvedValueOnce(new Set(['qoder']))
  const spawn = vi.fn().mockResolvedValue({ id: 'pty-mobile-qoder-resume' })
  const runtime = new OrcaRuntimeService(store)
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  const plan = buildAgentResumeStartupPlan({
    agent: 'qoder',
    providerSession: { key: 'session_id', id: 'same-qoder-session' },
    cmdOverrides: {},
    platform: 'darwin'
  })
  if (!plan) {
    throw new Error('Missing Qoder resume plan')
  }
  const launch = {
    command: buildAiVaultResumeShellCommand({
      resumeCommand: plan.launchCommand,
      cwd: TEST_WORKTREE_PATH,
      platform: 'darwin'
    }),
    launchAgent: plan.agent,
    launchConfig: plan.launchConfig
  }
  await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
    command: launch.command,
    launchAgent: launch.launchAgent,
    launchConfig: launch.launchConfig
  })
  expect(spawn).toHaveBeenCalledTimes(1)
  expect(spawn).toHaveBeenCalledWith(
    expect.objectContaining({
      command: launch.command.replace(/qodercli(?=\s)/, 'qoder'),
      launchAgent: 'qoder'
    })
  )
})

it('host discovery refusal prevents any production spawn', async () => {
  vi.mocked(detectAgentCommandsOnHost).mockRejectedValueOnce(
    new Error('execution host unavailable')
  )
  const spawn = vi.fn()
  const runtime = new OrcaRuntimeService(store)
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  await expect(
    runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      launchAgent: 'qoder',
      command: 'qodercli --resume original-id'
    })
  ).rejects.toThrow('execution host unavailable')
  expect(spawn).not.toHaveBeenCalled()
})

it('caller-owned explicit executable survives production resume without discovery', async () => {
  const detect = vi.mocked(detectAgentCommandsOnHost)
  detect.mockClear()
  const spawn = vi.fn().mockResolvedValue({ id: 'pty-independent-explicit' })
  const runtime = new OrcaRuntimeService(store)
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
    launchAgent: 'qoder',
    command: '/caller/qodercli --resume original-id'
  })
  expect(spawn).toHaveBeenCalledWith(
    expect.objectContaining({ command: '/caller/qodercli --resume original-id' })
  )
  expect(detect).not.toHaveBeenCalled()
  expect(spawn).toHaveBeenCalledTimes(1)
  expect(spawn.mock.calls[0]?.[0].telemetry).toBeUndefined()
})

it.each([
  ['bare', 'qodercli'],
  ['resume', 'qodercli --resume original-id']
] as const)('does not falsely attribute a %s command as a fresh start', async (_, command) => {
  const spawn = vi.fn().mockResolvedValue({ id: 'pty-independent-unattributed' })
  const runtime = new OrcaRuntimeService(store)
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => null
  })
  await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
    command,
    agentArgs: null,
    launchSource: 'orchestration',
    ...(command.includes('--resume') ? { launchAgent: 'qoder' as const } : {})
  })
  expect(spawn).toHaveBeenCalledTimes(1)
  expect(spawn.mock.calls[0]?.[0].command).toBe(command)
  expect(spawn.mock.calls[0]?.[0].telemetry).toBeUndefined()
})

it.each([
  'client_disconnected',
  'Terminal creation timed out',
  'quoted-agent-command',
  'wsl-inventory'
])('reconciles a paired Qoder resume after ambiguous creation: %s', async (scenario) => {
  const failure = ['quoted-agent-command', 'wsl-inventory'].includes(scenario)
    ? 'client_disconnected'
    : scenario
  const { withPlatform } = await import('./orca-runtime-test-fixtures.spec')
  await withPlatform(scenario === 'wsl-inventory' ? 'win32' : 'darwin', async () => {
    vi.useFakeTimers()
    try {
      const { electronMocks } = await import('./orca-runtime-test-mocks.spec')
      const { TEST_WORKTREE_ID } = await import('./orca-runtime-test-fixtures.spec')
      vi.mocked(detectAgentCommandsOnHost).mockResolvedValue(new Set(['qoder']))
      const runtime = new OrcaRuntimeService(store)
      runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
      const acceptedCommands: string[] = []
      const live: {
        id: string
        cwd: string
        title: string
        worktreeId: string
        terminalHandle: string
        wslDistro?: string
      }[] = []
      let connection = new AbortController()
      const kill = vi.fn((id: string) => {
        const index = live.findIndex((entry) => entry.id === id)
        if (index !== -1) {
          live.splice(index, 1)
        }
        return true
      })
      const spawn = vi.fn(async (args: { command?: string; preAllocatedHandle?: string }) => {
        if (args.command) {
          acceptedCommands.push(args.command)
        }
        live.push({
          id: 'qoder-live-resume',
          cwd: TEST_WORKTREE_PATH,
          title: 'Qoder',
          worktreeId: TEST_WORKTREE_ID,
          terminalHandle: args.preAllocatedHandle ?? '',
          ...(scenario === 'wsl-inventory' ? { wslDistro: 'Ubuntu-Orca' } : {})
        })
        if (failure === 'client_disconnected') {
          connection.abort()
        }
        throw new Error(failure)
      })
      runtime.setPtyController({
        spawn,
        listProcesses: async () => live,
        write: () => true,
        kill,
        getForegroundProcess: async () => null
      })
      const send = vi.fn((channel: string, payload: { command?: string }) => {
        if (channel === 'terminal:requestTabCreate') {
          if (payload.command) {
            acceptedCommands.push(payload.command)
          }
          if (failure === 'client_disconnected') {
            connection.abort()
          }
        }
      })
      runtime.attachWindow(1)
      runtime.syncWindowGraph(1, { tabs: [], leaves: [] })
      electronMocks.BrowserWindow.fromId.mockReturnValue({
        isDestroyed: () => false,
        webContents: { isDestroyed: () => false, send, setBackgroundThrottling: vi.fn() }
      })
      const plan = buildAgentResumeStartupPlan({
        agent: 'qoder',
        providerSession: { key: 'session_id', id: 'same-qoder-session' },
        cmdOverrides: {},
        platform: 'darwin',
        ...(scenario === 'quoted-agent-command' ? { agentCommand: "'qodercli'" } : {})
      })
      expect(plan).not.toBeNull()
      if (!plan) {
        throw new Error('missing resume plan')
      }
      const resume = {
        command: plan.launchCommand,
        launchAgent: 'qoder' as const,
        launchConfig: plan.launchConfig,
        activate: false,
        select: false,
        navigation: 'caller' as const,
        clientNavigationId: 'paired-phone',
        clientMutationId: 'stable-resume-mutation'
      }
      const first = runtime
        .createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
          ...resume,
          signal: connection.signal
        })
        .then(
          () => null,
          (error: unknown) => error
        )
      await vi.advanceTimersByTimeAsync(10_001)
      expect(await first).toBeInstanceOf(Error)
      expect(kill).not.toHaveBeenCalled()
      connection = new AbortController()
      const retryPromise = runtime
        .createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
          ...resume,
          signal: connection.signal
        })
        .catch(() => null)
      await vi.advanceTimersByTimeAsync(10_001)
      const retry = await retryPromise
      expect(acceptedCommands).toHaveLength(1)
      expect(acceptedCommands[0]).toBe("qoder '--resume' 'same-qoder-session'")
      expect(retry?.tab).toMatchObject({ ptyId: 'qoder-live-resume', launchAgent: 'qoder' })
      expect(spawn).toHaveBeenCalledTimes(1)
      expect(send).not.toHaveBeenCalled()
      if (scenario === 'wsl-inventory' && retry) {
        expect(
          runtime.resolveTerminalPane(`${retry.tab.parentTabId}:${retry.tab.leafId}`).hostPlatform
        ).toBe('linux')
      }
    } finally {
      vi.useRealTimers()
    }
  })
})

it.each(['offline', 'legacy-identity'])(
  'refuses a Qoder command-bearing create with unverifiable inventory: %s',
  async (state) => {
    const { TEST_WORKTREE_ID } = await import('./orca-runtime-test-fixtures.spec')
    const runtime = new OrcaRuntimeService(store)
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
    const spawn = vi.fn()
    const kill = vi.fn()
    runtime.setPtyController({
      spawn,
      kill,
      write: () => true,
      getForegroundProcess: async () => null,
      listProcesses: async () => {
        if (state === 'offline') {
          throw new Error('host offline')
        }
        return [
          {
            id: 'older-live-pty',
            cwd: TEST_WORKTREE_PATH,
            title: 'shell',
            worktreeId: TEST_WORKTREE_ID
          }
        ]
      }
    })
    await expect(
      runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
        command: "qodercli '--resume' 'same-session'",
        launchAgent: 'qoder',
        clientNavigationId: 'paired-phone',
        clientMutationId: 'same-resume',
        select: false,
        activate: false
      })
    ).rejects.toThrow('runtime_unavailable')
    expect(spawn).not.toHaveBeenCalled()
    expect(kill).not.toHaveBeenCalled()
  }
)

it('reconciles after the reply-cache expires and isolates deliberate forks and paired callers', async () => {
  const { TEST_WORKTREE_ID } = await import('./orca-runtime-test-fixtures.spec')
  vi.useFakeTimers()
  try {
    const runtime = new OrcaRuntimeService(store)
    runtime.syncWindowGraph(0, { tabs: [], leaves: [] })
    const live: {
      id: string
      cwd: string
      title: string
      worktreeId: string
      terminalHandle: string
    }[] = []
    const spawn = vi.fn(async (args: { preAllocatedHandle?: string }) => {
      const id = `qoder-${live.length + 1}`
      live.push({
        id,
        cwd: TEST_WORKTREE_PATH,
        title: 'Qoder',
        worktreeId: TEST_WORKTREE_ID,
        terminalHandle: args.preAllocatedHandle ?? ''
      })
      return { id }
    })
    runtime.setPtyController({
      spawn,
      listProcesses: async () => live,
      kill: vi.fn(),
      write: () => true,
      getForegroundProcess: async () => null
    })
    const resume = {
      command: "qodercli '--resume' 'same-session'",
      launchAgent: 'qoder' as const,
      clientNavigationId: 'phone-a',
      clientMutationId: 'resume-a',
      select: false,
      activate: false
    }
    const first = await runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, resume)
    await vi.advanceTimersByTimeAsync(61_000)
    const retry = await runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, resume)
    expect(retry.tab.id).toBe(first.tab.id)
    expect(retry.tab.ptyId).toBe(first.tab.ptyId)
    expect(spawn).toHaveBeenCalledTimes(1)
    const fork = await runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
      ...resume,
      clientMutationId: 'resume-b'
    })
    const otherPhone = await runtime.createMobileSessionTerminal(`id:${TEST_WORKTREE_ID}`, {
      ...resume,
      clientNavigationId: 'phone-b'
    })
    expect(spawn).toHaveBeenCalledTimes(3)
    expect(new Set([first.tab.id, fork.tab.id, otherPhone.tab.id]).size).toBe(3)
  } finally {
    vi.useRealTimers()
  }
})
