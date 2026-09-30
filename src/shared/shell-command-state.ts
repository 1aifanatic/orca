/**
 * A terminal session's shell-integration state, from the last OSC 133 marker its execution host
 * scanned: `running` after a command start (C), `at-prompt` after a finish (D) or prompt (A), and
 * `unmarked` while the shell has printed none, so no command finish can be expected from it.
 */
export type ShellCommandState = 'running' | 'at-prompt' | 'unmarked'

export function parseShellCommandState(value: unknown): ShellCommandState | undefined {
  return value === 'running' || value === 'at-prompt' || value === 'unmarked' ? value : undefined
}
