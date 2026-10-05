import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'

export function isMissingCatalogExecutable(error: unknown, command: string): boolean {
  if (
    typeof error !== 'object' ||
    error === null ||
    !('code' in error) ||
    error.code !== 'ENOENT'
  ) {
    return false
  }
  if ('path' in error && error.path !== command) {
    return false
  }
  // An existing executable can fail because its interpreter is missing.
  return !isAbsolute(command) || !existsSync(command)
}
