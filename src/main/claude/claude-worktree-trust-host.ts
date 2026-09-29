import { lstatSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import {
  convergeClaudeFolderTrust,
  toClaudeTrustKey,
  type ClaudeFolderTrustOutcome,
  type ClaudeTrustPathStyle
} from './claude-folder-trust-file'

/** A stuck lock must degrade to Claude's own prompt quickly, never stall the launch. */
export const CLAUDE_WORKTREE_TRUST_DEADLINE_MS = 1500

export type ClaudeWorktreeTrustHostRequest = {
  configFile: string
  /** Host-native path of the worktree root Claude will launch in. */
  worktreeRoot: string
  /** Host-native path of the repo's main checkout, which Claude checks before its walk. */
  mainCheckoutPath: string | null
  trusted: boolean
  /** Path style of the Claude process (a WSL guest is posix even when this host is Windows). */
  keyStyle: ClaudeTrustPathStyle
  /** Maps a host-native path to the path the Claude process sees (WSL UNC → Linux). */
  toClaudePath?: (hostPath: string) => string | null
}

export type ClaudeWorktreeTrustHostOutcome =
  | ClaudeFolderTrustOutcome
  | 'not-linked-worktree'
  | 'timed-out'
  | 'failed'

/** A linked worktree has a `.git` FILE; a directory means a main checkout, whose key would trust the whole repo. */
function isLinkedWorktreeRoot(worktreeRoot: string): boolean {
  try {
    return lstatSync(join(worktreeRoot, '.git')).isFile()
  } catch {
    return false
  }
}

function claudeKeysForHostPath(
  hostPath: string,
  request: ClaudeWorktreeTrustHostRequest
): string[] {
  const forms = [resolve(hostPath)]
  try {
    forms.push(realpathSync.native(hostPath))
  } catch {
    try {
      // Why: a removed worktree has no realpath, but its parent's gives the same key Orca wrote.
      forms.push(join(realpathSync.native(dirname(hostPath)), basename(hostPath)))
    } catch {
      // The resolved form alone still matches an unsymlinked path.
    }
  }
  const keys = new Set<string>()
  for (const form of forms) {
    const claudePath = request.toClaudePath ? request.toClaudePath(form) : form
    if (claudePath) {
      keys.add(toClaudeTrustKey(claudePath, request.keyStyle))
    }
  }
  return [...keys]
}

async function convergeOnHost(
  request: ClaudeWorktreeTrustHostRequest
): Promise<ClaudeWorktreeTrustHostOutcome> {
  if (request.trusted && !isLinkedWorktreeRoot(request.worktreeRoot)) {
    return 'not-linked-worktree'
  }
  const folderKeys = claudeKeysForHostPath(request.worktreeRoot, request)
  if (folderKeys.length === 0) {
    return 'unchanged'
  }
  return convergeClaudeFolderTrust({
    configFile: request.configFile,
    folderKeys,
    inheritedTrustKeys: request.mainCheckoutPath
      ? claudeKeysForHostPath(request.mainCheckoutPath, request)
      : [],
    trusted: request.trusted
  })
}

/**
 * Best-effort convergence of one worktree's Claude trust entry on the host that runs
 * Claude. Never throws and never waits past the deadline: every failure means Claude
 * shows its own "trust this folder?" prompt.
 */
export async function convergeClaudeWorktreeTrustOnHost(
  request: ClaudeWorktreeTrustHostRequest,
  deadlineMs = CLAUDE_WORKTREE_TRUST_DEADLINE_MS
): Promise<ClaudeWorktreeTrustHostOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expiry = new Promise<'timed-out'>((done) => {
    timer = setTimeout(() => done('timed-out'), deadlineMs)
  })
  try {
    const outcome = await Promise.race([
      convergeOnHost(request).catch((): ClaudeWorktreeTrustHostOutcome => 'failed'),
      expiry
    ])
    if (outcome === 'timed-out' || outcome === 'failed') {
      console.warn(
        `[claude-trust] ${request.trusted ? 'trust' : 'revoke'} for ${request.worktreeRoot} ${outcome}; Claude will ask instead`
      )
    }
    return outcome
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Converges many worktrees at once. Revocations share one read and at most one write per
 * config file; a grant's already-trusted check is per worktree, so grants stay single.
 */
export async function convergeClaudeWorktreesTrustOnHost(
  requests: readonly ClaudeWorktreeTrustHostRequest[]
): Promise<void> {
  const revokedKeysByFile = new Map<string, Set<string>>()
  for (const request of requests.filter((candidate) => !candidate.trusted)) {
    const keys = revokedKeysByFile.get(request.configFile) ?? new Set<string>()
    claudeKeysForHostPath(request.worktreeRoot, request).forEach((key) => keys.add(key))
    revokedKeysByFile.set(request.configFile, keys)
  }
  for (const [configFile, keys] of revokedKeysByFile) {
    // Why: one unwritable file must not keep the others' entries in place.
    await convergeClaudeFolderTrust({
      configFile,
      folderKeys: [...keys],
      inheritedTrustKeys: [],
      trusted: false
    }).catch((error: unknown) => {
      console.warn(`[claude-trust] revoke in ${configFile} failed; entries remain`, error)
    })
  }
  for (const request of requests.filter((candidate) => candidate.trusted)) {
    await convergeClaudeWorktreeTrustOnHost(request)
  }
}
