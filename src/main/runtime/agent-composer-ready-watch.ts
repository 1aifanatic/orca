/**
 * A freshly launched agent's own composer-ready signal, as evidence for a launch-readiness wait.
 *
 * `tui-idle` alone never settles for an agent that paints no idle title and no known ready screen —
 * most `stdin-after-start` agents — so a launch prompt, a worker brief or a startup draft waited out
 * its whole budget and was never delivered. This reads the scanner the renderer's draft paste has
 * always used and hands its state to the tui-idle evaluator as one weak-ready rank; the evaluator
 * and the poll decide, including the rendered-screen blocked check.
 *
 * The signal only counts while the agent owns the PTY. The shell arms bracketed paste for its own
 * prompt, so the scanner is fed only output between the shell's OSC 133;C (command started) and its
 * next 133;D / 133;A (command finished / prompt drawn). A transport that emits no 133;C never arms
 * it, and the wait is exactly `tui-idle`.
 *
 * An agent that announces rest in its own title (Claude's `✳`) is read by that title alone: it arms
 * bracketed paste before its first-run dialogs (workspace trust, bypass permissions), so for it the
 * signal cannot tell a composer from a dialog.
 */

import {
  createDraftPasteReadyScanner,
  draftPasteReadySignalHasMarker
} from '../../shared/draft-paste-ready-scanner'
import type { TuiAgent } from '../../shared/tui-agent'
import { TUI_AGENT_CONFIG } from '../../shared/tui-agent-config'
import { announcesRestInOwnTitle } from './tui-idle-evidence'

/** `ready`: the agent's composer marker rendered. `armed`: it enabled bracketed paste and settles
 *  once its output goes quiet. `awaiting-marker`: the agent owns the PTY and its composer has a
 *  marker that has not rendered yet. `none`: no evidence either way. */
export type AgentComposerSignal = 'none' | 'awaiting-marker' | 'armed' | 'ready'

export type AgentComposerReadyWatch = {
  signal(): AgentComposerSignal
  dispose(): void
}

// OSC 133 marks: C = the shell handed the terminal to a command; D / A = it took it back.
const OSC_133_PREFIX = '\x1b]133;'
const OWNERSHIP_MARKS = new Set(['A', 'C', 'D'])

export function watchAgentComposerReady(
  agent: TuiAgent,
  host: {
    subscribeToData: (listener: (data: string) => void) => () => void
    readRecentOutput: () => string | undefined
  }
): AgentComposerReadyWatch | null {
  if (announcesRestInOwnTitle(agent)) {
    return null
  }
  const readySignal =
    TUI_AGENT_CONFIG[agent].draftPasteReadySignal ?? 'render-quiet-after-bracketed-paste'
  const commandStartSignal: AgentComposerSignal = draftPasteReadySignalHasMarker(readySignal)
    ? 'awaiting-marker'
    : 'none'
  let scanner: ReturnType<typeof createDraftPasteReadyScanner> | null = null
  let signal: AgentComposerSignal = 'none'
  let carry = ''

  const observeOwned = (segment: string): void => {
    if (!scanner || segment.length === 0 || signal === 'ready') {
      return
    }
    const result = scanner.observe(segment)
    if (result.ready) {
      signal = 'ready'
    } else if (result.armQuietTimer) {
      signal = 'armed'
    }
  }
  const observe = (data: string): void => {
    // Why the carry: a mark split across chunks must still switch ownership at the right byte.
    const text = carry + data
    let cursor = 0
    for (
      let index = text.indexOf(OSC_133_PREFIX);
      index !== -1;
      index = text.indexOf(OSC_133_PREFIX, index + 1)
    ) {
      const mark = text[index + OSC_133_PREFIX.length]
      if (mark === undefined || !OWNERSHIP_MARKS.has(mark)) {
        continue
      }
      observeOwned(text.slice(cursor, index))
      cursor = index + OSC_133_PREFIX.length + 1
      // Why a fresh scanner per command: the previous command's bracketed paste proves nothing now.
      scanner = mark === 'C' ? createDraftPasteReadyScanner(readySignal) : null
      signal = scanner ? commandStartSignal : 'none'
    }
    const tail = text.slice(cursor)
    const partial = tail.lastIndexOf('\x1b')
    const holdBack = partial !== -1 && OSC_133_PREFIX.startsWith(tail.slice(partial))
    observeOwned(holdBack ? tail.slice(0, partial) : tail)
    carry = holdBack ? tail.slice(partial) : ''
  }

  const unsubscribe = host.subscribeToData(observe)
  // Why replay: a fast agent can mount its composer before the wait subscribes.
  const replay = host.readRecentOutput()
  if (replay) {
    observe(replay)
  }
  return { signal: () => signal, dispose: unsubscribe }
}
