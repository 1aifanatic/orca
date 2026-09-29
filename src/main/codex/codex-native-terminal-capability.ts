import { extname } from 'node:path'
import { CodexExecutableCapability } from '../../shared/codex-executable-capability'
import { runProcess } from '../../shared/child-process/run-process'
import { resolveWindowsPowerShellExecutablePath } from '../providers/windows-powershell-executable'

export async function probeCodexTerminalVersion(
  executable: string,
  platform = process.platform
): Promise<string> {
  const script = platform === 'win32' && extname(executable).toLowerCase() === '.ps1'
  const program = script ? resolveWindowsPowerShellExecutablePath('powershell.exe') : executable
  if (!program) {
    return ''
  }
  const result = await runProcess({
    program,
    args: script
      ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', executable, '--version']
      : ['--version'],
    timeoutMs: 1_000,
    maxOutputBytes: 4_096
  })
  return result.code === 0 && !result.timedOut ? result.stdout.trim() : ''
}

export const codexExecutableCapability = new CodexExecutableCapability(probeCodexTerminalVersion)
