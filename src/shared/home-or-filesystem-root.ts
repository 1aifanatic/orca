import { normalizeRuntimePathForComparison } from './cross-platform-path'

/** Drive, UNC share, WSL distro or POSIX root, as `normalizeRuntimePathForComparison` spells it. */
const FILESYSTEM_ROOT_KEY = /^(?:\/|[a-z]:\/?|\/\/[^/]+(?:\/[^/]+)?)$/i

/**
 * Whether `folderPath` is a home folder or a filesystem root. Pre-trusting one would trust
 * everything under it, because Claude and Copilot let a trusted folder cover its subfolders.
 */
export function isHomeOrFilesystemRoot(
  folderPath: string,
  homePaths: readonly (string | null | undefined)[]
): boolean {
  const key = normalizeRuntimePathForComparison(folderPath)
  return (
    FILESYSTEM_ROOT_KEY.test(key) ||
    homePaths.some((home) => (home ? normalizeRuntimePathForComparison(home) === key : false))
  )
}
