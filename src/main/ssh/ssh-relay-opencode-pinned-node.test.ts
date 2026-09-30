import { beforeEach, describe, expect, it, vi } from 'vitest'
import type * as NodeRuntimeStore from './orcad-remote-node-runtime'
import type * as RuntimeCommands from './ssh-relay-opencode-runtime-commands'

const mocks = vi.hoisted(() => ({
  target: vi.fn(),
  archive: vi.fn(),
  executable: vi.fn(),
  ensure: vi.fn(),
  probe: vi.fn((_args: unknown) => 'cache-probe')
}))
vi.mock('./orcad-deployment-target', () => ({ resolveOrcadDeploymentTargetFacts: mocks.target }))
vi.mock('./pinned-runtime-materializer', () => ({
  materializeNodeRuntimeArchive: mocks.archive,
  materializeCachedNodeRuntime: mocks.executable
}))
vi.mock('./orcad-remote-node-runtime', async (original) => ({
  ...(await original<typeof NodeRuntimeStore>()),
  ensureRemoteOrcadNodeRuntime: mocks.ensure
}))
vi.mock('./ssh-relay-opencode-runtime-commands', async (original) => ({
  ...(await original<typeof RuntimeCommands>()),
  probeOpenCodeRuntimeCacheCommand: mocks.probe
}))

import { NODE_RUNTIME_ASSETS } from '../../shared/node-runtime-pin'
import type { SshConnection } from './ssh-connection'
import { getRemoteHostPlatform } from './ssh-remote-platform'
import { OPENCODE_RUNTIME_RESULT } from './ssh-relay-opencode-runtime-commands'
import { preparePinnedNodeForVault } from './ssh-relay-opencode-pinned-node'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every remote call is mocked; the connection is only passed through.
const conn = {} as SshConnection
const frame = (status: string, executable?: string) =>
  `${OPENCODE_RUNTIME_RESULT}${JSON.stringify({ status, executable })}\n`

function prepare(platform: 'linux-x64' | 'win32-x64', exec: (command: string) => Promise<string>) {
  const relayDir = `${platform === 'win32-x64' ? 'C:/Users/ada' : '/home/ada'}/.orca-remote/relay-build`
  return preparePinnedNodeForVault({
    conn,
    host: getRemoteHostPlatform(platform),
    nodePath: 'node',
    relayDir,
    cacheRoot: '/cache',
    referencePath: `${relayDir}/opencode-sqlite-runtime.json`,
    signal: new AbortController().signal,
    exec,
    remote: (operation) => operation()
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('pinned Node for the SSH vault reader', () => {
  it('uses the shared runtimes/ store on POSIX hosts and fetches the archive only on demand', async () => {
    mocks.target.mockResolvedValue({ target: 'linux-x64-glibc', glibc: { major: 2, minor: 31 } })
    mocks.ensure.mockImplementation(async (options) => {
      expect(options).toMatchObject({ slotDir: '/home/ada/.orca-remote/relay-build' })
      await options.archivePath()
      return { executable: '/home/ada/.orca-remote/runtimes/node-x/bin/node', transfer: 'uploaded' }
    })
    mocks.archive.mockResolvedValue('/cache/node.tar.gz')

    expect(await prepare('linux-x64', vi.fn())).toEqual({
      executable: '/home/ada/.orca-remote/runtimes/node-x/bin/node'
    })
    expect(mocks.archive).toHaveBeenCalledWith('linux-x64-glibc', '/cache', expect.any(Object))
    expect(mocks.executable).not.toHaveBeenCalled()
  })

  it('installs the glibc 2.17 compat Node for the reader on a host below the default floor', async () => {
    mocks.target.mockResolvedValue({ target: 'linux-x64-glibc', glibc: { major: 2, minor: 17 } })
    mocks.ensure.mockImplementation(async (options) => {
      expect(options).toMatchObject({ target: 'linux-x64-glibc217' })
      await options.archivePath()
      return { executable: '/home/ada/.orca-remote/runtimes/node-c/bin/node', transfer: 'uploaded' }
    })
    mocks.archive.mockResolvedValue('/cache/node-217.tar.gz')

    await prepare('linux-x64', vi.fn())
    expect(mocks.archive).toHaveBeenCalledWith('linux-x64-glibc217', '/cache', expect.any(Object))
  })

  it('uploads nothing when no Orca-managed Node runs on the host glibc', async () => {
    mocks.target.mockResolvedValue({ target: 'linux-arm64-glibc', glibc: { major: 2, minor: 17 } })

    await expect(prepare('linux-x64', vi.fn())).rejects.toThrow(
      "No Orca-managed Node runs on this host's glibc 2.17"
    )
    expect(mocks.ensure).not.toHaveBeenCalled()
    expect(mocks.archive).not.toHaveBeenCalled()
  })

  it('hands Windows hosts a verified node.exe under the same store layout', async () => {
    mocks.target.mockResolvedValue({ target: 'win32-x64', glibc: null })
    mocks.executable.mockResolvedValue('/cache/node/sha/node.exe')
    const expected = NODE_RUNTIME_ASSETS['win32-x64'].executableSha256
    const exec = vi.fn(async () => frame('missing'))

    const result = await prepare('win32-x64', exec)

    const executable = `C:/Users/ada/.orca-remote/runtimes/node-${expected}/node.exe`
    expect(result).toEqual({
      executable,
      upload: { localRuntime: '/cache/node/sha/node.exe', expectedHash: expected }
    })
    expect(mocks.probe).toHaveBeenCalledWith(
      expect.objectContaining({ executable, expectedHash: expected })
    )
    expect(mocks.ensure).not.toHaveBeenCalled()
    expect(mocks.archive).not.toHaveBeenCalled()
  })

  it('reuses a Windows runtime the host already verified', async () => {
    mocks.target.mockResolvedValue({ target: 'win32-x64', glibc: null })
    const cached = 'C:/Users/ada/.orca-remote/runtimes/node-x/repair-1/node.exe'
    expect(await prepare('win32-x64', async () => frame('ready', cached))).toEqual({
      executable: cached
    })
    expect(mocks.executable).not.toHaveBeenCalled()
  })
})
