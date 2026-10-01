import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { runProcess } from '../../shared/child-process/run-process'
import {
  CODEX_DISABLE_SHARED_SERVER_ARGS,
  CODEX_SHARED_SERVER_FEATURE_KEY,
  CODEX_STOP_SHARED_SERVER_ARGS
} from '../../shared/codex-shared-server-command'
import { forgetCodexSharedServerProbe, isCodexSharedServerLive } from './codex-shared-server-probe'

const COMMAND_TIMEOUT_MS = 15_000
// Why longer: Codex lets running turns drain for up to 60 s by default, then forces after 10 s.
const STOP_TIMEOUT_MS = 75_000
const MAX_OUTPUT_BYTES = 64 * 1024

/**
 * The Codex CLI the shared server itself runs from, mirroring Codex's
 * `managed_codex_bin`: a complete CLI package of the server's own version,
 * so its lifecycle commands understand that server's layout.
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

async function runCodex(
  codexHome: string,
  args: readonly string[],
  timeoutMs: number
): Promise<{ code: number | null; stdout: string; timedOut: boolean } | null> {
  const program = await resolveCodexSharedServerBinary(codexHome)
  if (!program) {
    return null
  }
  try {
    return await runProcess({
      program,
      args,
      cwd: codexHome,
      env: { ...process.env, CODEX_HOME: codexHome },
      timeoutMs,
      maxOutputBytes: MAX_OUTPUT_BYTES
    })
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

/** Turns off server sharing for this home; true only once Codex reads it back as off. */
export async function disableCodexSharedServerAutoStart(codexHome: string): Promise<boolean> {
  if (!(await runCodex(codexHome, CODEX_DISABLE_SHARED_SERVER_ARGS, COMMAND_TIMEOUT_MS))) {
    return false
  }
  // Why read back: managed config can pin the feature on even when the write exits 0.
  const list = await runCodex(codexHome, ['features', 'list'], COMMAND_TIMEOUT_MS)
  return (
    list !== null &&
    list.code === 0 &&
    !list.timedOut &&
    readFeatureEnabled(list.stdout, CODEX_SHARED_SERVER_FEATURE_KEY) === false
  )
}

/** Stops this home's shared server; true only once it no longer accepts clients. */
export async function stopCodexSharedServer(codexHome: string): Promise<boolean> {
  if (!(await runCodex(codexHome, CODEX_STOP_SHARED_SERVER_ARGS, STOP_TIMEOUT_MS))) {
    return false
  }
  forgetCodexSharedServerProbe(codexHome)
  return !(await isCodexSharedServerLive(codexHome))
}
