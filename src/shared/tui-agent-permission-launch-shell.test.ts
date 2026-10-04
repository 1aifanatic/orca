import { describe, expect, it } from 'vitest'
import { resolveTuiAgentLaunchArgs } from './tui-agent-launch-defaults'
import { resolveAgentPermissionPosture } from './tui-agent-permission-args'
import { cutTuiAgentBypassFlag, liftTuiAgentBypassArgs } from './tui-agent-bypass-lift'
import { PERMISSION_AGENT_IDS, YOLO_TUI_AGENT_ARGS } from './tui-agent-permissions'
import { resolveAgentLaunchGrammar, type AgentLaunchTarget } from './tui-agent-startup-shell'
import { resolveLocalAgentLaunchTarget } from './windows-terminal-shell'
import type { TuiAgent } from './tui-agent'

// Arguments are read with the shell that launches them: the Settings card and structured chat
// with this machine's terminal shell, each launch with its own target. These tests cover how the
// text is read, not the argv a shell then passes the agent.

const CLAUDE_BYPASS = '--dangerously-skip-permissions'
const CALLER = '--model per-launch'

const LOCAL_TARGETS: readonly [string, AgentLaunchTarget][] = [
  ['darwin', resolveLocalAgentLaunchTarget('darwin')],
  ['win32 PowerShell', resolveLocalAgentLaunchTarget('win32', 'powershell.exe')],
  ['win32 cmd', resolveLocalAgentLaunchTarget('win32', 'cmd.exe')]
]

/** The card's verdict and whether a launch that brings its own arguments adds the flag. */
function cardAndCallerLaunch(
  agent: TuiAgent,
  settings: {
    agentPermissionMode: 'bypass' | 'ask'
    agentDefaultArgs: Partial<Record<TuiAgent, string>>
  },
  target: AgentLaunchTarget
): { card: boolean; callerBypass: boolean } {
  return {
    card: resolveAgentPermissionPosture(agent, settings, target).effectiveBypass,
    callerBypass: resolveTuiAgentLaunchArgs(agent, settings, target, CALLER) !== CALLER
  }
}

describe('local launch targets', () => {
  it('resolve the shell each local launch uses', () => {
    expect(LOCAL_TARGETS.map(([, target]) => resolveAgentLaunchGrammar(target))).toEqual([
      'posix',
      'powershell',
      'cmd'
    ])
  })
})

// A Windows directory ending in `\` glues onto the next word only under POSIX. PowerShell passes
// such a path through intact. cmd is not tested with it: Orca's cmd quoting leaves the trailing
// backslash escaping its closing quote, so the agent never receives the option (follow-up ticket,
// "cmd launches lose the option after a Windows path ending in a backslash").
describe('Windows paths ending in a backslash', () => {
  const powershell = resolveLocalAgentLaunchTarget('win32', 'powershell.exe')
  const cmd = resolveLocalAgentLaunchTarget('win32', 'cmd.exe')

  it.each([
    ['claude', '--add-dir C:\\code\\ --permission-mode bypassPermissions'],
    ['codex', '--cd C:\\proj\\ --yolo'],
    ['gemini', '--include-directories C:\\code\\ -y'],
    ['gemini', '--include-directories C:\\code\\ --approval-mode yolo'],
    ['claude', '--add-dir "C:\\a\\" --permission-mode bypassPermissions --add-dir "C:\\b\\"']
  ] as const)('read %s %j as Yolo under PowerShell, on the card and in a launch', (agent, args) => {
    const settings = { agentPermissionMode: 'ask' as const, agentDefaultArgs: { [agent]: args } }
    expect(cardAndCallerLaunch(agent, settings, powershell)).toEqual({
      card: true,
      callerBypass: true
    })
  })

  it.each([
    ['claude', '--add-dir C:\\code --permission-mode bypassPermissions'],
    ['codex', '--cd C:\\proj --yolo'],
    ['gemini', '--include-directories C:\\code -y']
  ] as const)('read %s %j as Yolo under cmd, on the card and in a launch', (agent, args) => {
    const settings = { agentPermissionMode: 'ask' as const, agentDefaultArgs: { [agent]: args } }
    expect(cardAndCallerLaunch(agent, settings, cmd)).toEqual({ card: true, callerBypass: true })
  })
})

// The lift cuts only the flag's exact unquoted, unescaped words, so the cut means the same thing
// under every shell; an escaped spelling stays in the text and is read by the launch's shell.
describe('the lift and escaped flags', () => {
  it.each([
    `--model opus \`${CLAUDE_BYPASS}`,
    `--model opus \\${CLAUDE_BYPASS}`,
    `--model opus ^${CLAUDE_BYPASS}`
  ])('leaves %j in the text', (args) => {
    expect(cutTuiAgentBypassFlag('claude', args)).toBe(args)
    expect(liftTuiAgentBypassArgs('claude', args, LOCAL_TARGETS[0][1]).extraArgs).toBe(args)
  })

  // A cut must mean the same under every shell, so text any grammar reads differently stays whole.
  it.each([
    `--add-dir C:\\code\\ ${CLAUDE_BYPASS}`,
    `--append-system-prompt "Never run \\" ${CLAUDE_BYPASS} \\" yourself"`
  ])('leaves %j whole, since one grammar reads the flag inside another word', (args) => {
    expect(cutTuiAgentBypassFlag('claude', args)).toBe(args)
  })

  it('cuts the plain flag every grammar reads as its own word', () => {
    expect(cutTuiAgentBypassFlag('claude', `--model opus ${CLAUDE_BYPASS}`)).toBe('--model opus')
  })
})

// D1: a launch that brings its own arguments follows the card; read with the same target, they agree.
describe('card and caller-args launch agree on every local shell', () => {
  const agents = PERMISSION_AGENT_IDS.filter(
    (agent): agent is TuiAgent => YOLO_TUI_AGENT_ARGS[agent] !== undefined
  )
  const aliases: Partial<Record<TuiAgent, string[]>> = {
    claude: ['--permission-mode bypassPermissions', '--permission-mode acceptEdits'],
    codex: ['--yolo', '-a never -s danger-full-access', '-a on-request'],
    gemini: ['-y', '--approval-mode yolo'],
    'qwen-code': ['-y', '--yolo']
  }
  const inputs = (agent: TuiAgent): string[] =>
    [YOLO_TUI_AGENT_ARGS[agent] ?? '', ...(aliases[agent] ?? [])].flatMap((text) => [
      text,
      `^${text}`,
      `\`${text}`,
      `\\${text}`,
      `--model opus ^${text}`,
      `--add-dir C:\\code\\ ${text}`,
      `"${text}"`
    ])
  const rows = agents.flatMap((agent) =>
    inputs(agent).flatMap((args) =>
      (['bypass', 'ask'] as const).flatMap((mode) =>
        LOCAL_TARGETS.map(([name, target]) => [agent, args, mode, name, target] as const)
      )
    )
  )

  it.each(rows)('%s %j under %s on %s', (agent, args, mode, _name, target) => {
    const { card, callerBypass } = cardAndCallerLaunch(
      agent,
      { agentPermissionMode: mode, agentDefaultArgs: { [agent]: args } },
      target
    )
    expect(callerBypass).toBe(card)
  })
})

// Ordinary Arguments behave exactly as at b463a8fd5a2, on every local shell.
describe('ordinary Arguments are unchanged', () => {
  const ROWS: readonly [
    TuiAgent,
    string,
    'bypass' | 'ask',
    boolean,
    string,
    string,
    boolean,
    string
  ][] = [
    [
      'claude',
      '--model opus',
      'bypass',
      true,
      '--dangerously-skip-permissions --model opus',
      '--dangerously-skip-permissions --model x',
      false,
      '--model opus'
    ],
    ['claude', '--model opus', 'ask', false, '--model opus', '--model x', false, '--model opus'],
    [
      'claude',
      '--permission-mode acceptEdits',
      'bypass',
      false,
      '--permission-mode acceptEdits',
      '--model x',
      false,
      '--permission-mode acceptEdits'
    ],
    [
      'claude',
      '--permission-mode acceptEdits',
      'ask',
      false,
      '--permission-mode acceptEdits',
      '--model x',
      false,
      '--permission-mode acceptEdits'
    ],
    [
      'claude',
      '--permission-mode bypassPermissions',
      'bypass',
      true,
      '--permission-mode bypassPermissions',
      '--dangerously-skip-permissions --model x',
      true,
      '--permission-mode bypassPermissions'
    ],
    [
      'claude',
      '--permission-mode bypassPermissions',
      'ask',
      true,
      '--permission-mode bypassPermissions',
      '--dangerously-skip-permissions --model x',
      true,
      '--permission-mode bypassPermissions'
    ],
    [
      'claude',
      '--permission-mode=bypassPermissions',
      'bypass',
      true,
      '--permission-mode=bypassPermissions',
      '--dangerously-skip-permissions --model x',
      true,
      '--permission-mode=bypassPermissions'
    ],
    [
      'claude',
      '--permission-mode=bypassPermissions',
      'ask',
      true,
      '--permission-mode=bypassPermissions',
      '--dangerously-skip-permissions --model x',
      true,
      '--permission-mode=bypassPermissions'
    ],
    [
      'claude',
      '--model opus --dangerously-skip-permissions',
      'bypass',
      true,
      '--model opus --dangerously-skip-permissions',
      '--dangerously-skip-permissions --model x',
      true,
      '--model opus'
    ],
    [
      'claude',
      '--model opus --dangerously-skip-permissions',
      'ask',
      true,
      '--model opus --dangerously-skip-permissions',
      '--dangerously-skip-permissions --model x',
      true,
      '--model opus'
    ],
    [
      'claude',
      '--append-system-prompt "be brief and safe" --permission-mode bypassPermissions',
      'bypass',
      true,
      '--append-system-prompt "be brief and safe" --permission-mode bypassPermissions',
      '--dangerously-skip-permissions --model x',
      true,
      '--append-system-prompt "be brief and safe" --permission-mode bypassPermissions'
    ],
    [
      'claude',
      '--append-system-prompt "be brief and safe" --permission-mode bypassPermissions',
      'ask',
      true,
      '--append-system-prompt "be brief and safe" --permission-mode bypassPermissions',
      '--dangerously-skip-permissions --model x',
      true,
      '--append-system-prompt "be brief and safe" --permission-mode bypassPermissions'
    ],
    [
      'claude',
      "--append-system-prompt 'be brief and safe' --permission-mode bypassPermissions",
      'bypass',
      true,
      "--append-system-prompt 'be brief and safe' --permission-mode bypassPermissions",
      '--dangerously-skip-permissions --model x',
      true,
      "--append-system-prompt 'be brief and safe' --permission-mode bypassPermissions"
    ],
    [
      'claude',
      "--append-system-prompt 'be brief and safe' --permission-mode bypassPermissions",
      'ask',
      true,
      "--append-system-prompt 'be brief and safe' --permission-mode bypassPermissions",
      '--dangerously-skip-permissions --model x',
      true,
      "--append-system-prompt 'be brief and safe' --permission-mode bypassPermissions"
    ],
    [
      'claude',
      "--permission-mode 'bypassPermissions'",
      'bypass',
      true,
      "--permission-mode 'bypassPermissions'",
      '--dangerously-skip-permissions --model x',
      true,
      "--permission-mode 'bypassPermissions'"
    ],
    [
      'claude',
      "--permission-mode 'bypassPermissions'",
      'ask',
      true,
      "--permission-mode 'bypassPermissions'",
      '--dangerously-skip-permissions --model x',
      true,
      "--permission-mode 'bypassPermissions'"
    ],
    [
      'claude',
      '--permission-mode "bypassPermissions"',
      'bypass',
      true,
      '--permission-mode "bypassPermissions"',
      '--dangerously-skip-permissions --model x',
      true,
      '--permission-mode "bypassPermissions"'
    ],
    [
      'claude',
      '--permission-mode "bypassPermissions"',
      'ask',
      true,
      '--permission-mode "bypassPermissions"',
      '--dangerously-skip-permissions --model x',
      true,
      '--permission-mode "bypassPermissions"'
    ],
    [
      'claude',
      '--add-dir ~/My\\ Code --permission-mode bypassPermissions',
      'bypass',
      true,
      '--add-dir ~/My\\ Code --permission-mode bypassPermissions',
      '--dangerously-skip-permissions --model x',
      true,
      '--add-dir ~/My\\ Code --permission-mode bypassPermissions'
    ],
    [
      'claude',
      '--add-dir ~/My\\ Code --permission-mode bypassPermissions',
      'ask',
      true,
      '--add-dir ~/My\\ Code --permission-mode bypassPermissions',
      '--dangerously-skip-permissions --model x',
      true,
      '--add-dir ~/My\\ Code --permission-mode bypassPermissions'
    ],
    [
      'claude',
      '--add-dir C:\\Users\\me\\code --permission-mode bypassPermissions',
      'bypass',
      true,
      '--add-dir C:\\Users\\me\\code --permission-mode bypassPermissions',
      '--dangerously-skip-permissions --model x',
      true,
      '--add-dir C:\\Users\\me\\code --permission-mode bypassPermissions'
    ],
    [
      'claude',
      '--add-dir C:\\Users\\me\\code --permission-mode bypassPermissions',
      'ask',
      true,
      '--add-dir C:\\Users\\me\\code --permission-mode bypassPermissions',
      '--dangerously-skip-permissions --model x',
      true,
      '--add-dir C:\\Users\\me\\code --permission-mode bypassPermissions'
    ],
    [
      'codex',
      '-a on-request',
      'bypass',
      false,
      '-a on-request',
      '--model x',
      false,
      '-a on-request'
    ],
    ['codex', '-a on-request', 'ask', false, '-a on-request', '--model x', false, '-a on-request'],
    [
      'codex',
      '-a never -s danger-full-access',
      'bypass',
      true,
      '-a never -s danger-full-access',
      '--dangerously-bypass-approvals-and-sandbox --model x',
      true,
      '-a never -s danger-full-access'
    ],
    [
      'codex',
      '-a never -s danger-full-access',
      'ask',
      true,
      '-a never -s danger-full-access',
      '--dangerously-bypass-approvals-and-sandbox --model x',
      true,
      '-a never -s danger-full-access'
    ],
    [
      'codex',
      '--sandbox danger-full-access --ask-for-approval never',
      'bypass',
      true,
      '--sandbox danger-full-access --ask-for-approval never',
      '--dangerously-bypass-approvals-and-sandbox --model x',
      true,
      '--sandbox danger-full-access --ask-for-approval never'
    ],
    [
      'codex',
      '--sandbox danger-full-access --ask-for-approval never',
      'ask',
      true,
      '--sandbox danger-full-access --ask-for-approval never',
      '--dangerously-bypass-approvals-and-sandbox --model x',
      true,
      '--sandbox danger-full-access --ask-for-approval never'
    ],
    [
      'codex',
      '--yolo',
      'bypass',
      true,
      '--yolo',
      '--dangerously-bypass-approvals-and-sandbox --model x',
      true,
      '--yolo'
    ],
    [
      'codex',
      '--yolo',
      'ask',
      true,
      '--yolo',
      '--dangerously-bypass-approvals-and-sandbox --model x',
      true,
      '--yolo'
    ],
    [
      'codex',
      '--model "gpt 5" --yolo',
      'bypass',
      true,
      '--model "gpt 5" --yolo',
      '--dangerously-bypass-approvals-and-sandbox --model x',
      true,
      '--model "gpt 5" --yolo'
    ],
    [
      'codex',
      '--model "gpt 5" --yolo',
      'ask',
      true,
      '--model "gpt 5" --yolo',
      '--dangerously-bypass-approvals-and-sandbox --model x',
      true,
      '--model "gpt 5" --yolo'
    ],
    [
      'codex',
      '-c \'model_reasoning_effort="high"\' --yolo',
      'bypass',
      true,
      '-c \'model_reasoning_effort="high"\' --yolo',
      '--dangerously-bypass-approvals-and-sandbox --model x',
      true,
      '-c \'model_reasoning_effort="high"\' --yolo'
    ],
    [
      'codex',
      '-c \'model_reasoning_effort="high"\' --yolo',
      'ask',
      true,
      '-c \'model_reasoning_effort="high"\' --yolo',
      '--dangerously-bypass-approvals-and-sandbox --model x',
      true,
      '-c \'model_reasoning_effort="high"\' --yolo'
    ],
    ['gemini', '-y', 'bypass', true, '-y', '--yolo --model x', true, '-y'],
    ['gemini', '-y', 'ask', true, '-y', '--yolo --model x', true, '-y'],
    ['gemini', '--yolo', 'bypass', true, '--yolo', '--yolo --model x', true, ''],
    ['gemini', '--yolo', 'ask', true, '--yolo', '--yolo --model x', true, ''],
    [
      'gemini',
      '--approval-mode yolo',
      'bypass',
      true,
      '--approval-mode yolo',
      '--yolo --model x',
      true,
      '--approval-mode yolo'
    ],
    [
      'gemini',
      '--approval-mode yolo',
      'ask',
      true,
      '--approval-mode yolo',
      '--yolo --model x',
      true,
      '--approval-mode yolo'
    ],
    [
      'gemini',
      '--model gemini-2.5-pro',
      'bypass',
      true,
      '--yolo --model gemini-2.5-pro',
      '--yolo --model x',
      false,
      '--model gemini-2.5-pro'
    ],
    [
      'gemini',
      '--model gemini-2.5-pro',
      'ask',
      false,
      '--model gemini-2.5-pro',
      '--model x',
      false,
      '--model gemini-2.5-pro'
    ],
    [
      'qwen-code',
      '--yolo',
      'bypass',
      true,
      '--yolo',
      '--approval-mode yolo --model x',
      true,
      '--yolo'
    ],
    ['qwen-code', '--yolo', 'ask', true, '--yolo', '--approval-mode yolo --model x', true, '--yolo']
  ]

  it.each(ROWS)(
    '%s %j under %s',
    (agent, args, mode, card, plain, caller, liftBypass, liftExtra) => {
      const settings = { agentPermissionMode: mode, agentDefaultArgs: { [agent]: args } }
      for (const [, target] of LOCAL_TARGETS) {
        expect(resolveAgentPermissionPosture(agent, settings, target).effectiveBypass).toBe(card)
        expect(resolveTuiAgentLaunchArgs(agent, settings, target)).toBe(plain)
        expect(resolveTuiAgentLaunchArgs(agent, settings, target, '--model x')).toBe(caller)
        expect(liftTuiAgentBypassArgs(agent, args, target)).toEqual({
          bypass: liftBypass,
          extraArgs: liftExtra
        })
      }
    }
  )
})
