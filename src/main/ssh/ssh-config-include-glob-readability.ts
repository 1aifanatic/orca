import { globSync, opendirSync } from 'node:fs'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import {
  GLOB_METACHARACTER,
  getLiteralGlobParent,
  type PathApi
} from './ssh-config-include-path-resolution'

/**
 * The directory whose unreadability makes a `globSync` result untrustworthy, or `null` when every
 * directory the expansion had to walk opened.
 *
 * `globSync` reports what it could see and never reports what it could not: an unreadable directory
 * yields fewer matches, not an error. So neither an empty result nor a partial one proves absence on
 * its own. An `Include` that globs a directory level rather than only a filename -- one subdirectory
 * of `~/.ssh` at mode 000, the rest readable -- silently drops that host's whole `Host` block, and
 * `sshConfigMayClaimAlias` then answers a confident `false` for an alias the config does claim.
 *
 * Walks one level per glob segment, so an unreadable directory under an earlier segment is still
 * reached: each level is globbed from a prefix whose own parents already opened. The traversal
 * mirrors the one `globSync` just did, so it costs no more than the call it is checking.
 */
export function findUnreadableGlobDirectory(pattern: string, pathApi: PathApi): string | null {
  const unopenableParent = findUnopenableDirectory(getLiteralGlobParent(pattern, pathApi))
  if (unopenableParent) {
    return unopenableParent
  }
  for (const prefix of getGlobDirectoryPrefixes(pattern, pathApi)) {
    for (const directory of globSync(prefix)) {
      const unopenable = findUnopenableDirectory(directory)
      if (unopenable) {
        return unopenable
      }
    }
  }
  return null
}

/** `null` when the directory opened, or is definitively not there: OpenSSH includes nothing for a
 *  missing directory either, and a regular file caught by an intermediate glob answers ENOTDIR. */
function findUnopenableDirectory(directory: string): string | null {
  try {
    // opendir, not stat: a directory with no `r` bit stats fine and only fails on being read.
    opendirSync(directory).closeSync()
    return null
  } catch (error) {
    return isDefinitiveAbsence(error) ? null : directory
  }
}

/**
 * Each directory level a glob segment produced, as a pattern. A pattern globbing one level of
 * `~/.ssh` and then naming `conf.d` yields that globbed level and `<globbed>/conf.d`. The final
 * segment is excluded: it names the matches themselves, which are read as files rather than walked.
 */
function getGlobDirectoryPrefixes(pattern: string, pathApi: PathApi): string[] {
  const firstGlob = pattern.search(GLOB_METACHARACTER)
  if (firstGlob === -1) {
    return []
  }
  // Windows accepts both separators, and ssh_config is routinely written with forward slashes.
  const isSeparator = (char: string): boolean =>
    char === '/' || (pathApi.sep === '\\' && char === '\\')
  const prefixes: string[] = []
  for (let index = firstGlob + 1; index < pattern.length; index += 1) {
    if (isSeparator(pattern[index] as string)) {
      prefixes.push(pattern.slice(0, index))
    }
  }
  return prefixes
}
