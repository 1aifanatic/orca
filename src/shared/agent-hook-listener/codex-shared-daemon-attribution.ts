import type { IncomingHttpHeaders } from 'node:http'
import { ORCA_HOOK_EXECUTOR_CODEX_SHARED_DAEMON } from '../agent-hook-types'
import { mergeAgentHookRequestHeaders } from './hook-envelope'
import { parsePaneKey } from '../stable-pane-id'
import { splitWorktreeIdForFilesystem } from '../worktree/id'
import { parseWslUncPath } from '../wsl-paths'
import { normalizeAgentSessionDirectory } from './opencode-session-correlation'
import { parseAgentHookJson } from './request-body'

/**
 * Codex >= 0.157 runs every TUI's hooks inside one shared app-server daemon
 * per CODEX_HOME, so the ORCA_* stamp on those posts is the env of whichever
 * pane happened to start the daemon, not of the session that fired the hook.
 * The managed script marks such posts; this decides who owns them from the
 * session's own cwd, before anything downstream reads the stamp.
 */

/** A live local pane that could own a daemon-run Codex session. */
export type CodexDaemonHookPane = {
  paneKey: string | null
  worktreeId: string | null
}

export type CodexDaemonHookAttribution =
  | { kind: 'keep' }
  | { kind: 'rebind'; paneKey: string; worktreeId: string }
  | { kind: 'drop' }

function worktreeRoot(worktreeId: string | null | undefined): string | null {
  if (!worktreeId) {
    return null
  }
  const path = splitWorktreeIdForFilesystem(worktreeId)?.worktreePath
  if (!path) {
    return null
  }
  // Why: a WSL pane's worktree is spelled as a UNC path, but Codex inside WSL reports a Linux cwd.
  return normalizeAgentSessionDirectory(parseWslUncPath(path)?.linuxPath ?? path)
}

function containsDirectory(root: string, target: string): boolean {
  return target === root || target.startsWith(root.endsWith('/') ? root : `${root}/`)
}

/**
 * Owner of one daemon-run Codex post. The stamp is only kept when the
 * session's cwd sits in the stamped pane's worktree; otherwise the post moves
 * to the one pane in the session's (deepest) worktree, or is dropped when no
 * single pane qualifies. `panes` is null where no pane inventory exists (the
 * SSH relay), which can then only keep or drop.
 */
export function attributeCodexDaemonHook(args: {
  cwd: string | undefined
  stampedPaneKey: string
  stampedWorktreeId: string | undefined
  panes: readonly CodexDaemonHookPane[] | null
}): CodexDaemonHookAttribution {
  const cwd = args.cwd?.trim()
  if (!cwd) {
    // Why: nothing to judge the stamp against; keep today's attribution rather than blank a pane.
    return { kind: 'keep' }
  }
  const target = normalizeAgentSessionDirectory(cwd)
  let deepest = -1
  let candidates: { paneKey: string | null; worktreeId: string }[] = []
  const seen = new Set<string>()
  for (const pane of args.panes ?? []) {
    const root = pane.worktreeId ? worktreeRoot(pane.worktreeId) : null
    if (!pane.worktreeId || root === null || !containsDirectory(root, target)) {
      continue
    }
    const dedupeKey = pane.paneKey ?? `\0${pane.worktreeId}`
    if (seen.has(dedupeKey)) {
      continue
    }
    seen.add(dedupeKey)
    // Why deepest: a linked worktree nested inside the main checkout owns its own sessions.
    if (root.length > deepest) {
      deepest = root.length
      candidates = []
    }
    if (root.length === deepest) {
      candidates.push({ paneKey: pane.paneKey, worktreeId: pane.worktreeId })
    }
  }
  if (candidates.some((candidate) => candidate.paneKey === args.stampedPaneKey)) {
    return { kind: 'keep' }
  }
  if (candidates.length === 1) {
    const [only] = candidates
    return only?.paneKey
      ? { kind: 'rebind', paneKey: only.paneKey, worktreeId: only.worktreeId }
      : { kind: 'drop' }
  }
  if (candidates.length > 1) {
    // Why drop: several panes share the session's worktree and none is provably its owner.
    return { kind: 'drop' }
  }
  const stampedRoot = worktreeRoot(args.stampedWorktreeId)
  // Why keep an unreadable stamp: without a worktree path there is no evidence against it.
  return stampedRoot === null || containsDirectory(stampedRoot, target)
    ? { kind: 'keep' }
    : { kind: 'drop' }
}

function readPayloadCwd(payload: unknown): string | undefined {
  let record: unknown = payload
  if (typeof payload === 'string') {
    try {
      record = parseAgentHookJson(payload)
    } catch {
      return undefined
    }
  }
  if (typeof record !== 'object' || record === null) {
    return undefined
  }
  const cwd: unknown = Reflect.get(record, 'cwd')
  return typeof cwd === 'string' ? cwd : undefined
}

/**
 * Rewrite a hook body's pane stamp when the managed Codex script reported
 * that the shared daemon ran it. Any other body passes through untouched. A
 * dropped post keeps its payload but loses its pane key, so the envelope
 * parser rejects it instead of filing it under the daemon starter's pane.
 */
export function attributeCodexSharedDaemonHookBody(
  body: unknown,
  panes: readonly CodexDaemonHookPane[] | null,
  lookupLaunchToken: (paneKey: string) => string | undefined = () => undefined
): unknown {
  if (typeof body !== 'object' || body === null) {
    return body
  }
  const record: Record<string, unknown> = { ...body }
  if (record.executor !== ORCA_HOOK_EXECUTOR_CODEX_SHARED_DAEMON) {
    return body
  }
  const stampedPaneKey = typeof record.paneKey === 'string' ? record.paneKey.trim() : ''
  const verdict = attributeCodexDaemonHook({
    cwd: readPayloadCwd(record.payload),
    stampedPaneKey,
    stampedWorktreeId: typeof record.worktreeId === 'string' ? record.worktreeId : undefined,
    panes
  })
  if (verdict.kind === 'keep') {
    return body
  }
  if (verdict.kind === 'drop') {
    return { ...record, paneKey: '' }
  }
  return {
    ...record,
    paneKey: verdict.paneKey,
    tabId: parsePaneKey(verdict.paneKey)?.tabId,
    worktreeId: verdict.worktreeId,
    // Why: the stamped token is the daemon starter's; carrying it would fence the real pane.
    launchToken: lookupLaunchToken(verdict.paneKey)
  }
}

/** Relay ingest: with no pane inventory, a daemon post is kept or dropped by its stamped worktree. */
export function mergeRelayAgentHookRequest(body: unknown, headers: IncomingHttpHeaders): unknown {
  return attributeCodexSharedDaemonHookBody(mergeAgentHookRequestHeaders(body, headers), null)
}
