import { describe, expect, it } from 'vitest'
import { AGENT_CHAT_PERMISSION_MODES } from './agent-chat-permission-mode'
import {
  PERMISSION_AGENT_IDS,
  YOLO_TUI_AGENT_ARGS,
  YOLO_TUI_AGENT_ENV
} from './tui-agent-permissions'
import { resolveTuiAgentLaunchArgs, resolveTuiAgentLaunchEnv } from './tui-agent-launch-defaults'
import { resolveAgentLaunchGrammar, tokenizeStartupCommand } from './tui-agent-startup-shell'
import { resolveAgentStartupPlanInputs } from './agent-startup-plan-inputs'

const TARGETS = [
  { platform: 'darwin' },
  { platform: 'linux' },
  { platform: 'win32', shell: 'powershell' },
  { platform: 'win32', shell: 'cmd' },
  { platform: 'win32', shell: 'posix' }
] as const

describe('permission mode terminal mapping', () => {
  for (const agent of PERMISSION_AGENT_IDS) {
    it.each(AGENT_CHAT_PERMISSION_MODES)(
      `${agent} maps %s without granting more access`,
      (mode) => {
        const expected =
          mode === 'bypass'
            ? (YOLO_TUI_AGENT_ARGS[agent] ?? '')
            : agent === 'claude' && mode === 'accept-edits'
              ? '--permission-mode acceptEdits'
              : agent === 'claude' && mode === 'auto'
                ? '--permission-mode auto'
                : agent === 'codex' && mode === 'auto'
                  ? '-a on-request -s workspace-write -c approvals_reviewer=auto_review'
                  : ''
        for (const target of TARGETS) {
          const settings = { agentPermissionMode: mode }
          expect(resolveTuiAgentLaunchArgs(agent, settings, target)).toBe(expected)
          expect(resolveTuiAgentLaunchArgs(agent, settings, target, '--model custom')).toBe(
            [expected, '--model custom'].filter(Boolean).join(' ')
          )
          expect(resolveTuiAgentLaunchEnv(agent, settings)).toEqual(
            mode === 'bypass' ? (YOLO_TUI_AGENT_ENV[agent] ?? {}) : {}
          )
        }
      }
    )
  }

  it('keeps typed and caller permission choices ahead of intermediate settings', () => {
    for (const target of TARGETS) {
      expect(
        resolveTuiAgentLaunchArgs(
          'claude',
          {
            agentPermissionMode: 'auto',
            agentDefaultArgs: { claude: '--permission-mode plan' }
          },
          target,
          '--model custom'
        )
      ).toBe('--model custom')
      expect(
        resolveTuiAgentLaunchArgs(
          'codex',
          { agentPermissionMode: 'bypass' },
          target,
          '--approve-for-me'
        )
      ).toBe('--approve-for-me')
      expect(
        resolveTuiAgentLaunchArgs(
          'codex',
          { agentPermissionMode: 'auto' },
          target,
          '-a never -s read-only'
        )
      ).toBe('-a never -s read-only')
    }
  })

  it('uses legacy permission options so an older host never adds bypass', () => {
    for (const target of TARGETS) {
      for (const agent of ['claude', 'codex'] as const) {
        const args = resolveTuiAgentLaunchArgs(agent, { agentPermissionMode: 'auto' }, target)
        const tokens = tokenizeStartupCommand(args, resolveAgentLaunchGrammar(target))
        expect(tokens.ok && tokens.tokens).toContain(
          agent === 'claude' ? '--permission-mode' : '-a'
        )
        expect(
          resolveTuiAgentLaunchArgs(agent, { agentPermissionMode: 'bypass' }, target, args)
        ).toBe(args)
      }
    }
  })

  it('keeps client-composed arguments and stricter empty fallbacks at the host boundary', () => {
    for (const agent of PERMISSION_AGENT_IDS) {
      for (const mode of ['accept-edits', 'auto'] as const) {
        for (const target of TARGETS) {
          const agentArgs = resolveTuiAgentLaunchArgs(agent, { agentPermissionMode: mode }, target)
          const inputs = resolveAgentStartupPlanInputs({
            agent,
            agentArgs,
            settings: { agentPermissionMode: 'bypass' },
            platform: target.platform,
            isRemote: true
          })
          expect(inputs.agentArgs).toBe(agentArgs)
        }
      }
    }
  })
})
