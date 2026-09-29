import { extname, posix, win32 } from 'node:path'
import { CodexExecutableCapability } from '../../shared/codex-executable-capability'
import { runProcess } from '../../shared/child-process/run-process'
import { resolveWindowsPowerShellExecutablePath } from '../providers/windows-powershell-executable'

export type CodexTerminalVersionProbeOptions = {
  /** The path the shell runs; its directory holds a launcher's sibling runtime. */
  invokedPath?: string
  /** Base environment; the relay passes its login-shell-equivalent PATH. */
  env?: NodeJS.ProcessEnv
  platform?: NodeJS.Platform
}

export async function probeCodexTerminalVersion(
  executable: string,
  options: CodexTerminalVersionProbeOptions = {}
): Promise<string> {
  const platform = options.platform ?? process.platform
  const script = platform === 'win32' && extname(executable).toLowerCase() === '.ps1'
  const program = script ? resolveWindowsPowerShellExecutablePath('powershell.exe') : executable
  if (!program) {
    return ''
  }
  const env = options.env ?? process.env
  const pathOps = platform === 'win32' ? win32 : posix
  const pathKey = platform === 'win32' && env.Path !== undefined ? 'Path' : 'PATH'
  const launcherDir = pathOps.dirname(options.invokedPath ?? executable)
  const inheritedPath = env[pathKey]
  const result = await runProcess({
    program,
    args: script
      ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', executable, '--version']
      : ['--version'],
    // Why: npm/nvm launchers use `#!/usr/bin/env node`, and that node sits beside
    // the launcher the shell resolved, not beside the script it links to.
    env: {
      ...env,
      [pathKey]: inheritedPath ? `${launcherDir}${pathOps.delimiter}${inheritedPath}` : launcherDir
    },
    // Why longer than the CLI's 2 s wait: a slow cold start still caches its
    // verdict for the next launch instead of being killed into a negative.
    timeoutMs: 5_000,
    maxOutputBytes: 4_096
  })
  return result.code === 0 && !result.timedOut ? result.stdout.trim() : ''
}

export const codexExecutableCapability = new CodexExecutableCapability((executable, invokedPath) =>
  probeCodexTerminalVersion(executable, { invokedPath })
)
