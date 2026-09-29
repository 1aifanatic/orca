// Codex rust-v0.156.0-alpha.1 (the first 0.156 build) added --no-daemon; 0.155.x has none.
export const CODEX_NO_DAEMON_FIRST_VERSION = '0.156.0'

export function codexSupportsNoDaemon(output: string): boolean {
  const match = /^codex-cli (\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.]+)?\s*$/.exec(output.trim())
  if (!match) {
    return false
  }
  const [, major, minor] = match
  const [firstMajor, firstMinor] = CODEX_NO_DAEMON_FIRST_VERSION.split('.').map(Number)
  return (
    Number.isSafeInteger(Number(major)) &&
    Number.isSafeInteger(Number(minor)) &&
    (Number(major) > firstMajor || (Number(major) === firstMajor && Number(minor) >= firstMinor))
  )
}

// Why scanned through every argument: resume/fork and a trailing flag after the
// prompt still reach Codex, which refuses --no-daemon beside --remote.
export const CODEX_NO_DAEMON_CONFLICTING_OPTIONS = ['--no-daemon', '--remote'] as const

export const CODEX_TERMINAL_VALUE_OPTIONS = [
  '-c',
  '--config',
  '-m',
  '--model',
  '-p',
  '--profile',
  '-s',
  '--sandbox',
  '-a',
  '--ask-for-approval',
  '-C',
  '--cd',
  '--add-dir',
  '-i',
  '--image',
  '--enable',
  '--disable'
] as const
export const CODEX_TERMINAL_SWITCH_OPTIONS = [
  '--search',
  '--full-auto',
  '--dangerously-bypass-approvals-and-sandbox',
  '--yolo',
  '--no-alt-screen',
  '--oss'
] as const
export const CODEX_NONINTERACTIVE_COMMANDS = [
  'exec',
  'e',
  'review',
  'login',
  'logout',
  'mcp',
  'mcp-server',
  'app-server',
  'completion',
  'sandbox',
  'debug',
  'apply',
  'a',
  'cloud',
  'features',
  'help',
  'agents',
  'tcp-tunnel',
  'plugin',
  'remote-control',
  'app',
  'update',
  'doctor',
  'execpolicy',
  'queue',
  'archive',
  'delete',
  'migrate-rollouts',
  'unarchive',
  'cloud-tasks',
  'responses-api-proxy',
  'stdio-to-uds',
  'exec-server'
] as const
