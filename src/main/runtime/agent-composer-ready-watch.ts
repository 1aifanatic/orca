/**
 * A freshly launched agent's own composer-ready signal, as evidence for a launch-readiness wait.
 *
 * `tui-idle` alone never settles for an agent that paints no idle title and no known ready screen
 * (goose), so a launch prompt, a worker brief or a startup draft waited out its whole budget and was
 * never delivered. Each agent declares the evidence its composer gives (`launchReadiness` in
 * `tui-agent-config.ts`), backed by a captured screen; this reads it with the scanner the draft paste
 * has always used and hands its state to the tui-idle evaluator, which decides, including the
 * rendered-screen blocked check. An undeclared agent gets no watch and a plain `tui-idle` wait.
 *
 * The signal only counts while the agent owns the PTY. The shell arms bracketed paste for its own
 * prompt, so the scanner is fed only output between the shell's OSC 133;C (command started) and its
 * next 133;D / 133;A (command finished / prompt drawn). Outside that window the watch reads
 * `unowned`, and the wait is exactly `tui-idle`.
 */

import {
  createDraftPasteReadyScanner,
  draftPasteReadySignalHasMarker
} from '../../shared/draft-paste-ready-scanner'
import type { TuiAgent } from '../../shared/tui-agent'
import { TUI_AGENT_CONFIG, type DraftPasteReadySignal } from '../../shared/tui-agent-config'

/** `unowned`: the agent's command does not own the PTY, so this is no evidence. `pending`: it owns
 *  it and its composer has shown nothing yet. `armed`: a `composer-quiet` agent enabled bracketed
 *  paste and is ready once quiet. `ready`: a `composer-marker` agent's marker rendered. */
export type AgentComposerSignal = 'unowned' | 'pending' | 'armed' | 'ready'

export type AgentComposerReadyWatch = {
  signal(): AgentComposerSignal
  /** Whether the shell has written any OSC 133 mark, so it will mark this command's start too. */
  shellMarksCommands(): boolean
  /** Resolves true once a command owns the PTY, or false after `timeoutMs` or on dispose. */
  waitForOwnership(timeoutMs: number): Promise<boolean>
  dispose(): void
}

// OSC 133 marks: C = the shell handed the terminal to a command; D / A = it took it back.
const OSC_133_PREFIX = '\x1b]133;'
const OWNERSHIP_MARKS = new Set(['A', 'C', 'D'])

function resolveComposerScannerSignal(agent: TuiAgent): DraftPasteReadySignal | null {
  const config = TUI_AGENT_CONFIG[agent]
  if (config.launchReadiness === 'composer-quiet') {
    return 'render-quiet-after-bracketed-paste'
  }
  if (
    config.launchReadiness === 'composer-marker' &&
    config.draftPasteReadySignal &&
    draftPasteReadySignalHasMarker(config.draftPasteReadySignal)
  ) {
    return config.draftPasteReadySignal
  }
  return null
}

export function watchAgentComposerReady(
  agent: TuiAgent,
  host: {
    subscribeToData: (listener: (data: string) => void) => () => void
    readRecentOutput: () => string | undefined
  }
): AgentComposerReadyWatch | null {
  const readySignal = resolveComposerScannerSignal(agent)
  if (!readySignal) {
    return null
  }
  let scanner: ReturnType<typeof createDraftPasteReadyScanner> | null = null
  let signal: AgentComposerSignal = 'unowned'
  let marked = false
  let carry = ''
  const ownershipWaiters = new Set<(owned: boolean) => void>()
  const settleOwnershipWaiters = (owned: boolean): void => {
    for (const settle of ownershipWaiters) {
      settle(owned)
    }
    ownershipWaiters.clear()
  }

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
      if (mark === undefined) {
        continue
      }
      marked = true
      if (!OWNERSHIP_MARKS.has(mark)) {
        continue
      }
      observeOwned(text.slice(cursor, index))
      cursor = index + OSC_133_PREFIX.length + 1
      // Why a fresh scanner per command: the previous command's bracketed paste proves nothing now.
      scanner = mark === 'C' ? createDraftPasteReadyScanner(readySignal) : null
      signal = scanner ? 'pending' : 'unowned'
      if (scanner) {
        settleOwnershipWaiters(true)
      }
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
  return {
    signal: () => signal,
    shellMarksCommands: () => marked,
    waitForOwnership: (timeoutMs) => {
      if (signal !== 'unowned') {
        return Promise.resolve(true)
      }
      return new Promise((resolve) => {
        const settle = (owned: boolean): void => {
          clearTimeout(timer)
          ownershipWaiters.delete(settle)
          resolve(owned)
        }
        const timer = setTimeout(() => settle(false), Math.max(0, timeoutMs))
        ownershipWaiters.add(settle)
      })
    },
    dispose: () => {
      unsubscribe()
      settleOwnershipWaiters(false)
    }
  }
}
