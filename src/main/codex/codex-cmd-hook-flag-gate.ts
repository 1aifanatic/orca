import { getSharedManagedScriptPath, writeManagedScript } from '../agent-hooks/installer-utils'
import {
  ORCA_CODEX_HOOK_CONFIG_ENV,
  ORCA_CODEX_HOOK_FILE_ENTRY_MARKER,
  ORCA_CODEX_HOOK_VERSION_ENV
} from '../../shared/codex-shell-function'

/**
 * cmd.exe defines no codex function, so a cmd pane carries Orca's status hook
 * flag through a doskey macro. doskey rewrites only typed lines, in the
 * console, so it adds no process and no file on PATH. The macro first `call`s
 * this gate, in the same cmd.exe, which sets ORCA_CODEX_HOOK_ARG only when the
 * codex on PATH reports the version the flag was derived for and the Codex home
 * holds no Orca file entry; its next two lines run codex with or without it.
 * The user's own arguments never pass through `call`, which would double their carets.
 */
export const ORCA_CODEX_HOOK_ARG_ENV = 'ORCA_CODEX_HOOK_ARG'
const GATE_SCRIPT_FILE_NAME = 'codex-session-flag-gate.cmd'
const SEEN_VERSION = 'ORCA_CODEX_HOOK_SEEN_VERSION'
const HOME = 'ORCA_CODEX_HOOK_HOME'

export function getCodexCmdHookFlagGatePath(): string {
  return getSharedManagedScriptPath(GATE_SCRIPT_FILE_NAME)
}

// Why `@` on each line rather than `echo off`: a called batch's echo state leaks to the prompt.
export function getCodexCmdHookFlagGateScript(): string {
  return [
    `@set "${ORCA_CODEX_HOOK_ARG_ENV}="`,
    `@if not defined ${ORCA_CODEX_HOOK_CONFIG_ENV} exit /b 0`,
    `@set "${SEEN_VERSION}="`,
    `@for /f "delims=" %%v in ('codex --version 2^>nul') do @if not defined ${SEEN_VERSION} set "${SEEN_VERSION}=%%v"`,
    `@if not "%${SEEN_VERSION}%"=="%${ORCA_CODEX_HOOK_VERSION_ENV}%" goto orca_done`,
    `@set "${HOME}=%CODEX_HOME%"`,
    `@if not defined ${HOME} set "${HOME}=%USERPROFILE%\\.codex"`,
    `@if exist "%${HOME}%\\hooks.json" findstr /l /c:"${ORCA_CODEX_HOOK_FILE_ENTRY_MARKER}" "%${HOME}%\\hooks.json" >nul 2>&1 && goto orca_done`,
    // Why the quotes in the value: the flag holds `<` and `>`, which cmd reads as redirects outside quotes.
    `@set ${ORCA_CODEX_HOOK_ARG_ENV}="%${ORCA_CODEX_HOOK_CONFIG_ENV}%"`,
    ':orca_done',
    `@set "${SEEN_VERSION}="`,
    `@set "${HOME}="`,
    '@exit /b 0',
    ''
  ].join('\r\n')
}

export function ensureCodexCmdHookFlagGate(): void {
  if (process.platform !== 'win32') {
    return
  }
  try {
    writeManagedScript(getCodexCmdHookFlagGatePath(), getCodexCmdHookFlagGateScript())
  } catch (error) {
    // Why: a missing gate only prints cmd's "not recognized", and codex then runs without the flag.
    console.warn('[codex-hook-session] could not write the cmd hook flag gate:', error)
  }
}

/** Holds the gate's path already quoted: node-pty's argv escaping mangles a literal `"` in `/K`. */
export const ORCA_CODEX_HOOK_GATE_ENV = 'ORCA_CODEX_HOOK_GATE'

export function getCodexCmdHookFlagGateEnvValue(): string {
  return `"${getCodexCmdHookFlagGatePath()}"`
}

/**
 * The `/K` startup command that defines the macro, a no-op in a pane without
 * the gate variable. %ORCA_CODEX_HOOK_ARG% stays literal here because that
 * variable is never set at startup; the macro's own line expands it after the gate ran.
 */
export const CODEX_CMD_HOOK_FLAG_MACRO_COMMAND =
  `(if defined ${ORCA_CODEX_HOOK_GATE_ENV} doskey codex=call %${ORCA_CODEX_HOOK_GATE_ENV}% $T ` +
  `if defined ${ORCA_CODEX_HOOK_ARG_ENV} codex -c %${ORCA_CODEX_HOOK_ARG_ENV}% $* $T ` +
  `if not defined ${ORCA_CODEX_HOOK_ARG_ENV} codex $*)`
