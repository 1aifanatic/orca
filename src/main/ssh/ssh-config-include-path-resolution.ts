import { hostname, userInfo } from 'node:os'
import { posix, win32 } from 'node:path'

export type PathApi = typeof posix | typeof win32

export type IncludePathContext = {
  home: string
  pathApi: PathApi
  rootDir: string
  shortHostname: string
  uid?: string
  username: string
}

const TARGET_DEPENDENT_INCLUDE_TOKENS = new Set(['h', 'n', 'p', 'r', 'j', 'k', 'C'])

/** `null` when a referenced variable is unset: the pattern is unresolvable, not empty. */
export function expandEnvironmentVariables(input: string): string | null {
  let missing = false
  const expanded = input.replaceAll(/\$\{([^}]+)\}/g, (_, name: string) => {
    const value = process.env[name]
    if (value === undefined) {
      missing = true
      return ''
    }
    return value
  })

  return missing ? null : expanded
}

/** `null` for a token only a connection target can supply, which Orca cannot expand offline. */
export function expandIncludeTokens(input: string, context: IncludePathContext): string | null {
  let output = ''

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i]
    if (char !== '%') {
      output += char
      continue
    }

    const token = input[i + 1]
    if (!token) {
      output += char
      continue
    }

    if (token === '%') {
      output += '%'
      i += 1
      continue
    }

    if (TARGET_DEPENDENT_INCLUDE_TOKENS.has(token)) {
      return null
    }

    if (token === 'd') {
      output += context.home
      i += 1
      continue
    }

    if (token === 'u') {
      output += context.username
      i += 1
      continue
    }

    if (token === 'i') {
      if (!context.uid) {
        return null
      }
      output += context.uid
      i += 1
      continue
    }

    if (token === 'l') {
      output += hostname()
      i += 1
      continue
    }

    if (token === 'L') {
      output += context.shortHostname
      i += 1
      continue
    }

    output += `%${token}`
    i += 1
  }

  return output
}

export function resolveIncludePatternPath(input: string, context: IncludePathContext): string {
  const pathApi = context.pathApi
  if (input === '~') {
    return context.home
  }
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return pathApi.join(context.home, input.slice(2))
  }

  if (pathApi.isAbsolute(input)) {
    return pathApi.normalize(input)
  }

  return pathApi.normalize(pathApi.join(context.rootDir, input))
}

/** OpenSSH's `Include` glob syntax. One definition, because two of the three readers below decide
 *  where the literal prefix ENDS and disagreeing about that silently shifts which directory gets
 *  checked for readability. Not `g`-flagged: shared state across `test` and `search` would skip. */
export const GLOB_METACHARACTER = /[*?[]/

export function hasGlobPattern(input: string): boolean {
  return GLOB_METACHARACTER.test(input)
}

/**
 * The deepest literal directory of a glob — the one `globSync` has to be able to read before an
 * empty match set means anything. `config.d/*` and `config.d/5*` both answer `config.d`.
 */
export function getLiteralGlobParent(pattern: string, pathApi: PathApi): string {
  const firstGlob = pattern.search(GLOB_METACHARACTER)
  const literal = firstGlob === -1 ? pattern : pattern.slice(0, firstGlob)
  // The placeholder stands in for the removed pattern segment, so a prefix ending at a separator
  // keeps its own directory instead of dirname stepping one level too far up.
  return pathApi.dirname(`${literal}x`)
}

export function getCurrentUid(): string | undefined {
  try {
    const info = userInfo()
    if (typeof info.uid === 'number' && info.uid >= 0) {
      return String(info.uid)
    }
  } catch {
    return undefined
  }

  if (typeof process.getuid === 'function') {
    try {
      return String(process.getuid())
    } catch {
      return undefined
    }
  }

  return undefined
}

export function getCurrentUser(): string {
  try {
    const info = userInfo()
    if (info.username) {
      return info.username
    }
  } catch {
    // Fall back to environment variables below.
  }

  return process.env.USER ?? process.env.USERNAME ?? ''
}

export function getPathApi(filePath: string): PathApi {
  return /^[a-zA-Z]:[\\/]/.test(filePath) || filePath.startsWith('\\\\') ? win32 : posix
}
