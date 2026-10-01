import { realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { getClaudeProfileRoutingAuthority } from './claude-profile-routing-authority'

/** Shared links scan once; a private tree is visible without granting an arbitrary linked root. */
export function claudeProfileReaderRoots(
  legacy: string[],
  surface: 'projects' | 'transcripts'
): string[] {
  const authority = getClaudeProfileRoutingAuthority()
  if (!authority) {
    return legacy
  }
  const candidates = authority.historyRoots().map((home) => join(home, surface))
  const allowed = new Set(
    candidates.map((path) => {
      try {
        return join(realpathSync.native(dirname(path)), basename(path))
      } catch {
        return resolve(path)
      }
    })
  )
  const seen = new Set<string>()
  return [...legacy, ...candidates].filter((path) => {
    let canonical: string
    try {
      canonical = realpathSync.native(path)
    } catch {
      canonical = resolve(path)
    }
    if (!legacy.includes(path) && !allowed.has(canonical)) {
      return false
    }
    if (seen.has(canonical)) {
      return false
    }
    seen.add(canonical)
    return true
  })
}
