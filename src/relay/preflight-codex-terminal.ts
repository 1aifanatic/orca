import { isAbsolute } from 'node:path'
import { codexExecutableCapability } from '../main/codex/codex-native-terminal-capability'
import { supportsWslCodexNoDaemon } from '../main/codex/codex-wsl-terminal-capability'
import type { RelayDispatcher } from './dispatcher'

export function registerCodexTerminalCapability(dispatcher: RelayDispatcher): void {
  dispatcher.onRequest('preflight.codexTerminalLaunchCapability', async (params) => {
    if (typeof params.executablePath !== 'string' || !isAbsolute(params.executablePath)) {
      return { supported: false }
    }
    return {
      supported:
        typeof params.wslDistro === 'string' && params.wslDistro
          ? await supportsWslCodexNoDaemon(params.executablePath, params.wslDistro)
          : await codexExecutableCapability.supportsNoDaemon(params.executablePath)
    }
  })
}

export function warmCodexTerminalCapability(
  commands: readonly { id: string; cmd: string }[],
  results: readonly { cmd: string; executablePath: string | null }[]
): void {
  for (const command of commands.filter((command) => command.id === 'codex')) {
    const executablePath = results.find((result) => result.cmd === command.cmd)?.executablePath
    if (executablePath) {
      void codexExecutableCapability.supportsNoDaemon(executablePath)
    }
  }
}
