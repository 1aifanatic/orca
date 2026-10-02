import { realpath, stat } from 'node:fs/promises'
import { claudeVersionReaches, probeClaudeCliVersion } from './claude-hook-event-versions'

// Why: the first CLI whose parser defines the flag (2.1.93 was never published); an older one exits
// on it before the session starts. Found by reading published packages, not by running them.
const CLAUDE_THINKING_DISPLAY_FIRST_VERSION = '2.1.94'

/** About 3x the p95 of this probe against a warm CLI (66 ms over 10 runs on an M-series Mac). */
export const CLAUDE_THINKING_DISPLAY_PROBE_BUDGET_MS = 200

/** Commander's refusal, exactly: any other startup failure says nothing about the flag. */
const UNKNOWN_FLAG_DIAGNOSTIC = "unknown option '--thinking-display'"

// One entry per binary per workspace it launched in.
const MAX_REMEMBERED = 16

const SUMMARIZED: Readonly<Record<string, string>> = { 'thinking-display': 'summarized' }

export type ClaudeThinkingDisplayLaunch = {
  command: string
  cwd: string
  env: Record<string, string>
}

export type ClaudeThinkingDisplaySupport = {
  /**
   * Asks for readable thinking: under Orca's launch the CLI otherwise streams thinking blocks with
   * no text. Only the display is set, never `--thinking`, so a user who turned thinking off keeps
   * it off. A binary not yet known is probed with the launch's own cwd and env, for at most the
   * budget; past it the launch goes without the flag and the next one asks again.
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

export function createClaudeThinkingDisplaySupport(
  deps: {
    probe: (
      command: string,
      launch: { cwd: string; env: Record<string, string> }
    ) => Promise<string | null>
    keyOf: (command: string, cwd: string) => Promise<string | null>
    budgetMs: number
  } = {
    probe: probeClaudeCliVersion,
    keyOf: claudeBinaryKey,
    budgetMs: CLAUDE_THINKING_DISPLAY_PROBE_BUDGET_MS
  }
): ClaudeThinkingDisplaySupport {
  const known = new Map<string, boolean>()
  const probing = new Map<string, Promise<string | null>>()
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
  const probe = (key: string, launch: ClaudeThinkingDisplayLaunch): Promise<string | null> => {
    let pending = probing.get(key)
    if (!pending) {
      pending = deps.probe(launch.command, { cwd: launch.cwd, env: launch.env }).then(
        (version) => {
          // Only an answer is kept; a probe that failed is asked again next launch.
          if (version !== null) {
            remember(key, claudeVersionReaches(version, CLAUDE_THINKING_DISPLAY_FIRST_VERSION))
          }
          return version
        },
        () => null
      )
      probing.set(key, pending)
      void pending.finally(() => probing.delete(key))
    }
    return pending
  }

  return {
    argsFor: async (launch) => {
      const key = await deps.keyOf(launch.command, launch.cwd)
      if (key === null) {
        return {}
      }
      if (!known.has(key)) {
        let timer: ReturnType<typeof setTimeout> | undefined
        await Promise.race([
          probe(key, launch),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, deps.budgetMs)
            timer.unref?.()
          })
        ])
        clearTimeout(timer)
      }
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
