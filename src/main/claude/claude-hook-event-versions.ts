import { hasReachedAppVersion, isValidAppVersion } from '../../shared/app-version'
import { runProcess } from '../../shared/child-process/run-process'
import path from 'node:path'

// Why: Claude 1.0.81 through 2.1.100 validate `hooks` against a closed event enum and discard the
// WHOLE settings.json (env, permissions, every user hook) on one unknown name, so an event may only
// be written for a Claude that knows it. Values come from each release's packed enum, pinned by
// __fixtures__/claude-hook-event-enums.json.
export const CLAUDE_HOOK_EVENT_TABLE_FLOOR = '1.0.81'

export const CLAUDE_HOOK_EVENT_FIRST_VERSIONS = {
  SessionStart: CLAUDE_HOOK_EVENT_TABLE_FLOOR,
  UserPromptSubmit: CLAUDE_HOOK_EVENT_TABLE_FLOOR,
  Stop: CLAUDE_HOOK_EVENT_TABLE_FLOOR,
  SubagentStop: CLAUDE_HOOK_EVENT_TABLE_FLOOR,
  PreToolUse: CLAUDE_HOOK_EVENT_TABLE_FLOOR,
  PostToolUse: CLAUDE_HOOK_EVENT_TABLE_FLOOR,
  SessionEnd: '1.0.85',
  SubagentStart: '2.0.43',
  PermissionRequest: '2.0.45',
  PostToolUseFailure: '2.0.56',
  TeammateIdle: '2.1.33',
  PostCompact: '2.1.76',
  StopFailure: '2.1.78'
} as const

export type ClaudeHookEventName = keyof typeof CLAUDE_HOOK_EVENT_FIRST_VERSIONS

export function parseClaudeCliVersion(output: string | null | undefined): string | null {
  const version = output?.match(/\b\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?\b/)?.[0]
  return version && isValidAppVersion(version) ? version : null
}

export function claudeVersionReaches(version: string | null | undefined, floor: string): boolean {
  const parsed = parseClaudeCliVersion(version)
  return parsed !== null && hasReachedAppVersion(parsed, floor)
}

// Why: an unresolved version gets only the events every Claude in the table knows.
export function claudeKnowsHookEvent(
  version: string | null | undefined,
  eventName: ClaudeHookEventName
): boolean {
  const firstVersion = CLAUDE_HOOK_EVENT_FIRST_VERSIONS[eventName]
  return (
    firstVersion === CLAUDE_HOOK_EVENT_TABLE_FLOOR || claudeVersionReaches(version, firstVersion)
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
