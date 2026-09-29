import { posix } from 'node:path'
import { CodexExecutableCapability } from '../../shared/codex-executable-capability'
import { parseWslUncPath, toWindowsWslUncPath } from '../../shared/wsl-paths'
import { buildWslExecArgs } from '../../shared/wsl-login-shell-command'
import { runProcess } from '../../shared/child-process/run-process'
import { resolveWslExecutablePath } from '../wsl/wsl-executable-path'

// Why: --exec skips the guest's startup files, so an nvm/npm launcher's
// `#!/usr/bin/env node` only finds the node that sits beside that launcher.
const GUEST_SYSTEM_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'

const capability = new CodexExecutableCapability(async (path, invokedPath) => {
  const target = parseWslUncPath(path)
  if (!target) {
    return ''
  }
  const launcherDir = posix.dirname((parseWslUncPath(invokedPath) ?? target).linuxPath)
  const result = await runProcess({
    program: resolveWslExecutablePath(),
    args: buildWslExecArgs(target.distro, [
      '/usr/bin/env',
      `PATH=${launcherDir}:${GUEST_SYSTEM_PATH}`,
      target.linuxPath,
      '--version'
    ]),
    timeoutMs: 5_000,
    maxOutputBytes: 4_096
  })
  return result.code === 0 && !result.timedOut ? result.stdout.trim() : ''
})

export async function supportsWslCodexNoDaemon(path: string, distro: string): Promise<boolean> {
  if (
    process.platform !== 'win32' ||
    !path.startsWith('/') ||
    /[\0\r\n\\]/.test(path) ||
    !/^[^\\/\0\r\n]+$/.test(distro)
  ) {
    return false
  }
  return capability.supportsNoDaemon(toWindowsWslUncPath(path, distro))
}
