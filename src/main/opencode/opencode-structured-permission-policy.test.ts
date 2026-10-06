import { describe, expect, it } from 'vitest'
import {
  openCodeChildPermissionRules,
  openCodeStructuredPermissionRules
} from './opencode-structured-permission-policy'
import type { OpenCodePermissionRule } from './serve/native-protocol'

describe('OpenCode child permissions', () => {
  it('replaces v1 inherited deny seeds while retaining native child restrictions', () => {
    const parentRules = openCodeStructuredPermissionRules(false)
    const nestedTasks: OpenCodePermissionRule = { permission: 'task', pattern: '*', action: 'deny' }
    const childRules = [
      ...parentRules.filter(
        (rule) => rule.action === 'deny' || rule.permission === 'external_directory'
      ),
      nestedTasks
    ]
    const restored = openCodeChildPermissionRules({ major: 1, parentRules, childRules })
    expect(restored).toEqual([...parentRules, nestedTasks])
    expect(restored.findLast((rule) => rule.permission === 'bash')?.action).toBe('ask')
    expect(restored.findLast((rule) => rule.permission === 'task')?.action).toBe('deny')
  })

  it('preserves complete v2 inheritance and child-specific restrictions without duplicating it', () => {
    const parentRules = openCodeStructuredPermissionRules(false)
    const childSpecific: OpenCodePermissionRule = {
      permission: 'edit',
      pattern: '/restricted/*',
      action: 'deny'
    }
    expect(
      openCodeChildPermissionRules({
        major: 2,
        parentRules,
        childRules: [...parentRules, childSpecific]
      })
    ).toEqual([...parentRules, childSpecific])
  })
})
