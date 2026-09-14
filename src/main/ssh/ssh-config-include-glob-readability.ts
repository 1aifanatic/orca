import { globSync, opendirSync } from 'node:fs'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import type { PathApi } from './ssh-config-include-path-resolution'

const GLOB_METACHARACTER = /[*?[]/

export function hasGlobPattern(input: string): boolean {
  return GLOB_METACHARACTER.test(input)
}

/** The deepest literal directory that a glob must be able to read. */
export function getLiteralGlobParent(pattern: string, pathApi: PathApi): string {
  const firstGlob = pattern.search(GLOB_METACHARACTER)
  const literal = firstGlob === -1 ? pattern : pattern.slice(0, firstGlob)
  // Appending a filename keeps a prefix ending in a separator from stepping up a directory.
  return pathApi.dirname(`${literal}x`)
}

/**
 * The directory whose unreadability makes a `globSync` result untrustworthy, or `null` when every
 * directory the expansion had to walk opened.
 *
 * `globSync` reports what it could see and never reports what it could not: an unreadable directory
 * yields fewer matches, not an error. Walk each globbed directory level so partial matches are not
 * mistaken for a complete result.
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

/** Missing directories and paths below regular files are definitive empty matches. */
function findUnopenableDirectory(directory: string): string | null {
  try {
    // A directory without read permission can still be statted.
    opendirSync(directory).closeSync()
    return null
  } catch (error) {
    return isDefinitiveAbsence(error) ? null : directory
  }
}

/** Glob patterns for each directory level before the final match segment. */
function getGlobDirectoryPrefixes(pattern: string, pathApi: PathApi): string[] {
  const firstGlob = pattern.search(GLOB_METACHARACTER)
  if (firstGlob === -1) {
    return []
  }
  // Windows accepts both separators, and ssh_config is routinely written with forward slashes.
  const isSeparator = (char: string | undefined): boolean =>
    char === '/' || (pathApi.sep === '\\' && char === '\\')
  const prefixes: string[] = []
  for (let index = firstGlob + 1; index < pattern.length; index += 1) {
    if (isSeparator(pattern[index])) {
      prefixes.push(pattern.slice(0, index))
    }
  }
  return prefixes
}
