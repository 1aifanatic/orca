import { recognizeAgentProcessFromCommandLine } from './agent-process-recognition'
import {
  findInterpreterEntrypointToken,
  tokenizeCommandLine
} from './agent-command-line-entrypoint'

// Mirrors Codex's own opt-outs (tui/src/daemon_startup.rs `exclusion`). Every
// `-c`/`--enable`/`--disable` counts, although Codex allows a few: skipping one
// only costs a warning, never a false one.
const EMBEDDED_FLAGS: ReadonlySet<string> = new Set([
  '--no-daemon',
  '--oss',
  '--remote',
  '--profile',
  '-p',
  '--strict-config',
  '--dangerously-bypass-hook-trust',
  '--search',
  '--approve-for-me',
  '--not-so-yolo',
  '--enable',
  '--disable',
  '--config',
  '-c'
])

// Every subcommand in codex-rs/cli/src/main.rs except the ones that open the TUI
// on the shared server: `resume`, `fork` and `agents`.
const NON_TUI_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'exec',
  'e',
  'review',
  'login',
  'logout',
  'mcp',
  'plugin',
  'app-server',
  'remote-control',
  'app',
  'completion',
  'update',
  'doctor',
  'sandbox',
  'debug',
  'execpolicy',
  'apply',
  'a',
  'queue',
  'archive',
  'delete',
  'migrate-rollouts',
  'unarchive',
  'cloud',
  'cloud-tasks',
  'responses-api-proxy',
  'stdio-to-uds',
  'exec-server',
  'features',
  'tcp-tunnel',
  'help'
])

function isEmbeddedFlag(token: string): boolean {
  const name = token.split('=', 1)[0] ?? token
  // Why the prefix check: clap also accepts a short flag glued to its value (`-pwork`, `-cx=1`).
  return EMBEDDED_FLAGS.has(name) || /^-[pc][^-]/.test(token)
}

/**
 * True when a process-table command line is an interactive Codex that joins its
 * shared server when one is running. Process tables may join argv with spaces,
 * so any token that could be an opt-out counts as one: a prompt that happens to
 * contain `exec` misses the warning rather than raising a false one.
 */
export function codexCommandLineJoinsSharedServer(commandLine: string): boolean {
  if (
    recognizeAgentProcessFromCommandLine(commandLine, { includeHeadlessOneShot: true })?.agent !==
    'codex'
  ) {
    return false
  }
  const tokens = tokenizeCommandLine(commandLine)
  const entrypoint = findInterpreterEntrypointToken(
    tokens,
    (tokens[0] ?? '')
      .replace(/^.*[\\/]/, '')
      .toLowerCase()
      .replace(/\.exe$/, '')
  )
  const args = tokens.slice(entrypoint === null ? 1 : tokens.indexOf(entrypoint, 1) + 1)
  // Why the plain split too: a lone `'` in a space-joined prompt (`don't`) swallows later tokens.
  const plainArgs = commandLine
    .trim()
    .split(/\s+/)
    .slice(1)
    .map((token) => token.replace(/^["']+|["']+$/g, ''))
  return ![...args, ...plainArgs].some(
    (token) => isEmbeddedFlag(token) || NON_TUI_SUBCOMMANDS.has(token)
  )
}

/** The fix's commands, as argv after the `codex` program; shown verbatim in the UI. */
export const CODEX_DISABLE_SHARED_SERVER_ARGS = [
  'features',
  'disable',
  'daemon_auto_start'
] as const
export const CODEX_STOP_SHARED_SERVER_ARGS = ['app-server', 'daemon', 'stop'] as const
export const CODEX_SHARED_SERVER_FEATURE_KEY = 'daemon_auto_start'
