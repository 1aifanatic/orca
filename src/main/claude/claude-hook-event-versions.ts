import { hasReachedAppVersion, isValidAppVersion } from '../../shared/app-version'
import { runProcess } from '../../shared/child-process/run-process'
import path from 'node:path'

// Why: Claude 1.0.23 through 2.1.100 validate `hooks` against a closed event enum and discard the
// WHOLE settings.json (env, permissions, every user hook) on one unknown name, so an event may only
// be written for a Claude that knows it. Values come from each release's packed enum, pinned by
// __fixtures__/claude-hook-event-enums.json.
export const CLAUDE_HOOK_EVENT_FIRST_VERSIONS = {
  PreToolUse: '1.0.23',
  PostToolUse: '1.0.23',
  Stop: '1.0.31',
  SubagentStop: '1.0.41',
  UserPromptSubmit: '1.0.53',
  SessionStart: '1.0.62',
  SessionEnd: '1.0.85',
  SubagentStart: '2.0.43',
  PermissionRequest: '2.0.45',
  PostToolUseFailure: '2.0.56',
  TeammateIdle: '2.1.33',
  PostCompact: '2.1.76',
  StopFailure: '2.1.78'
} as const

// Why: an unresolved version gets Orca's core lifecycle events, all known by SessionStart's release,
// and nothing newer; a Claude older than that is gated only once its version resolves.
export const UNRESOLVED_CLAUDE_VERSION = CLAUDE_HOOK_EVENT_FIRST_VERSIONS.SessionStart

export type ClaudeHookEventName = keyof typeof CLAUDE_HOOK_EVENT_FIRST_VERSIONS

export function parseClaudeCliVersion(output: string | null | undefined): string | null {
  const version = output?.match(/\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?\b/)?.[0]
  return version && isValidAppVersion(version) ? version : null
}

export function claudeVersionReaches(version: string | null | undefined, floor: string): boolean {
  const parsed = parseClaudeCliVersion(version)
  return parsed !== null && hasReachedAppVersion(parsed, floor)
}

export function claudeKnowsHookEvent(
  version: string | null | undefined,
  eventName: ClaudeHookEventName
): boolean {
  return hasReachedAppVersion(
    parseClaudeCliVersion(version) ?? UNRESOLVED_CLAUDE_VERSION,
    CLAUDE_HOOK_EVENT_FIRST_VERSIONS[eventName]
  )
}

export async function probeClaudeCliVersion(executablePath: string): Promise<string | null> {
  try {
    const pathKey = process.platform === 'win32' && process.env.Path !== undefined ? 'Path' : 'PATH'
    const executableDir = path.dirname(executablePath)
    const inheritedPath = process.env[pathKey]
    const result = await runProcess({
      program: executablePath,
      args: ['--version'],
      // Why: version-manager launchers often use `#!/usr/bin/env node`; the resolved CLI's sibling
      // runtime must remain reachable even when Electron started with a thinner PATH.
      env: {
        ...process.env,
        [pathKey]: inheritedPath
          ? `${executableDir}${path.delimiter}${inheritedPath}`
          : executableDir
      },
      timeoutMs: 5_000,
      maxOutputBytes: 4_096
    })
    return result.code === 0 ? parseClaudeCliVersion(`${result.stdout}\n${result.stderr}`) : null
  } catch {
    return null
  }
}
