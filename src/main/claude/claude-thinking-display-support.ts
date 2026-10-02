import { realpath, stat } from 'node:fs/promises'
import { claudeVersionReaches, probeClaudeCliVersion } from './claude-hook-event-versions'

// Why: the first CLI whose parser defines the flag (2.1.93 was never published); an older one exits
// on it before the session starts. Found by reading published packages, not by running them.
const CLAUDE_THINKING_DISPLAY_FIRST_VERSION = '2.1.94'

/** How long a launch waits on a binary nothing is known about yet. A warm probe answers in tens of
 *  milliseconds; this covers a cold disk, a node install and an antivirus scan, paid once per key
 *  during a start that already takes seconds. */
export const CLAUDE_THINKING_DISPLAY_PROBE_BUDGET_MS = 1_500

/** A probe still running by now is killed, and its binary gets no flag. */
const PROBE_KILL_AFTER_MS = 10_000

/** Commander's refusal, exactly: any other startup failure says nothing about the flag. */
const UNKNOWN_FLAG_DIAGNOSTIC = "unknown option '--thinking-display'"

// One small entry per binary per workspace it launched in; enough for every worktree in active use.
const MAX_REMEMBERED = 32

const SUMMARIZED: Readonly<Record<string, string>> = { 'thinking-display': 'summarized' }

export type ClaudeThinkingDisplayLaunch = {
  command: string
  cwd: string
  env: Record<string, string>
}

type ClaudeVersionProbe = (
  command: string,
  launch: { cwd: string; env: Record<string, string>; timeoutMs: number }
) => Promise<string | null>

export type ClaudeThinkingDisplaySupport = {
  /**
   * Asks for readable thinking: under Orca's launch the CLI otherwise streams thinking blocks with
   * no text. Only the display is set, never `--thinking`, so a user who turned thinking off keeps
   * it off. A binary not yet known is probed with the launch's own cwd and env, waited on for at
   * most the budget from when its probe began; past it the launch goes without the flag.
   */
  argsFor: (launch: ClaudeThinkingDisplayLaunch) => Promise<Readonly<Record<string, string>>>
  /** A child that exited refusing the flag: that binary, in that workspace, never gets it again. */
  observeExit: (launch: Pick<ClaudeThinkingDisplayLaunch, 'command' | 'cwd'>, error: Error) => void
}

/** Which binary a command is in a workspace right now: a shim answers per project, and a
 *  self-update swaps the link's target or the file. */
async function claudeBinaryKey(command: string, cwd: string): Promise<string | null> {
  try {
    const target = await realpath(command)
    return `${target}\n${(await stat(target)).mtimeMs}\n${cwd}`
  } catch {
    return null
  }
}

/** The promise's value if it settles within `ms`, else undefined. */
async function within<T>(pending: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), Math.max(0, ms))
    timer.unref?.()
  })
  try {
    return await Promise.race([pending, expired])
  } finally {
    clearTimeout(timer)
  }
}

export function createClaudeThinkingDisplaySupport(
  deps: {
    probe: ClaudeVersionProbe
    keyOf: (command: string, cwd: string) => Promise<string | null>
    budgetMs: number
    now: () => number
  } = {
    probe: probeClaudeCliVersion,
    keyOf: claudeBinaryKey,
    budgetMs: CLAUDE_THINKING_DISPLAY_PROBE_BUDGET_MS,
    now: () => performance.now()
  }
): ClaudeThinkingDisplaySupport {
  const known = new Map<string, boolean>()
  const probing = new Map<string, { settled: Promise<void>; startedAt: number }>()
  const remember = (key: string, supported: boolean): void => {
    known.delete(key)
    known.set(key, supported)
    for (const stale of known.keys()) {
      if (known.size <= MAX_REMEMBERED) {
        break
      }
      known.delete(stale)
    }
  }
  // Every outcome is kept for the binary's life: one that hung, failed or printed no version
  // would otherwise cost every launch a spawn and the whole wait. A refusal seen meanwhile wins.
  const settle = (key: string, supported: boolean): void => {
    if (!known.has(key)) {
      remember(key, supported)
    }
  }
  const probe = (key: string, launch: ClaudeThinkingDisplayLaunch) => {
    const settled = deps
      .probe(launch.command, { cwd: launch.cwd, env: launch.env, timeoutMs: PROBE_KILL_AFTER_MS })
      .then(
        (version) =>
          settle(
            key,
            version !== null && claudeVersionReaches(version, CLAUDE_THINKING_DISPLAY_FIRST_VERSION)
          ),
        () => settle(key, false)
      )
      .finally(() => probing.delete(key))
    const started = { settled, startedAt: deps.now() }
    probing.set(key, started)
    return started
  }

  return {
    argsFor: async (launch) => {
      // The launch never waits longer than the budget, finding the binary included.
      const deadline = deps.now() + deps.budgetMs
      const key = await within(deps.keyOf(launch.command, launch.cwd), deps.budgetMs)
      if (key === undefined || key === null) {
        return {}
      }
      const supported = known.get(key)
      if (supported !== undefined) {
        // Read as used: the bound drops the binaries launched least recently.
        remember(key, supported)
        return supported ? SUMMARIZED : {}
      }
      const running = probing.get(key) ?? probe(key, launch)
      // The probe's own budget, too: one already past it is not waited on again.
      await within(
        running.settled,
        Math.min(running.startedAt + deps.budgetMs, deadline) - deps.now()
      )
      return known.get(key) === true ? SUMMARIZED : {}
    },
    observeExit: (launch, error) => {
      if (!error.message.includes(UNKNOWN_FLAG_DIAGNOSTIC)) {
        return
      }
      void deps.keyOf(launch.command, launch.cwd).then((key) => {
        if (key !== null) {
          remember(key, false)
        }
      })
    }
  }
}

/** One per process: every structured launch on this host shares what it learned. */
export const claudeThinkingDisplaySupport = createClaudeThinkingDisplaySupport()
