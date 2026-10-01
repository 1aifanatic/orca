import { randomBytes } from 'node:crypto'
import { basename } from 'node:path'
import { materializeNodeRuntimeArchive } from '../ssh/pinned-runtime-materializer'
import { parseOrcadLinuxLibc } from '../ssh/orcad-deployment-target'
import {
  installNodeRuntimeFromHostArchiveCommand,
  nodeRuntimeStoreDir,
  posixNodeRuntimeExecutable,
  probeRemoteNodeRuntimeCommand,
  REMOTE_NODE_RUNTIME_READY
} from '../ssh/orcad-remote-node-runtime'
import { getRemoteHostPlatform } from '../ssh/ssh-remote-platform'
import type { WslSpec } from './wsl-runner'

const downloads = new Map<string, Promise<string>>()
export type WslRuntimeCommand = (spec: WslSpec, timeoutMs?: number) => Promise<string>

/** Shared pinned archive and guest store; never substitutes a user-installed runtime. */
export async function ensureWslPinnedRuntime(
  run: WslRuntimeCommand,
  cacheRoot: string,
  signal: AbortSignal
): Promise<{ executable: string; home: string }> {
  const arch = await run({ program: 'uname', args: ['-m'], loginPath: 'none' })
  if (arch !== 'x86_64' && arch !== 'aarch64' && arch !== 'arm64') {
    throw new Error(`Unsupported WSL runtime architecture: ${arch}`)
  }
  const libc = parseOrcadLinuxLibc(
    await run({
      script:
        'getconf GNU_LIBC_VERSION 2>/dev/null || ldd --version 2>&1 || ' +
        'for loader in /lib/ld-musl-*.so.1; do [ ! -e "$loader" ] || { echo musl; break; }; done',
      loginPath: 'none'
    })
  )
  const target = `linux-${arch === 'x86_64' ? 'x64' : 'arm64'}-${libc}` as const
  const home = await run({ script: 'printf %s "$HOME"', loginPath: 'none' })
  if (!home.startsWith('/') || /[\r\n\0]/.test(home)) {
    throw new Error('WSL did not provide an absolute home directory.')
  }
  const host = getRemoteHostPlatform(arch === 'x86_64' ? 'linux-x64' : 'linux-arm64')
  const runtimeDir = nodeRuntimeStoreDir(host, `${home}/.cache/orca`, target)
  const executable = posixNodeRuntimeExecutable(host, runtimeDir)
  const probe = await run({
    script: probeRemoteNodeRuntimeCommand(host, runtimeDir, target),
    loginPath: 'none'
  })
  if (probe !== REMOTE_NODE_RUNTIME_READY) {
    let download = downloads.get(`${cacheRoot}:${target}`)
    if (!download) {
      download = materializeNodeRuntimeArchive(target, cacheRoot, { signal }).finally(() =>
        downloads.delete(`${cacheRoot}:${target}`)
      )
      downloads.set(`${cacheRoot}:${target}`, download)
    }
    const localArchive = await download
    const source = await run({
      program: 'wslpath',
      args: ['-a', '-u', localArchive],
      loginPath: 'none'
    })
    const promoted = await run(
      {
        script: installNodeRuntimeFromHostArchiveCommand(host, {
          runtimeDir,
          archive: basename(localArchive),
          target,
          token: randomBytes(8).toString('hex')
        }),
        args: [source],
        loginPath: 'none'
      },
      120_000
    )
    if (promoted.split('\n').at(-1) !== REMOTE_NODE_RUNTIME_READY) {
      throw new Error('WSL did not verify the pinned Node runtime.')
    }
  }
  return { executable, home }
}
