import { beforeEach, expect, it, vi } from 'vitest'
import filesystem from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
