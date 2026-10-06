import type { GlobalSettings } from '../../shared/global-settings-types'
import { resolveAgentPermissionModeSummary } from '../../shared/tui-agent-permissions'
import type { OpenCodePermissionRule } from './serve/native-protocol'

const RESTRICTED = [
  'bash',
  'edit',
  'webfetch',
  'websearch',
  'codesearch',
  'external_directory',
  'doom_loop'
]
const READ_AND_PLAN = ['question', 'read', 'glob', 'grep', 'lsp', 'todowrite', 'task', 'skill']

/** Deny seeds survive native child inheritance until its complete parent policy is installed. */
export function openCodeStructuredPermissionRules(fullAccess: boolean): OpenCodePermissionRule[] {
  if (fullAccess) {
    return [{ permission: '*', pattern: '*', action: 'allow' }]
  }
  return [
    { permission: '*', pattern: '*', action: 'deny' },
    ...RESTRICTED.map((permission): OpenCodePermissionRule => ({
      permission,
      pattern: '*',
      action: 'deny'
    })),
    { permission: '*', pattern: '*', action: 'ask' },
    ...RESTRICTED.map((permission): OpenCodePermissionRule => ({
      permission,
      pattern: '*',
      action: 'ask'
    })),
    ...READ_AND_PLAN.map((permission): OpenCodePermissionRule => ({
      permission,
      pattern: '*',
      action: 'allow'
    })),
    { permission: 'read', pattern: '*.env', action: 'ask' },
    { permission: 'read', pattern: '*.env.*', action: 'ask' },
    { permission: 'read', pattern: '*.env.example', action: 'allow' }
  ]
}

export function openCodeStructuredPermissionRulesForSettings(
  settings: Partial<Pick<GlobalSettings, 'agentDefaultArgs' | 'agentDefaultEnv'>> | null | undefined
): OpenCodePermissionRule[] {
  return openCodeStructuredPermissionRules(
    resolveAgentPermissionModeSummary({
      agentDefaultArgs: settings?.agentDefaultArgs,
      agentDefaultEnv: settings?.agentDefaultEnv
    }) === 'yolo'
  )
}

/** Keep native child restrictions after replacing its incomplete inherited policy. */
export function openCodeChildPermissionRules(input: {
  major: 1 | 2
  parentRules: readonly OpenCodePermissionRule[]
  childRules: readonly OpenCodePermissionRule[]
}): OpenCodePermissionRule[] {
  const inherited =
    input.major === 1
      ? input.parentRules.filter(
          (rule) => rule.action === 'deny' || rule.permission === 'external_directory'
        )
      : input.parentRules
  const childSpecific = input.childRules.filter(
    (child) =>
      !inherited.some(
        (parent) =>
          parent.permission === child.permission &&
          parent.pattern === child.pattern &&
          parent.action === child.action
      )
  )
  return [...input.parentRules, ...childSpecific]
}

export function openCodeChatGrantRules(
  current: readonly OpenCodePermissionRule[],
  request: { permission: string; patterns: readonly string[]; always: readonly string[] }
): OpenCodePermissionRule[] {
  const patterns = request.always.length ? request.always : request.patterns
  if (!patterns.length || current.length + patterns.length > 256) {
    throw new Error('OpenCode chat permission cannot be saved within its policy limit')
  }
  return [
    ...current,
    ...patterns.map((pattern): OpenCodePermissionRule => ({
      permission: request.permission,
      pattern,
      action: 'allow'
    }))
  ]
}
