import { getSharedManagedScriptPath, writeManagedScript } from '../agent-hooks/installer-utils'
import {
  CODEX_HOOK_FLAG_ENTRY_SUFFIX,
  CODEX_HOOK_FLAG_REQUEST_SUFFIX,
  ORCA_CODEX_HOOK_FILE_ENTRY_NEEDLES,
  ORCA_CODEX_HOOK_FLAGS_ENV
} from '../../shared/codex-shell-function'

/**
 * cmd.exe defines no codex function, so a cmd pane carries Orca's status hook
 * flag through a doskey macro. doskey rewrites only typed lines, in the
 * console, so it adds no process and no file on PATH. The macro first `call`s
 * this gate, in the same cmd.exe, which sets ORCA_CODEX_HOOK_ARG from the flag
 * table's entry for the version the codex on PATH reports, unless the Codex
 * home holds an Orca file entry; its next two lines run codex with or without it.
 * The user's own arguments never pass through `call`, which would double their
 * carets, so a user `-c hooks...` in cmd is not detected here.
 */
export const ORCA_CODEX_HOOK_ARG_ENV = 'ORCA_CODEX_HOOK_ARG'
const GATE_SCRIPT_FILE_NAME = 'codex-session-flag-gate.cmd'
const ENTRY = 'ORCA_CODEX_HOOK_ENTRY'
const LAST_LINE = 'ORCA_CODEX_HOOK_LAST'
const HOME = 'ORCA_CODEX_HOOK_HOME'

export function getCodexCmdHookFlagGatePath(): string {
  return getSharedManagedScriptPath(GATE_SCRIPT_FILE_NAME)
}

// Why findstr doubles each backslash: it reads `\\` as one literal backslash even under /l.
// Why /i: several case-sensitive literals of different lengths can miss a match (a FINDSTR bug).
const FINDSTR_NEEDLES = ORCA_CODEX_HOOK_FILE_ENTRY_NEEDLES.map(
  (needle) => `/c:"${needle.replaceAll('\\', '\\\\')}"`
).join(' ')

// Why `@` on each line rather than `echo off`: a called batch's echo state leaks to the prompt.
// Why every version line is tried: `for /f` runs its command through a cmd that runs the
// user's AutoRun, whose output can precede Codex's own line; `%%~nxv` equal to the line
// proves it names no other directory. The last line names the request on a miss.
export function getCodexCmdHookFlagGateScript(): string {
  const table = `%${ORCA_CODEX_HOOK_FLAGS_ENV}%`
  return [
    `@set "${ORCA_CODEX_HOOK_ARG_ENV}="`,
    `@if not defined ${ORCA_CODEX_HOOK_FLAGS_ENV} exit /b 0`,
    // Why: the table exists only while Codex hooks are on; without it codex runs plain, unprobed.
    `@if not exist "%${ORCA_CODEX_HOOK_FLAGS_ENV}%\\" exit /b 0`,
    `@set "${ENTRY}="`,
    `@set "${LAST_LINE}="`,
    `@for /f "delims=" %%v in ('codex --version 2^>nul') do @if "%%v"=="%%~nxv" (set "${LAST_LINE}=%%v" & if not defined ${ENTRY} if exist "${table}\\%%v${CODEX_HOOK_FLAG_ENTRY_SUFFIX}" set "${ENTRY}=${table}\\%%v")`,
    `@if not defined ${ENTRY} goto orca_request`,
    `@set "${HOME}=%CODEX_HOME%"`,
    `@if not defined ${HOME} set "${HOME}=%USERPROFILE%\\.codex"`,
    `@if exist "%${HOME}%\\hooks.json" findstr /l /i ${FINDSTR_NEEDLES} "%${HOME}%\\hooks.json" >nul 2>&1 && goto orca_done`,
    // Why the quotes in the value: the flag holds `<` and `>`, which cmd reads as redirects outside quotes.
    // Why `for /f` over the file, not `set /p`: set /p stops at 1023 characters and the flag is longer.
    `@for /f "usebackq delims=" %%L in ("%${ENTRY}%${CODEX_HOOK_FLAG_ENTRY_SUFFIX}") do @if not defined ${ORCA_CODEX_HOOK_ARG_ENV} set ${ORCA_CODEX_HOOK_ARG_ENV}="%%L"`,
    '@goto orca_done',
    ':orca_request',
    // Why: Orca derives an entry for its own codex, so a later launch carries it.
    `@if defined ${LAST_LINE} (type nul>"${table}\\%${LAST_LINE}%${CODEX_HOOK_FLAG_REQUEST_SUFFIX}") 2>nul`,
    ':orca_done',
    `@set "${ENTRY}="`,
    `@set "${LAST_LINE}="`,
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
