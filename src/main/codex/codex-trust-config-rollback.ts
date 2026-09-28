import {
  chmodSync,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, resolve } from 'node:path'
import { renameFileWithWindowsRetry } from '../codex-accounts/fs-utils'

export type CodexTrustConfigSnapshot =
  | { existed: false; restorePath?: string }
  | { existed: true; contents: Buffer; mode: number; restorePath: string }

function resolveConfigRestorePath(tomlPath: string): string {
  try {
    if (!lstatSync(tomlPath).isSymbolicLink()) {
      return tomlPath
    }
    try {
      return realpathSync.native(tomlPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
      // Why: a dangling dotfiles link is still user-owned state. Target the
      // lexical destination so rollback removes an RPC-created file, not the link.
      return resolve(dirname(tomlPath), readlinkSync(tomlPath))
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return tomlPath
    }
    throw error
  }
}

export function captureCodexTrustConfig(tomlPath: string): CodexTrustConfigSnapshot {
  const restorePath = resolveConfigRestorePath(tomlPath)
  let descriptor: number
  try {
    descriptor = openSync(restorePath, 'r')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return restorePath === tomlPath ? { existed: false } : { existed: false, restorePath }
    }
    throw error
  }
  try {
    // Why: read and stat the same open file so replacement between two path
    // lookups cannot pair one file's contents with another file's mode.
    return {
      existed: true,
      contents: readFileSync(descriptor),
      mode: fstatSync(descriptor).mode,
      restorePath
    }
  } finally {
    closeSync(descriptor)
  }
}

/** The config's bytes now, or null when absent: what a later restore must still find. */
export function readCodexTrustConfigGeneration(
  tomlPath: string,
  snapshot: CodexTrustConfigSnapshot
): Buffer | null {
  try {
    return readFileSync(snapshot.restorePath ?? tomlPath)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null
    }
    throw error
  }
}

/**
 * Rolls config.toml back to `snapshot`, but only while it still holds `written`,
 * the generation Orca's mutation left. A write that landed after it is newer than
 * both, so it is left in place.
 */
export function restoreCodexTrustConfig(
  tomlPath: string,
  snapshot: CodexTrustConfigSnapshot,
  written: Buffer | null
): void {
  const current = readCodexTrustConfigGeneration(tomlPath, snapshot)
  if (!snapshot.existed) {
    if (current === null) {
      return
    }
    if (!isSameGeneration(current, written)) {
      warnConfigChangedSinceOrcaWrote(tomlPath)
      return
    }
    try {
      unlinkSync(snapshot.restorePath ?? tomlPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
    }
    return
  }
  const { restorePath } = snapshot
  if (current?.equals(snapshot.contents)) {
    // Why: the RPC may change permissions without changing bytes; rollback
    // restores the complete captured file state, not only its contents.
    chmodSync(restorePath, snapshot.mode)
    return
  }
  if (!isSameGeneration(current, written)) {
    warnConfigChangedSinceOrcaWrote(tomlPath)
    return
  }
  // Why: rollback protects config integrity too; direct truncating writes can
  // leave Codex unusable if Orca exits midway through recovery.
  // Why: Codex's writer preserves config.toml symlinks. Restore through their
  // real target too, or Orca's atomic rename would disconnect dotfiles users.
  const tempPath = `${restorePath}.${process.pid}.${randomUUID()}.rollback.tmp`
  try {
    writeFileSync(tempPath, snapshot.contents, { mode: snapshot.mode })
    renameFileWithWindowsRetry(tempPath, restorePath)
  } catch (error) {
    try {
      unlinkSync(tempPath)
    } catch {
      // Best effort; preserve the rollback failure as the actionable error.
    }
    throw error
  }
}

function isSameGeneration(left: Buffer | null, right: Buffer | null): boolean {
  return left === null || right === null ? left === right : left.equals(right)
}

function warnConfigChangedSinceOrcaWrote(tomlPath: string): void {
  console.warn('[codex-trust-config] left a config.toml changed since Orca wrote it:', tomlPath)
}
