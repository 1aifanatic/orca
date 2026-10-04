import { beforeEach, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
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
      startupPrompt: 'qodercli remains prompt text'
    })
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        launchAgent: 'qoder',
        command: `${selected} --prompt-interactive 'qodercli remains prompt text'`
      })
    )
  }
)

it('a modern-only repo-less folder start reaches the same production spawn boundary', async () => {
  vi.mocked(detectAgentCommandsOnHost).mockResolvedValueOnce(new Set(['qoder']))
  const spawn = vi.fn().mockResolvedValue({ id: 'pty-independent-folder' })
  const folderPath = await mkdtemp(join(process.cwd(), '.context/qoder-independent-folder-'))
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
  try {
    await runtime.createTerminal(`id:${TEST_FOLDER_WORKSPACE_KEY}`, {
      startupAgent: 'qoder',
      agentArgs: null
    })
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({ launchAgent: 'qoder', command: 'qoder' })
    )
  } finally {
    await rm(folderPath, { recursive: true, force: true })
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
})
