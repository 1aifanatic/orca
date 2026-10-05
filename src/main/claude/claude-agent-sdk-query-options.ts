import type { Options } from '@anthropic-ai/claude-agent-sdk'
import type {
  ClaudeStructuredInvocation,
  ClaudeStructuredSdkOptions
} from './claude-structured-launch-resolution'
import type { ClaudeCodeProcessSpawn } from './claude-agent-sdk-process-spawn'
import { buildClaudeChildProcessEnv } from './claude-child-process-environment'
import { withoutInheritedClaudeConfigDir } from './claude-config-dir-pin'

export type ClaudeStreamJsonLaunch = {
  /** Orca's resolved user CLI; the SDK falls back to a bundled binary that is not installed. */
  pathToClaudeCodeExecutable: string
  invocation?: ClaudeStructuredInvocation
  options: ClaudeStructuredSdkOptions
  cwd: string
  env?: Record<string, string>
}

export function claudeAgentSdkQueryOptions(
  launch: ClaudeStreamJsonLaunch,
  spawn: ClaudeCodeProcessSpawn['spawn'],
  handlers: Pick<Options, 'canUseTool' | 'onUserDialog'>
): Options {
  return {
    ...launch.options,
    cwd: launch.cwd,
    // Never let the SDK inherit ambient auth or replace the record's pinned account home.
    env: buildClaudeChildProcessEnv(launch.env, {
      inheritedEnv: withoutInheritedClaudeConfigDir(process.env),
      scrubConfiguredChildSessionStamps: true
    }),
    pathToClaudeCodeExecutable: launch.pathToClaudeCodeExecutable,
    spawnClaudeCodeProcess: spawn,
    ...(handlers.canUseTool ? { canUseTool: handlers.canUseTool } : {}),
    ...(handlers.onUserDialog ? { onUserDialog: handlers.onUserDialog } : {})
  }
}
