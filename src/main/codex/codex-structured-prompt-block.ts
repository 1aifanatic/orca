// Codex's report that a UserPromptSubmit hook of the person's own blocked a prompt: a
// `hook/completed` frame inside the turn, before that turn's `turn/completed`. Codex records and
// echoes nothing for a blocked prompt, so the frame is the only proof it never reached history;
// the turn's end settles the sends it never echoed from it. The hook's reason is the person's own
// words for why, kept as plain text: never markup, no control characters, bounded.

import type { CodexSession } from './codex-structured-session-state'
import { readCodexThreadId } from './codex-structured-thread-facts'

/** Long enough for a sentence or two of why; the hook's full output stays in its own logs. */
export const MAX_CODEX_HOOK_REASON_CHARS = 300

export type CodexPromptBlock = { reason?: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function record(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null
}

/** One line of plain text: control and bidi characters become spaces, and a long one is cut. */
export function plainCodexHookReason(text: string): string | undefined {
  const plain = text
    // oxlint-disable-next-line no-control-regex -- stripping control characters is the point.
    .replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!plain) {
    return undefined
  }
  return plain.length > MAX_CODEX_HOOK_REASON_CHARS
    ? `${plain.slice(0, MAX_CODEX_HOOK_REASON_CHARS - 1).trimEnd()}…`
    : plain
}

/** The block this frame reports, or null for any other frame. */
export function readCodexPromptBlock(
  method: string,
  params: unknown
): ({ threadId: string; turnId: string } & CodexPromptBlock) | null {
  const root = record(params)
  const run = record(root?.run)
  const threadId = readCodexThreadId(params)
  const turnId = typeof root?.turnId === 'string' && root.turnId ? root.turnId : null
  if (
    method !== 'hook/completed' ||
    !run ||
    run.eventName !== 'userPromptSubmit' ||
    (run.status !== 'blocked' && run.status !== 'stopped') ||
    !threadId ||
    !turnId
  ) {
    return null
  }
  // A `blocked` run states its reason as `feedback`, a `stopped` one as `stop`.
  const reason = (Array.isArray(run.entries) ? run.entries : [])
    .map((entry) => record(entry))
    .filter((entry) => entry?.kind === 'feedback' || entry?.kind === 'stop')
    .map((entry) =>
      typeof entry?.text === 'string' ? plainCodexHookReason(entry.text) : undefined
    )
    .find((text) => text !== undefined)
  return { threadId, turnId, ...(reason ? { reason } : {}) }
}

/** Notes the primary thread's turn whose prompt a hook blocked, until that turn ends. */
export function noteCodexPromptBlock(
  session: Pick<CodexSession, 'threadId' | 'dispatchEchoes'>,
  method: string,
  params: unknown
): void {
  const block = readCodexPromptBlock(method, params)
  if (block && block.threadId === session.threadId) {
    session.dispatchEchoes.blockPrompt(
      block.threadId,
      block.turnId,
      block.reason ? { reason: block.reason } : {}
    )
  }
}
