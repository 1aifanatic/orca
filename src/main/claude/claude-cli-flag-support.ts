import { realpath, stat } from 'node:fs/promises'
import { claudeVersionReaches, probeClaudeCliVersion } from './claude-hook-event-versions'

/** A launch flag an older Claude CLI exits on, and the first published CLI whose parser defines it.
 *  Versions were found by reading published packages, not by running them. */
export type ClaudeCliFlag = { readonly option: string; readonly firstVersion: string }

// Why 2.1.94: 2.1.93 was never published.
export const CLAUDE_THINKING_DISPLAY_FLAG: ClaudeCliFlag = {
  option: '--thinking-display',
  firstVersion: '2.1.94'
}

// Why 2.0.25: 2.0.24's parser has no such option.
export const CLAUDE_PLUGIN_DIR_FLAG: ClaudeCliFlag = {
  option: '--plugin-dir',
  firstVersion: '2.0.25'
}

/** How long a launch waits on a binary nothing is known about yet. A warm probe answers in tens of
 *  milliseconds; this covers a cold disk, a node install and an antivirus scan, paid once per key
 *  during a start that already takes seconds. */
export const CLAUDE_CLI_FLAG_PROBE_BUDGET_MS = 1_500

/** A probe still running by now is killed, and its binary gets no flag. */
const PROBE_KILL_AFTER_MS = 10_000

/** How long a probe that gave no version (killed, failed to spawn, unparseable) means "no flag":
 *  long enough that a hung `--version` costs one wait per stretch, short enough that a failure
 *  from a loaded boot heals. */
const FAILED_PROBE_RETRY_AFTER_MS = 10 * 60_000

/** Commander's refusal, exactly: any other startup failure says nothing about a flag. */
const UNKNOWN_OPTION_DIAGNOSTIC = /unknown option '(--[a-z][a-z0-9-]*)'/

// One small entry per binary per workspace it launched in; enough for every worktree in active use.
const MAX_REMEMBERED = 32

export type ClaudeCliLaunch = {
  command: string
  cwd: string
  env: Record<string, string>
}

type ClaudeVersionProbe = (
  command: string,
  launch: { cwd: string; env: Record<string, string>; timeoutMs: number }
) => Promise<string | null>

export type ClaudeCliFlagSupport = {
  /**
   * Whether this launch's CLI takes `flag`. A binary not yet known is probed once for its version
   * with the launch's own cwd and env, waited on for at most the budget from when its probe began;
   * past it the answer is no. Every flag shares that one probe.
   */
  supports: (flag: ClaudeCliFlag, launch: ClaudeCliLaunch) => Promise<boolean>
  /** A child that exited refusing a flag: that binary, in that workspace, never gets it again. */
  observeExit: (launch: Pick<ClaudeCliLaunch, 'command' | 'cwd'>, error: Error) => void
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

/** `version` undefined: not known yet; null: a probe gave none, until `expiresAt`. */
type BinaryFacts = { version?: string | null; expiresAt?: number; refused: Set<string> }

export function createClaudeCliFlagSupport(
  deps: {
    probe: ClaudeVersionProbe
    keyOf: (command: string, cwd: string) => Promise<string | null>
    budgetMs: number
    now: () => number
  } = {
    probe: probeClaudeCliVersion,
    keyOf: claudeBinaryKey,
    budgetMs: CLAUDE_CLI_FLAG_PROBE_BUDGET_MS,
    now: () => performance.now()
  }
): ClaudeCliFlagSupport {
  const known = new Map<string, BinaryFacts>()
  const probing = new Map<string, { settled: Promise<void>; startedAt: number }>()
  /** The key's facts, marked most recently used; the bound drops the binaries launched least recently. */
  const touch = (key: string): BinaryFacts => {
    const facts = known.get(key) ?? { refused: new Set<string>() }
    known.delete(key)
    known.set(key, facts)
    for (const stale of known.keys()) {
      if (known.size <= MAX_REMEMBERED) {
        break
      }
      known.delete(stale)
    }
    return facts
  }
  // A version is kept for the binary's life. A probe that gave none is kept only for a while, so
  // a hung CLI costs one wait per stretch and a boot-time failure heals. A refusal outlives both.
  const settle = (key: string, version: string | null): void => {
    const facts = touch(key)
    facts.version = version
    if (version === null) {
      facts.expiresAt = deps.now() + FAILED_PROBE_RETRY_AFTER_MS
    } else {
      delete facts.expiresAt
    }
  }
  const versionOf = (key: string): string | null | undefined => {
    const facts = known.get(key)
    if (facts?.expiresAt !== undefined && facts.expiresAt <= deps.now()) {
      delete facts.version
      delete facts.expiresAt
    }
    return facts ? touch(key).version : undefined
  }
  const answer = (key: string, flag: ClaudeCliFlag): boolean => {
    const facts = known.get(key)
    return (
      facts?.version != null &&
      !facts.refused.has(flag.option) &&
      claudeVersionReaches(facts.version, flag.firstVersion)
    )
  }
  const probe = (key: string, launch: ClaudeCliLaunch) => {
    const settled = deps
      .probe(launch.command, { cwd: launch.cwd, env: launch.env, timeoutMs: PROBE_KILL_AFTER_MS })
      .then(
        (version) => settle(key, version),
        () => settle(key, null)
      )
      .finally(() => probing.delete(key))
    const started = { settled, startedAt: deps.now() }
    probing.set(key, started)
    return started
  }

  return {
    supports: async (flag, launch) => {
      // The launch never waits longer than the budget, finding the binary included.
      const deadline = deps.now() + deps.budgetMs
      const key = await within(deps.keyOf(launch.command, launch.cwd), deps.budgetMs)
      if (key === undefined || key === null) {
        return false
      }
      if (versionOf(key) !== undefined) {
        return answer(key, flag)
      }
      const running = probing.get(key) ?? probe(key, launch)
      // The probe's own budget, too: one already past it is not waited on again.
      await within(
        running.settled,
        Math.min(running.startedAt + deps.budgetMs, deadline) - deps.now()
      )
      return answer(key, flag)
    },
    observeExit: (launch, error) => {
      const option = UNKNOWN_OPTION_DIAGNOSTIC.exec(error.message)?.[1]
      if (!option) {
        return
      }
      void deps.keyOf(launch.command, launch.cwd).then((key) => {
        if (key !== null) {
          touch(key).refused.add(option)
        }
      })
    }
  }
}

/** One per process: every structured launch on this host shares what it learned. */
export const claudeCliFlagSupport = createClaudeCliFlagSupport()
