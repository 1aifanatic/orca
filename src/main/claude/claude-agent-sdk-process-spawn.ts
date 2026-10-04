import type { SpawnOptions as ClaudeAgentSdkSpawnOptions } from '@anthropic-ai/claude-agent-sdk'
import { spawnProcess } from '../../shared/child-process/run-process'
import {
  spawnManagedProviderProcess,
  type ManagedProviderProcess
} from '../provider-process/managed-provider-process'
import { claudeChildClosePolicy } from './claude-child-exit-proof-ladder'

/** Derived rather than imported: only src/shared/child-process may name node:child_process. */
type ClaudeCodeChild = ReturnType<typeof spawnProcess>

const STDERR_TAIL_MAX_BYTES = 8192

export type ClaudeCodeProcessSpawn = {
  /** Pass as the SDK's `spawnClaudeCodeProcess`; the SDK never learns the pid because it never owns it. */
  spawn: (options: ClaudeAgentSdkSpawnOptions) => ClaudeCodeChild
  /** The retained child, so Orca keeps its own tree-kill and exit-proof ladder. Null until the SDK spawns. */
  readonly child: ClaudeCodeChild | null
  readonly managed: ManagedProviderProcess | null
  /**
   * Ownership proof: the durable lease adjudicates on this pid plus start time plus the spawn
   * token. On POSIX it is the provider supervisor's, which outlives Claude by construction.
   */
  readonly pid: number | undefined
  /** The spawn spec's verdict, so the close ladder never re-decides it. False until the SDK spawns. */
  readonly supervised: boolean
  readonly stderrTail: string
}

function definedEnv(env: Record<string, string | undefined>): Record<string, string> {
  const next: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) {
      next[key] = value
    }
  }
  return next
}

/**
 * Orca supplies the Claude Code child rather than letting the SDK spawn it.
 *
 * Two independent reasons: the SDK's `SpawnedProcess` has no pid, and Orca's
 * spawner is the only path that encodes `.cmd` arguments safely on Windows.
 *
 * On POSIX Claude runs under the provider supervisor, so an Orca that dies stops
 * it instead of leaving it to finish its turn, tools and edits included, with
 * nobody watching. Windows has no supervisor and spawns Claude directly.
 */
export function createClaudeCodeProcessSpawn(
  spawnImpl: typeof spawnProcess = spawnProcess,
  platform: NodeJS.Platform = process.platform
): ClaudeCodeProcessSpawn {
  let managed: ManagedProviderProcess | null = null
  let stderrTail = ''
  return {
    spawn: (options) => {
      // The SDK's abort signal cannot bypass Orca's child-owned close.
      managed = spawnManagedProviderProcess(
        {
          command: options.command,
          args: [...options.args],
          ...(options.cwd === undefined ? {} : { cwd: options.cwd })
        },
        {
          spawnImpl,
          platform,
          inheritedEnv: definedEnv(options.env),
          site: 'claude-stream-json-teardown',
          policy: claudeChildClosePolicy
        }
      )
      const spawned = managed.child
      // The SDK drains stderr only for its own local spawn, so a custom spawner must:
      // otherwise the child blocks on a full pipe and exit errors lose their tail.
      spawned.stderr.setEncoding('utf8').on('data', (chunk: string) => {
        stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_MAX_BYTES)
      })
      return spawned
    },
    get child() {
      return managed?.child ?? null
    },
    get managed() {
      return managed
    },
    get pid() {
      return managed?.child.pid
    },
    get supervised() {
      return managed?.supervised ?? false
    },
    get stderrTail() {
      return stderrTail
    }
  }
}
