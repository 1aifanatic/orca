import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ORCA_CODEX_HOOK_FILE_ENTRY_MARKER } from '../../shared/codex-shell-function'
import { getSystemCodexHomePath } from './codex-home-paths'

/**
 * Whether a Codex home still holds an Orca hook entry in its hooks.json, which
 * only an older Orca writes now. A launch into such a home carries no hook flag:
 * that entry already posts status, and it is the older build's to approve.
 * Read-only, and the same text match the shell codex functions make.
 */
export function codexHomeHoldsOrcaFileEntry(codexHomePath: string | null | undefined): boolean {
  try {
    const raw = readFileSync(join(codexHomePath || getSystemCodexHomePath(), 'hooks.json'), 'utf-8')
    return raw.includes(ORCA_CODEX_HOOK_FILE_ENTRY_MARKER)
  } catch {
    return false
  }
}
