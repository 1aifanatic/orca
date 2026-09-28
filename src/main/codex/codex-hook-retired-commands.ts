import { posix, win32 } from 'node:path'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'
import { getManagedScriptPath } from './codex-hook-definition'

// Why enumerated: every Orca build and instance writes the same current command,
// so "any Orca-looking entry that is not mine" would strip a newer or older
// build's live entry. Only forms no build writes any more may be swept.
// #1019: `/bin/sh "<userData>/agent-hooks/codex-hook.sh"`.
const DOUBLE_QUOTED_SH = /^\/bin\/sh "([^"]+)"$/
// #1536 until hooks left ~/.codex (#2350): `if [ -x '<p>' ]; then /bin/sh '<p>'; fi`.
const EXEC_GUARDED_SH = /^if \[ -x ('(?:[^']|'\\'')*') \]; then \/bin\/sh \1; fi$/

function isAgentHooksScript(scriptPath: string, fileName: string): boolean {
  const pathApi = scriptPath.includes('\\') ? win32 : posix
  return (
    pathApi.basename(scriptPath).toLowerCase() === fileName &&
    pathApi.basename(pathApi.dirname(scriptPath)) === 'agent-hooks'
  )
}

function unquotePosix(quoted: string): string {
  return quoted.slice(1, -1).replaceAll("'\\''", "'")
}

/** True only for a Codex hook command a retired Orca build wrote into ~/.codex. */
export function isRetiredCodexHookCommand(command: string | undefined): boolean {
  if (!command) {
    return false
  }
  const doubleQuoted = DOUBLE_QUOTED_SH.exec(command)
  if (doubleQuoted) {
    return isAgentHooksScript(doubleQuoted[1]!, 'codex-hook.sh')
  }
  const execGuarded = EXEC_GUARDED_SH.exec(command)
  if (execGuarded) {
    return isAgentHooksScript(unquotePosix(execGuarded[1]!), 'codex-hook.sh')
  }
  // Why: before #1546 Windows wrote a bare per-userData script path; the bare
  // shared path is still today's form for cmd-safe paths, so it never matches.
  return (
    win32.isAbsolute(command) &&
    isAgentHooksScript(command, 'codex-hook.cmd') &&
    normalizeRuntimePathForComparison(command) !==
      normalizeRuntimePathForComparison(getManagedScriptPath())
  )
}
