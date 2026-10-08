import { readFileSync } from 'node:fs'
import { join } from 'node:path'

declare const __ORCA_CLI_BUILD_VERSION__: string | undefined

// Node-mode CLI code cannot read the package metadata inside app.asar.
export function readOrcaCliVersion(runtimeDir = __dirname): string | null {
  if (typeof __ORCA_CLI_BUILD_VERSION__ === 'string' && __ORCA_CLI_BUILD_VERSION__.length > 0) {
    return __ORCA_CLI_BUILD_VERSION__
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(runtimeDir, '..', 'package.json'), 'utf8'))
    return typeof parsed === 'object' &&
      parsed !== null &&
      'version' in parsed &&
      typeof parsed.version === 'string' &&
      parsed.version.length > 0
      ? parsed.version
      : null
  } catch {
    return null
  }
}
