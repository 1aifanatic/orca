import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type * as NodeOs from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as Wsl from '../wsl'

const testState = vi.hoisted(() => ({
  fakeHomeDir: '',
  userDataDir: '',
  wslPaths: new Set<string>(),
  getActiveMultiplexer: vi.fn(),
  getSshFilesystemProvider: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: () => testState.userDataDir }
}))
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeOs>()),
  homedir: () => testState.fakeHomeDir
}))
vi.mock('../wsl', async (importOriginal) => ({
  ...(await importOriginal<typeof Wsl>()),
  isWslPath: (path: string) => testState.wslPaths.has(path)
}))
vi.mock('../ssh/ssh-target-registry', () => ({
  getActiveMultiplexer: testState.getActiveMultiplexer
}))
vi.mock('../providers/ssh-filesystem-dispatch', () => ({
  getSshFilesystemProvider: testState.getSshFilesystemProvider
}))

const { diagnoseAgentWorkspaceTrust, WORKSPACE_TRUST_DIAGNOSIS_DEADLINE_MS } =
  await import('./agent-workspace-trust-diagnosis')
const { createWorkerStartTrustBlockedError } =
  await import('./rpc/methods/orchestration/worker/worker-start-trust-block')
const { runExclusivelyForCodexTrustConfig } =
  await import('../codex/codex-trust-config-mutation-queue')

let workspace: string
let previousUserDataPath: string | undefined

beforeEach(() => {
  testState.fakeHomeDir = mkdtempSync(join(tmpdir(), 'orca-trust-diagnosis-home-'))
  testState.userDataDir = mkdtempSync(join(tmpdir(), 'orca-trust-diagnosis-user-data-'))
  testState.wslPaths.clear()
  workspace = mkdtempSync(join(tmpdir(), 'orca-trust-diagnosis-ws-'))
  previousUserDataPath = process.env.ORCA_USER_DATA_PATH
  process.env.ORCA_USER_DATA_PATH = testState.userDataDir
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  for (const dir of [testState.fakeHomeDir, testState.userDataDir, workspace]) {
    rmSync(dir, { recursive: true, force: true })
  }
  if (previousUserDataPath === undefined) {
    delete process.env.ORCA_USER_DATA_PATH
  } else {
    process.env.ORCA_USER_DATA_PATH = previousUserDataPath
  }
})

function accountHome(name: string, config: string): string {
  const home = join(testState.userDataDir, 'codex-accounts', name, 'home')
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'config.toml'), config, 'utf-8')
  return home
}

const BROKEN_CONFIG = '[a]\n[a]\nx = 1\n'

function diagnoseLocal(agent: 'codex' | 'claude' | 'cursor', launchHome: string | null = null) {
  return diagnoseAgentWorkspaceTrust({
    agent,
    connectionId: null,
    workspacePath: workspace,
    resolveCodexLaunchHome: async () => launchHome
  })
}

function blockedError(
  agent: 'codex' | 'claude' | 'cursor' | null,
  diagnosis: Awaited<ReturnType<typeof diagnoseLocal>> | null
) {
  return createWorkerStartTrustBlockedError({
    reason: 'agent-trust-workspace',
    agent,
    workspacePath: workspace,
    diagnosis
  })
}

describe('diagnosing a worker stalled at the trust screen (#23847)', () => {
  it('names the launch’s own per-account config.toml when that home cannot be written', async () => {
    const home = accountHome('broken', BROKEN_CONFIG)

    const diagnosis = await diagnoseLocal('codex', home)

    expect(diagnosis).toEqual({
      kind: 'failed',
      detail: expect.stringContaining(join(home, 'config.toml'))
    })
    const error = blockedError('codex', diagnosis)
    expect(error.message).toMatch(
      /^Agent startup blocked: agent-trust-workspace\. codex is asking whether to trust .* Orca could not pre-trust it: /
    )
    expect(error.message).toContain(join(home, 'config.toml'))
    expect(error.message).not.toMatch(/\.\.$/)
    expect(error.recovery).toBe(
      `Start codex in ${workspace} once and choose to trust the folder (or fix the file named above), then start the worker again.`
    )
  })

  it('retries only the home this launch reads, so another account’s broken home is never blamed', async () => {
    const otherAccount = accountHome('other', BROKEN_CONFIG)
    const launchAccount = accountHome('mine', 'model = "o3"\n')

    const diagnosis = await diagnoseLocal('codex', launchAccount)

    expect(diagnosis).toEqual({ kind: 'written' })
    expect(readFileSync(join(launchAccount, 'config.toml'), 'utf-8')).toContain(
      'trust_level = "trusted"'
    )
    expect(readFileSync(join(otherAccount, 'config.toml'), 'utf-8')).toBe(BROKEN_CONFIG)
  })

  it('never blames another agent’s failed trust write', async () => {
    // A file where Cursor needs a directory: Cursor's own write fails, Codex's does not.
    writeFileSync(join(testState.fakeHomeDir, '.cursor'), 'not a directory', 'utf-8')

    expect(await diagnoseLocal('cursor')).toMatchObject({ kind: 'failed' })
    const codex = await diagnoseLocal('codex')
    expect(codex).toEqual({ kind: 'written' })
    expect(blockedError('codex', codex).message).not.toContain('.cursor')
  })

  it('says the retry landed and the worker can simply be started again', async () => {
    const diagnosis = await diagnoseLocal('codex')

    expect(diagnosis).toEqual({ kind: 'written' })
    const error = blockedError('codex', diagnosis)
    expect(error.message).toContain(
      "Orca's trust write has now landed, so starting the worker again should get past this screen."
    )
    expect(error.recovery).toMatch(/^Start the worker again; if codex still asks/)
  })

  it('reports a config lane still busy within the short diagnosis bound', async () => {
    vi.useFakeTimers()
    let releaseLane!: () => void
    const held = runExclusivelyForCodexTrustConfig(
      join(testState.fakeHomeDir, '.codex', 'config.toml'),
      () =>
        new Promise<void>((resolve) => {
          releaseLane = resolve
        })
    )
    let settled = false
    const pending = diagnoseLocal('codex').then((diagnosis) => {
      settled = true
      return diagnosis
    })

    await vi.advanceTimersByTimeAsync(WORKSPACE_TRUST_DIAGNOSIS_DEADLINE_MS - 1)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(2)
    const diagnosis = await pending
    expect(diagnosis).toEqual({ kind: 'still-waiting' })
    expect(blockedError('codex', diagnosis).message).toContain(
      "Orca's trust write is still waiting behind another codex config change."
    )
    releaseLane()
    await held
  })

  it('says Orca never pre-trusts for an agent without a trust preset', async () => {
    const diagnosis = await diagnoseLocal('claude')

    expect(diagnosis).toEqual({ kind: 'not-pretrusted', host: 'any' })
    expect(blockedError('claude', diagnosis).message).toContain(
      'Orca does not pre-trust folders for claude.'
    )
  })

  it('does not claim a Codex trust write for a WSL workspace, which launch prep skips', async () => {
    testState.wslPaths.add(workspace)

    const diagnosis = await diagnoseLocal('codex')

    expect(diagnosis).toEqual({ kind: 'not-pretrusted', host: 'wsl' })
    expect(blockedError('codex', diagnosis).message).toContain(
      'Orca does not pre-trust folders for codex inside WSL.'
    )
  })

  it('neither blames nor claims a trust write for a reused terminal of unknown agent', () => {
    const error = blockedError(null, null)

    expect(error.message).toContain('The agent is asking whether to trust')
    expect(error.message).toContain(
      "This terminal was reused, so Orca cannot tell which agent's trust applies."
    )
    expect(error.recovery).toBe(
      `Start the agent in ${workspace} once and choose to trust the folder, then start the worker again.`
    )
  })

  describe('over SSH', () => {
    function diagnoseRemote(agent: 'codex' | 'antigravity') {
      return diagnoseAgentWorkspaceTrust({
        agent,
        connectionId: 'ssh-1',
        workspacePath: '/srv/repo',
        resolveCodexLaunchHome: async () => {
          throw new Error('a remote diagnosis must not resolve a local Codex home')
        }
      })
    }

    it('reports the SSH failure itself', async () => {
      testState.getActiveMultiplexer.mockReturnValue({
        request: vi.fn(async () => {
          throw new Error('ssh channel closed.')
        })
      })
      testState.getSshFilesystemProvider.mockReturnValue({})

      const diagnosis = await diagnoseRemote('codex')

      expect(diagnosis).toEqual({ kind: 'failed', detail: 'ssh channel closed.' })
      const error = blockedError('codex', diagnosis)
      expect(error.message).toContain('Orca could not pre-trust it: ssh channel closed.')
      expect(error.message).not.toMatch(/\.\.$/)
    })

    it('does not call a disconnected host written', async () => {
      testState.getActiveMultiplexer.mockReturnValue(undefined)
      testState.getSshFilesystemProvider.mockReturnValue(undefined)

      expect(await diagnoseRemote('codex')).toEqual({
        kind: 'failed',
        detail: expect.stringContaining('could not resolve the home directory on SSH connection')
      })
    })

    it('does not call a skipped remote write written for an agent with no remote preset', async () => {
      testState.getActiveMultiplexer.mockReturnValue({
        request: vi.fn(async () => ({ resolvedPath: '/home/u' }))
      })
      testState.getSshFilesystemProvider.mockReturnValue({
        realpath: vi.fn(async (path: string) => path)
      })

      expect(await diagnoseRemote('antigravity')).toEqual({ kind: 'not-pretrusted', host: 'ssh' })
    })
  })

  it('never throws, even when resolving the launch home throws synchronously', async () => {
    await expect(
      diagnoseAgentWorkspaceTrust({
        agent: 'codex',
        connectionId: null,
        workspacePath: workspace,
        resolveCodexLaunchHome: () => {
          throw new Error('Codex runtime home service is not initialized')
        }
      })
    ).resolves.toEqual({
      kind: 'failed',
      detail: 'Codex runtime home service is not initialized'
    })
  })
})
