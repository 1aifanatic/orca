// Pure path-shape readers for agent transcripts. A transcript path can name another host (SSH,
// a WSL guest, Windows), so these parse strings only and never touch the local filesystem.

// Why: only Codex's dated rollout layout may establish account-home provenance; nested/misplaced JSONL must not select credentials.
const CLAIMED_CODEX_ROLLOUT_TAIL = String.raw`\d{4}/\d{2}/\d{2}/rollout-[^/]+\.jsonl(?:\.zst)?`
// Why: case-insensitive because trusted-home matching folds Windows path case too.
const CODEX_ROLLOUT_LAYOUT_PATH = new RegExp(`(?:^|/)sessions/${CLAIMED_CODEX_ROLLOUT_TAIL}$`, 'i')

function toForwardSlashes(path: string): string {
  return path.replace(/\\/g, '/')
}

/**
 * True when transcriptPath claims Codex's dated rollout layout, under any home and without
 * checking existence — separating rejected Codex provenance from cross-agent/stale metadata.
 * Not scoped to trusted homes: a rollout under a removed home is still rejected provenance,
 * and admitting it would resume that session under whichever account is selected now.
 */
export function claimsCodexRolloutLayout(transcriptPath: string | undefined): boolean {
  const persistedPath = transcriptPath?.trim()
  if (!persistedPath) {
    return false
  }
  return CODEX_ROLLOUT_LAYOUT_PATH.test(toForwardSlashes(persistedPath))
}

/**
 * How a rollout path names a Codex thread: `exact` when it ends in `-<threadId>.jsonl`,
 * `suffixed` when Codex appended a distinct `_<suffix>` that only the file's session_meta can settle.
 */
export function codexRolloutThreadMatch(
  rolloutPath: string,
  threadId: string
): 'exact' | 'suffixed' | null {
  const lower = toForwardSlashes(rolloutPath).toLowerCase()
  const threadSegment = `-${threadId.toLowerCase()}`
  const marker = lower.lastIndexOf(threadSegment)
  if (marker === -1) {
    return null
  }
  const after = lower.slice(marker + threadSegment.length)
  if (after === '.jsonl') {
    return 'exact'
  }
  return after.startsWith('_') && after.endsWith('.jsonl') ? 'suffixed' : null
}

/**
 * True for `<...>/.claude/projects/<encoded cwd>/<sessionId>.jsonl`. Anchored on `.claude`
 * because Claude-derived CLIs (Qoder, CodeBuddy) write the same `projects/` shape under their own
 * config dir; subagent transcripts nest one level deeper and so never match.
 */
export function claimsClaudeProjectTranscript(transcriptPath: string, sessionId: string): boolean {
  const segments = toForwardSlashes(transcriptPath.trim()).split('/')
  const count = segments.length
  return (
    count >= 4 &&
    segments[count - 1].toLowerCase() === `${sessionId.toLowerCase()}.jsonl` &&
    segments[count - 2] !== '' &&
    segments[count - 3].toLowerCase() === 'projects' &&
    segments[count - 4].toLowerCase() === '.claude'
  )
}

/** The one agent whose transcript layout the session's own path matches, named by its own id. */
export function transcriptLayoutAgent(session: {
  id: string
  transcriptPath?: string
}): 'codex' | 'claude' | undefined {
  const transcriptPath = session.transcriptPath?.trim()
  if (!transcriptPath) {
    return undefined
  }
  const codex =
    claimsCodexRolloutLayout(transcriptPath) &&
    codexRolloutThreadMatch(transcriptPath, session.id) === 'exact'
  const claude = claimsClaudeProjectTranscript(transcriptPath, session.id)
  // Why: a path matching both layouts (or neither) is no evidence; the display agent stands.
  if (codex === claude) {
    return undefined
  }
  return codex ? 'codex' : 'claude'
}
