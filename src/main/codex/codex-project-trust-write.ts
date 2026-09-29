import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { upsertProjectTrustLevel } from './config-toml-trust'
import { CodexConfigTomlEditRefusedError } from './codex-config-toml-checked-edit'
import { runExclusivelyForCodexTrustConfig } from './codex-trust-config-mutation-queue'
import { resolveOrcaManagedCodexHomePath } from './codex-home-paths'
import { normalizeRuntimePathForComparison } from '../../shared/cross-platform-path'

export type CodexProjectTrustWriteResult = { configPath: string; error: unknown }

/** Writes trust into one config.toml; returns the failure instead of throwing so other homes still get written. */
export function writeCodexProjectTrust(
  configPath: string,
  trustRoot: string
): CodexProjectTrustWriteResult {
  try {
    upsertProjectTrustLevel(configPath, trustRoot, 'trusted')
    return { configPath, error: null }
  } catch (error) {
    if (error instanceof CodexConfigTomlEditRefusedError) {
      return { configPath, error }
    }
    // Why: an OS error names the atomic writer's temp file, which never exists for the user to fix.
    const message = error instanceof Error ? error.message : String(error)
    return {
      configPath,
      error: message.includes(configPath)
        ? error
        : new Error(`could not write ${configPath}: ${message}`, { cause: error })
    }
  }
}

/**
 * Trusts the workspace in the exact Codex home a launch resolved (a per-account
 * home gets trust only by copy from ~/.codex otherwise, and never when that write failed).
 */
export async function markCodexProjectTrustedInHome(
  workspacePath: string,
  codexHomePath: string
): Promise<void> {
  const configPath = join(codexHomePath, 'config.toml')
  const trustRoot = resolveCodexProjectTrustRoot(workspacePath)
  const result = await runExclusivelyForCodexTrustConfig(configPath, async () =>
    writeCodexProjectTrust(configPath, trustRoot)
  )
  settleCodexProjectTrust(workspacePath, [result])
}

/** A launch home that is neither real ~/.codex (null) nor the shared managed home, which markCodexProjectTrusted already writes. */
export function isSeparateCodexLaunchHome(homePath: string | null): homePath is string {
  return (
    homePath !== null &&
    normalizeRuntimePathForComparison(homePath) !==
      normalizeRuntimePathForComparison(resolveOrcaManagedCodexHomePath())
  )
}

/** Throws after every home was attempted: the one failure, or all of them, so refusal reporting sees each. */
export function settleCodexProjectTrust(
  workspacePath: string,
  results: readonly CodexProjectTrustWriteResult[]
): void {
  const failures = results.flatMap((result) => (result.error === null ? [] : [result.error]))
  if (failures.length === 1) {
    throw failures[0]
  }
  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      `Orca could not mark ${workspacePath} trusted in ${failures.length} Codex homes`
    )
  }
}

export function resolveCodexProjectTrustRoot(workspacePath: string): string {
  const absPath = canonicalizeTrustPath(workspacePath)
  try {
    const gitDirReference = readFileSync(join(absPath, '.git'), 'utf-8').trim()
    if (!gitDirReference.startsWith('gitdir:')) {
      return absPath
    }
    const gitDirPath = gitDirReference.slice('gitdir:'.length).trim()
    if (!gitDirPath) {
      return absPath
    }
    const gitDir = resolve(absPath, gitDirPath)
    const worktreesDir = dirname(gitDir)
    if (basename(worktreesDir) !== 'worktrees') {
      return absPath
    }
    // Why: workspace-controlled .git metadata must not broaden trust without Git's reciprocal link.
    const gitDirBacklink = readFileSync(join(gitDir, 'gitdir'), 'utf-8').trim()
    if (!gitDirBacklink) {
      return absPath
    }
    const resolvedBacklink = resolve(gitDir, gitDirBacklink)
    const workspaceGitFile = join(absPath, '.git')
    if (
      resolvedBacklink !== workspaceGitFile &&
      canonicalizeTrustPath(resolvedBacklink) !== canonicalizeTrustPath(workspaceGitFile)
    ) {
      return absPath
    }
    // Why: mirror Codex's validated .git/worktrees/<name> traversal instead of trusting arbitrary commondir contents.
    return canonicalizeTrustPath(dirname(dirname(worktreesDir)))
  } catch {
    return absPath
  }
}

export function canonicalizeTrustPath(p: string): string {
  // Why: macOS reports `/tmp/x` and `/private/tmp/x` as the same inode, but
  // both Cursor and Copilot's trust comparators run realpath() before the
  // string compare. Mirror that so a worktree under a symlinked parent
  // (orca caches realpath()'d worktree paths) matches the agent's lookup.
  try {
    if (existsSync(p)) {
      return realpathSync.native(p)
    }
  } catch {
    // Fall through to the raw input.
  }
  return p
}
