import { lstatSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
// Why type-only: scan workers import this module, and the router's setup graph must not load there.
import type { ClaudeProfileRouter } from './claude-profile-router'

/** A real directory; a link is false, so a history folder shared by link is not read twice. */
export function isDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory()
  } catch {
    return false
  }
}

export function listClaudeProfileHomes(dataRoot: string): string[] {
  const root = join(dataRoot, 'claude-profiles')
  let ids: string[]
  try {
    ids = readdirSync(root)
  } catch {
    return []
  }
  return ids.map((id) => join(root, id, 'home')).filter(isDirectory)
}

let installed: ClaudeProfileRouter | undefined

/** Installed by the host runtime only when routing is enabled; workers and child processes have none. */
export function installClaudeProfileRouter(router: ClaudeProfileRouter | undefined): void {
  installed = router
}

export function getClaudeProfileRouter(): ClaudeProfileRouter | undefined {
  return installed
}

/**
 * Account `<surface>` folders the System default readers cannot see. Step 1 links history into the
 * System default on macOS/Linux, so only Windows (or a cross-filesystem refusal) adds any.
 */
export function claudeProfileHistoryDirs(surface: 'projects' | 'transcripts'): string[] {
  return (installed?.accountHomes() ?? []).map((home) => join(home, surface)).filter(isDirectory)
}
