import { CodexExecutableCapability } from '../../shared/codex-executable-capability'
import { parseWslUncPath, toWindowsWslUncPath } from '../../shared/wsl-paths'
import { buildWslExecArgs } from '../../shared/wsl-login-shell-command'
import { runProcess } from '../../shared/child-process/run-process'
import { resolveWslExecutablePath } from '../wsl/wsl-executable-path'

const capability = new CodexExecutableCapability(async (path) => {
  const target = parseWslUncPath(path)
  if (!target) {
    return ''
  }
  const result = await runProcess({
    program: resolveWslExecutablePath(),
    args: buildWslExecArgs(target.distro, [target.linuxPath, '--version']),
    timeoutMs: 1_000,
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
