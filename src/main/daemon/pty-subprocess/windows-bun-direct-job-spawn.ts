import { getCmdExePath } from '../../../shared/windows-batch-spawn'
import type { BunRuntime } from './bun-pty-process-contract'

const PATCHED_REJECTION = 'windowsJob must be a positive integer handle'
const probed = new WeakMap<BunRuntime, boolean>()

/**
 * Orca's patched Bun creates a terminal child inside a caller job, so no resident gate is needed.
 * It validates `windowsJob` before creating anything; a stock runtime ignores the option and spawns.
 */
export function supportsWindowsDirectJobSpawn(runtime: BunRuntime): boolean {
  const known = probed.get(runtime)
  if (known !== undefined) {
    return known
  }
  let supported = false
  try {
    const stock = runtime.spawn([getCmdExePath(), '/d', '/c', 'exit 0'], {
      cwd: process.cwd(),
      env: {},
      windowsJob: -1,
      terminal: { cols: 1, rows: 1, name: 'xterm-256color', data() {} }
    })
    try {
      stock.kill()
    } finally {
      if (!stock.terminal.closed) {
        stock.terminal.close()
      }
    }
  } catch (error) {
    supported = error instanceof Error && error.message.includes(PATCHED_REJECTION)
  }
  probed.set(runtime, supported)
  return supported
}
