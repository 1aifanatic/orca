import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { targetIsOwnedFallbackCopy } from '../codex/codex-managed-home-resource-copy-marker'
import { writeFileAtomicallyIfUnchanged } from './fs-utils'

// Why these: the mirror links them to ~/.codex only when ~/.codex already had
// them, so a pane that installed a skill or plugin first wrote a real folder.
const PANE_INSTALLED_FOLDERS = ['skills', 'plugins']

/**
 * Carries home files only the mirror holds: approved-command rules, pane-installed
 * skills and plugins, and prompt history. Never overwrites a file ~/.codex has;
 * false when a rules file changed underneath, so the carry retries.
 */
export function carryMirrorOnlyHomeFiles({
  runtimeHomePath,
  systemHomePath
}: {
  runtimeHomePath: string
  systemHomePath: string
}): boolean {
  for (const folder of PANE_INSTALLED_FOLDERS) {
    const mirrorFolder = join(runtimeHomePath, folder)
    const systemFolder = join(systemHomePath, folder)
    // Why: a link, or Orca's own fallback copy, is ~/.codex's content already.
    if (
      isRealFolder(mirrorFolder) &&
      !targetIsOwnedFallbackCopy(mirrorFolder, runtimeHomePath, folder, systemFolder)
    ) {
      cpSync(mirrorFolder, systemFolder, {
        recursive: true,
        force: false,
        errorOnExist: false,
        filter: (source) => !lstatSync(source).isSymbolicLink()
      })
    }
  }
  copyFileIfAbsent(join(runtimeHomePath, 'history.jsonl'), join(systemHomePath, 'history.jsonl'))
  return carryMirrorRules(join(runtimeHomePath, 'rules'), join(systemHomePath, 'rules'))
}

/** Appends each mirror rule line a matching ~/.codex rules file lacks. */
function carryMirrorRules(mirrorRules: string, systemRules: string): boolean {
  if (!isRealFolder(mirrorRules)) {
    return true
  }
  mkdirSync(systemRules, { recursive: true })
  let landed = true
  for (const file of readdirSync(mirrorRules).filter((name) => name.endsWith('.rules'))) {
    const systemPath = join(systemRules, file)
    const system = existsSync(systemPath) ? readFileSync(systemPath, 'utf-8') : null
    const systemLines = new Set((system ?? '').split(/\r?\n/))
    const missing = readFileSync(join(mirrorRules, file), 'utf-8')
      .split(/\r?\n/)
      .filter((line) => line.trim() !== '' && !systemLines.has(line))
    if (missing.length > 0) {
      const base =
        system === null || system === '' || system.endsWith('\n') ? (system ?? '') : `${system}\n`
      landed =
        writeFileAtomicallyIfUnchanged(systemPath, system, `${base}${missing.join('\n')}\n`) &&
        landed
    }
  }
  return landed
}

/** Copies a file only when ~/.codex has none; whatever ~/.codex has, in any form, is the user's. */
export function copyFileIfAbsent(sourcePath: string, targetPath: string): void {
  if (existsSync(sourcePath) && !existsSync(targetPath)) {
    writeFileAtomicallyIfUnchanged(targetPath, null, readFileSync(sourcePath, 'utf-8'), {
      mode: 0o600
    })
  }
}

function isRealFolder(path: string): boolean {
  try {
    const entry = lstatSync(path)
    return entry.isDirectory() && !entry.isSymbolicLink()
  } catch {
    return false
  }
}
