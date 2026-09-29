import { realpathSync } from 'node:fs'
import { isTooBroadToPreTrust } from '../shared/home-or-filesystem-root'

function withResolvedForm(path: string): string[] {
  try {
    return [path, realpathSync.native(path)]
  } catch {
    return [path]
  }
}

/**
 * `isTooBroadToPreTrust` for a folder on this host, compared in both given and resolved forms:
 * the trust writers store the realpath, so a symlink to a home (or a symlinked home) is a home.
 */
export function isLocalFolderTooBroadToPreTrust(
  folderPath: string,
  homePaths: readonly (string | null | undefined)[]
): boolean {
  const homes = homePaths.flatMap((home) => (home ? withResolvedForm(home) : []))
  return withResolvedForm(folderPath).some((form) => isTooBroadToPreTrust(form, homes))
}
