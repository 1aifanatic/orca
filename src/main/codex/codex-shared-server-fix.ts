import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { runProcess } from '../../shared/child-process/run-process'
import {
  CODEX_DISABLE_SHARED_SERVER_ARGS,
  CODEX_SHARED_SERVER_FEATURE_KEY,
  CODEX_STOP_SHARED_SERVER_ARGS
} from '../../shared/codex-shared-server-command'
import { probeCodexSharedServer } from './codex-shared-server-probe'

const COMMAND_TIMEOUT_MS = 15_000
// Why longer: Codex lets running turns drain for up to 60 s by default, then forces after 10 s.
const STOP_TIMEOUT_MS = 75_000
const MAX_OUTPUT_BYTES = 64 * 1024

/**
 * The Codex CLI Codex installed under this home's `packages/` (the server's
 * package, else the legacy standalone one), so its lifecycle commands match
 * the server's version rather than whatever `codex` is on PATH.
 */
export async function resolveCodexSharedServerBinary(codexHome: string): Promise<string | null> {
  const fileName = process.platform === 'win32' ? 'codex.exe' : 'codex'
  for (const packageName of ['app-server-daemon', 'standalone']) {
    const current = join(codexHome, 'packages', packageName, 'current')
    for (const candidate of [join(current, 'bin', fileName), join(current, fileName)]) {
      try {
        if ((await stat(candidate)).isFile()) {
          return candidate
        }
      } catch {
        // Not installed in this layout.
      }
    }
  }
  return null
}

/** The command's stdout when it exited 0 in time; otherwise null. */
async function runCodex(
  codexHome: string,
  args: readonly string[],
  timeoutMs: number,
  binaryHome = codexHome
): Promise<string | null> {
  const program = await resolveCodexSharedServerBinary(binaryHome)
  if (!program) {
    return null
  }
  try {
    const result = await runProcess({
      program,
      args,
      // Why: binaryHome holds the program, so it exists even when codexHome may not.
      cwd: binaryHome,
      env: { ...process.env, CODEX_HOME: codexHome },
      timeoutMs,
      maxOutputBytes: MAX_OUTPUT_BYTES
    })
    return result.code === 0 && !result.timedOut ? result.stdout : null
  } catch {
    return null
  }
}

/** Codex's `features list` row for `key`: `name  stage  true|false`. */
export function readFeatureEnabled(stdout: string, key: string): boolean | null {
  for (const line of stdout.split(/\r?\n/)) {
    const columns = line.trim().split(/\s+/)
    if (columns[0] === key) {
      const enabled = columns.at(-1)
      return enabled === 'true' ? true : enabled === 'false' ? false : null
    }
  }
  return null
}

/** Turns sharing off in `codexHome`, using the server's Codex from `binaryHome`; true once read back as off. */
async function disableAutoStartIn(codexHome: string, binaryHome: string): Promise<boolean> {
  const run = (args: readonly string[]): Promise<string | null> =>
    runCodex(codexHome, args, COMMAND_TIMEOUT_MS, binaryHome)
  if ((await run(CODEX_DISABLE_SHARED_SERVER_ARGS)) === null) {
    return false
  }
  // Why read back: managed config can pin the feature on even when the write exits 0.
  const list = await run(['features', 'list'])
  return list !== null && readFeatureEnabled(list, CODEX_SHARED_SERVER_FEATURE_KEY) === false
}

/**
 * Turns off server sharing in `settingsHome`, where it persists, and in the
 * pane's home, which a Codex typed in this pane reads before Orca next mirrors
 * `settingsHome` into it. True only once both read it back as off.
 */
export async function disableCodexSharedServerAutoStart(
  paneHome: string,
  settingsHome: string = paneHome
): Promise<boolean> {
  for (const codexHome of new Set([settingsHome, paneHome])) {
    if (!(await disableAutoStartIn(codexHome, paneHome))) {
      return false
    }
  }
  return true
}

/** Stops this home's shared server; true only once it is proven gone. */
export async function stopCodexSharedServer(codexHome: string): Promise<boolean> {
  // Why the probe decides: only it shows whether this home's server is actually gone.
  await runCodex(codexHome, CODEX_STOP_SHARED_SERVER_ARGS, STOP_TIMEOUT_MS)
  return (await probeCodexSharedServer(codexHome)) === 'absent'
}
