import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CODEX_HOOK_FLAG_ENTRY_SUFFIX,
  CODEX_HOOK_FLAG_NO_DAEMON_SUFFIX,
  CODEX_HOOK_FLAG_REQUEST_SUFFIX
} from '../../shared/codex-shell-function'
import { getOrcaUserDataPath } from './codex-home-paths'

/**
 * Orca's published Codex hook flags, one entry per `codex --version` output.
 * A pane carries only this directory's path, and every launch reads the entry
 * for its own binary's version then, so an entry published after the pane
 * opened, or removed by the opt-out, takes effect at that pane's next launch.
 * Per profile: one profile's opt-out never strips another's panes.
 *
 *   <version>.flag       the `-c` value, one line
 *   <version>.no-daemon  present when that Codex accepts --no-daemon
 *   <version>.request    a launch found no entry; holds its codex path, if known
 */
export type CodexHookFlagEntry = {
  codexVersion: string
  flag: string
  noDaemon: boolean
}

export type CodexHookFlagRequest = {
  codexVersion: string
  /** Absolute path of the requesting launch's codex; null when the carrier could not tell. */
  codexPath: string | null
}

// Why this shape: every carrier, cmd.exe included, names the file after the version it read.
const ENTRY_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,126}[A-Za-z0-9]$/

export function getCodexHookFlagTablePath(): string {
  return join(getOrcaUserDataPath(), 'codex-hook-flags')
}

export function isCodexHookFlagEntryName(codexVersion: string): boolean {
  return ENTRY_NAME.test(codexVersion)
}

export function ensureCodexHookFlagTable(table = getCodexHookFlagTablePath()): void {
  mkdirSync(table, { recursive: true })
}

function readFirstLine(path: string): string | null {
  try {
    return (
      readFileSync(path, 'utf-8')
        .replace(/^\uFEFF/, '')
        .split(/\r?\n/)[0] ?? ''
    )
  } catch {
    return null
  }
}

function fileExists(path: string): boolean {
  return readFirstLine(path) !== null
}

export function readCodexHookFlagEntry(
  codexVersion: string,
  table = getCodexHookFlagTablePath()
): CodexHookFlagEntry | null {
  if (!isCodexHookFlagEntryName(codexVersion)) {
    return null
  }
  const base = join(table, codexVersion)
  const flag = readFirstLine(`${base}${CODEX_HOOK_FLAG_ENTRY_SUFFIX}`)
  return flag
    ? {
        codexVersion,
        flag,
        noDaemon: fileExists(`${base}${CODEX_HOOK_FLAG_NO_DAEMON_SUFFIX}`)
      }
    : null
}

function listNames(table: string, suffix: string): string[] {
  try {
    return readdirSync(table)
      .filter((name) => name.endsWith(suffix))
      .map((name) => name.slice(0, -suffix.length))
  } catch {
    return []
  }
}

export function listCodexHookFlagEntries(
  table = getCodexHookFlagTablePath()
): CodexHookFlagEntry[] {
  return listNames(table, CODEX_HOOK_FLAG_ENTRY_SUFFIX).flatMap((codexVersion) => {
    const entry = readCodexHookFlagEntry(codexVersion, table)
    return entry ? [entry] : []
  })
}

function writeAtomically(path: string, content: string): void {
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(temp, content, 'utf-8')
  renameSync(temp, path)
}

/** Marker first, so a launch that sees the flag also sees whether --no-daemon applies. */
export function publishCodexHookFlagEntry(
  entry: CodexHookFlagEntry,
  table = getCodexHookFlagTablePath()
): void {
  if (!isCodexHookFlagEntryName(entry.codexVersion) || /[\r\n]/.test(entry.flag)) {
    throw new Error(`Cannot publish a Codex hook flag for ${JSON.stringify(entry.codexVersion)}`)
  }
  ensureCodexHookFlagTable(table)
  const base = join(table, entry.codexVersion)
  if (entry.noDaemon) {
    writeFileSync(`${base}${CODEX_HOOK_FLAG_NO_DAEMON_SUFFIX}`, '', 'utf-8')
  } else {
    rmSync(`${base}${CODEX_HOOK_FLAG_NO_DAEMON_SUFFIX}`, { force: true })
  }
  writeAtomically(`${base}${CODEX_HOOK_FLAG_ENTRY_SUFFIX}`, `${entry.flag}\n`)
}

export function removeCodexHookFlagEntry(
  codexVersion: string,
  table = getCodexHookFlagTablePath()
): void {
  const base = join(table, codexVersion)
  rmSync(`${base}${CODEX_HOOK_FLAG_ENTRY_SUFFIX}`, { force: true })
  rmSync(`${base}${CODEX_HOOK_FLAG_NO_DAEMON_SUFFIX}`, { force: true })
}

/** Removes every entry and request; the directory stays, since open panes point at it. */
export function clearCodexHookFlagTable(table = getCodexHookFlagTablePath()): void {
  let names: string[]
  try {
    names = readdirSync(table)
  } catch {
    return
  }
  for (const name of names) {
    rmSync(join(table, name), { force: true, recursive: true })
  }
}

/** What an Orca-side launch writes on a miss, the same request a pane's codex function writes. */
export function requestCodexHookFlagEntry(
  codexVersion: string,
  codexPath: string,
  table = getCodexHookFlagTablePath()
): void {
  if (!isCodexHookFlagEntryName(codexVersion)) {
    return
  }
  try {
    writeFileSync(
      join(table, `${codexVersion}${CODEX_HOOK_FLAG_REQUEST_SUFFIX}`),
      `${codexPath}\n`,
      'utf-8'
    )
  } catch {
    // Why: a missing table means no Orca is listening; the next start derives anyway.
  }
}

/** Reads and deletes every pending request. Unreadable names are dropped. */
export function takeCodexHookFlagRequests(
  table = getCodexHookFlagTablePath()
): CodexHookFlagRequest[] {
  const requests: CodexHookFlagRequest[] = []
  for (const codexVersion of listNames(table, CODEX_HOOK_FLAG_REQUEST_SUFFIX)) {
    const path = join(table, `${codexVersion}${CODEX_HOOK_FLAG_REQUEST_SUFFIX}`)
    const codexPath = readFirstLine(path)?.trim() || null
    rmSync(path, { force: true })
    if (isCodexHookFlagEntryName(codexVersion)) {
      requests.push({ codexVersion, codexPath })
    }
  }
  return requests
}
