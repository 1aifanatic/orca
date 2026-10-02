import { describe, expect, it } from 'vitest'
import {
  composeTuiAgentLaunchArgsRecord,
  resolveComposedTuiAgentLaunchArgs,
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from './tui-agent-launch-defaults'
import {
  liftTuiAgentBypassArgs,
  liftTuiAgentBypassEnv,
  resolveAgentPermissionPosture
} from './tui-agent-permission-args'

const CLAUDE_BYPASS = '--dangerously-skip-permissions'
const CODEX_BYPASS = '--dangerously-bypass-approvals-and-sandbox'

describe('resolveTuiAgentLaunchArgs', () => {
  it('puts the bypass flag in front of the extra arguments in Yolo', () => {
    expect(
      resolveTuiAgentLaunchArgs('claude', { agentDefaultArgs: { claude: '--model opus' } })
    ).toBe(`${CLAUDE_BYPASS} --model opus`)
    expect(resolveTuiAgentLaunchArgs('claude', {})).toBe(CLAUDE_BYPASS)
  })

  // The bug behind #23853: custom Arguments used to *be* the permission setting, so typing a model
  // into them silently turned Yolo off while the switch still read Yolo.
  it('keeps the flag when the user adds their own arguments', () => {
    expect(
      resolveTuiAgentLaunchArgs('claude', {
        agentPermissionMode: 'bypass',
        agentDefaultArgs: { claude: '--model opus' }
      })
    ).toContain(CLAUDE_BYPASS)
  })

  it('leaves the flag off in Manual, globally or for one agent', () => {
    expect(
      resolveTuiAgentLaunchArgs('claude', {
        agentPermissionMode: 'ask',
        agentDefaultArgs: { claude: '--model opus' }
      })
    ).toBe('--model opus')
    expect(
      resolveTuiAgentLaunchArgs('codex', {
        agentPermissionMode: 'bypass',
        agentPermissionModeOverrides: { codex: 'ask' }
      })
    ).toBe('')
    expect(
      resolveTuiAgentLaunchArgs('claude', {
        agentPermissionMode: 'ask',
        agentPermissionModeOverrides: { claude: 'bypass' }
      })
    ).toBe(CLAUDE_BYPASS)
  })

  it('does not repeat a flag the extra arguments already carry', () => {
    expect(
      resolveTuiAgentLaunchArgs('codex', { agentDefaultArgs: { codex: `-m o3 ${CODEX_BYPASS}` } })
    ).toBe(`-m o3 ${CODEX_BYPASS}`)
  })

  // Codex refuses its bypass flag beside `-a`, so typed permission options decide on their own.
  it('lets permission options typed into the arguments decide instead of the mode', () => {
    expect(
      resolveTuiAgentLaunchArgs('codex', { agentDefaultArgs: { codex: '-a on-request' } })
    ).toBe('-a on-request')
    expect(resolveTuiAgentLaunchArgs('claude', {}, '--permission-mode plan')).toBe(
      '--permission-mode plan'
    )
    expect(
      resolveTuiAgentLaunchArgs('claude', {}, '--append-system-prompt "--permission-mode plan"')
    ).toBe(`${CLAUDE_BYPASS} --append-system-prompt "--permission-mode plan"`)
  })

  it.each([
    ['gemini', '--approval-mode auto_edit'],
    ['qwen-code', '-y'],
    ['codex', '-anever'],
    ['codex', '-sread-only'],
    ['devin', '--respect-workspace-trust true']
  ] as const)('adds no flag beside %s permission text %j', (agent, args) => {
    expect(resolveTuiAgentLaunchArgs(agent, { agentDefaultArgs: { [agent]: args } })).toBe(args)
  })

  // One settings string reaches POSIX, PowerShell and cmd hosts.
  it('treats an option any launch grammar sees as setting permissions', () => {
    expect(resolveTuiAgentLaunchArgs('codex', { agentDefaultArgs: { codex: '^-a never' } })).toBe(
      '^-a never'
    )
  })

  it('applies the mode to per-launch extra arguments, and null means none', () => {
    const settings = { agentDefaultArgs: { codex: '--model stored' } }
    expect(resolveTuiAgentLaunchArgs('codex', settings, '--model recipe')).toBe(
      `${CODEX_BYPASS} --model recipe`
    )
    expect(resolveTuiAgentLaunchArgs('codex', settings, null)).toBe(CODEX_BYPASS)
    expect(resolveTuiAgentLaunchArgs('codex', settings, undefined)).toBe(
      `${CODEX_BYPASS} --model stored`
    )
  })

  it('passes arguments through for an agent with no bypass flag', () => {
    expect(resolveTuiAgentLaunchArgs('pi', { agentDefaultArgs: { pi: '--foo' } })).toBe('--foo')
  })
})

describe('resolveTuiAgentLaunchEnv', () => {
  it('applies an env-driven bypass under the user env in Yolo only', () => {
    expect(resolveTuiAgentLaunchEnv('goose', { agentDefaultEnv: { goose: { A: '1' } } })).toEqual({
      GOOSE_MODE: 'auto',
      A: '1'
    })
    expect(
      resolveTuiAgentLaunchEnv('goose', {
        agentPermissionMode: 'ask',
        agentDefaultEnv: { goose: { A: '1' } }
      })
    ).toEqual({ A: '1' })
  })
})

describe('liftTuiAgentBypassArgs', () => {
  it.each([
    [CLAUDE_BYPASS, true, ''],
    [`${CLAUDE_BYPASS} --model Opus`, true, '--model Opus'],
    [`--model Opus ${CLAUDE_BYPASS}`, true, '--model Opus'],
    [`--model Opus ${CLAUDE_BYPASS} --effort high`, true, '--model Opus --effort high'],
    [`${CLAUDE_BYPASS} ${CLAUDE_BYPASS}`, true, ''],
    ['', false, ''],
    ['--model Opus', false, '--model Opus'],
    [`${CLAUDE_BYPASS}-not-really`, false, `${CLAUDE_BYPASS}-not-really`],
    [
      `--append-system-prompt "mention ${CLAUDE_BYPASS} only as text"`,
      false,
      `--append-system-prompt "mention ${CLAUDE_BYPASS} only as text"`
    ],
    [`-- ${CLAUDE_BYPASS}`, false, `-- ${CLAUDE_BYPASS}`],
    // The rest of the text keeps its own quoting byte for byte.
    [
      `${CLAUDE_BYPASS} --append-system-prompt 'be "brief"'`,
      true,
      `--append-system-prompt 'be "brief"'`
    ]
  ] as const)('lifts claude %j to bypass=%s with %j left', (args, bypass, extraArgs) => {
    expect(liftTuiAgentBypassArgs('claude', args)).toEqual({ bypass, extraArgs })
  })

  // Lossless: a launch adds no flag beside text that sets permissions, so the flag must stay in it.
  it('keeps the flag in text that also sets permissions another way', () => {
    expect(liftTuiAgentBypassArgs('claude', `${CLAUDE_BYPASS} --permission-mode plan`)).toEqual({
      bypass: true,
      extraArgs: `${CLAUDE_BYPASS} --permission-mode plan`
    })
  })

  // The POSIX grammar cannot parse a Windows path ending in a backslash before its closing quote.
  it('lifts the flag from Windows-quoted text', () => {
    expect(
      liftTuiAgentBypassArgs('claude', `${CLAUDE_BYPASS} --add-dir "C:\\Users\\me\\"`)
    ).toEqual({
      bypass: true,
      extraArgs: '--add-dir "C:\\Users\\me\\"'
    })
  })

  // POSIX parses this but reads the backslash as escaping the space, hiding the flag.
  it('lifts the flag after a Windows path that POSIX mis-splits', () => {
    expect(liftTuiAgentBypassArgs('claude', `--settings C:\\cfg\\ ${CLAUDE_BYPASS}`)).toEqual({
      bypass: true,
      extraArgs: '--settings C:\\cfg\\'
    })
  })

  it('lifts a multi-word bypass flag only as a whole', () => {
    expect(liftTuiAgentBypassArgs('grok', '--permission-mode bypassPermissions -v')).toEqual({
      bypass: true,
      extraArgs: '-v'
    })
    expect(liftTuiAgentBypassArgs('grok', '--permission-mode plan')).toEqual({
      bypass: false,
      extraArgs: '--permission-mode plan'
    })
    expect(liftTuiAgentBypassArgs('continue', '--allow "*"')).toEqual({
      bypass: true,
      extraArgs: ''
    })
  })

  it('leaves untokenizable text alone', () => {
    expect(liftTuiAgentBypassArgs('codex', `"${CODEX_BYPASS}`)).toEqual({
      bypass: false,
      extraArgs: `"${CODEX_BYPASS}`
    })
  })
})

describe('liftTuiAgentBypassEnv', () => {
  it('lifts the bypass env out and keeps the rest', () => {
    expect(liftTuiAgentBypassEnv('goose', { GOOSE_MODE: 'auto', A: '1' })).toEqual({
      bypass: true,
      extraEnv: { A: '1' }
    })
    expect(liftTuiAgentBypassEnv('goose', { GOOSE_MODE: 'approve' })).toEqual({
      bypass: false,
      extraEnv: { GOOSE_MODE: 'approve' }
    })
  })
})

describe('resolveAgentPermissionPosture', () => {
  it('reports the mode and no argument options for a plain profile', () => {
    expect(resolveAgentPermissionPosture('claude', {}, 'darwin')).toEqual({
      mode: 'bypass',
      effectiveBypass: true,
      typedPermissionOptions: []
    })
    expect(
      resolveAgentPermissionPosture('claude', { agentPermissionMode: 'ask' }, 'darwin')
    ).toMatchObject({ mode: 'ask', effectiveBypass: false })
  })

  // Settings warns instead of letting the switch silently lose to free text.
  it('reports a bypass flag typed into Arguments under Manual', () => {
    expect(
      resolveAgentPermissionPosture(
        'claude',
        {
          agentPermissionMode: 'ask',
          agentDefaultArgs: { claude: `--model Opus ${CLAUDE_BYPASS}` }
        },
        'darwin'
      )
    ).toEqual({ mode: 'ask', effectiveBypass: true, typedPermissionOptions: [CLAUDE_BYPASS] })
  })

  it('lists other permission options without treating them as bypass', () => {
    expect(
      resolveAgentPermissionPosture(
        'claude',
        { agentPermissionMode: 'ask', agentDefaultArgs: { claude: '--permission-mode=auto' } },
        'darwin'
      )
    ).toEqual({
      mode: 'ask',
      effectiveBypass: false,
      typedPermissionOptions: ['--permission-mode=auto']
    })
    expect(
      resolveAgentPermissionPosture(
        'codex',
        { agentPermissionMode: 'ask', agentDefaultArgs: { codex: '-a never -s workspace-write' } },
        'darwin'
      ).typedPermissionOptions
    ).toEqual(['-a', '-s'])
  })

  it.each([
    ['codex', '--yolo'],
    ['claude', '--permission-mode bypassPermissions'],
    ['claude', '--permission-mode=bypassPermissions']
  ] as const)('reads the %s bypass alias %j as bypass', (agent, args) => {
    expect(
      resolveAgentPermissionPosture(
        agent,
        { agentPermissionMode: 'ask', agentDefaultArgs: { [agent]: args } },
        'darwin'
      ).effectiveBypass
    ).toBe(true)
  })

  // A typed env key overrides the mode's env at launch (see resolveTuiAgentLaunchEnv).
  it('reads a typed Goose mode env as the posture', () => {
    expect(
      resolveAgentPermissionPosture(
        'goose',
        { agentPermissionMode: 'bypass', agentDefaultEnv: { goose: { GOOSE_MODE: 'approve' } } },
        'darwin'
      )
    ).toEqual({
      mode: 'bypass',
      effectiveBypass: false,
      typedPermissionOptions: ['GOOSE_MODE=approve']
    })
    expect(
      resolveAgentPermissionPosture(
        'goose',
        { agentPermissionMode: 'ask', agentDefaultEnv: { goose: { GOOSE_MODE: 'auto' } } },
        'darwin'
      ).effectiveBypass
    ).toBe(true)
  })

  it('reports typed permission options overriding Yolo', () => {
    expect(
      resolveAgentPermissionPosture(
        'codex',
        { agentPermissionMode: 'bypass', agentDefaultArgs: { codex: '-a on-request' } },
        'darwin'
      )
    ).toEqual({ mode: 'bypass', effectiveBypass: false, typedPermissionOptions: ['-a'] })
  })

  it.each([
    ['claude', `--append-system-prompt "mention ${CLAUDE_BYPASS} only as text"`],
    ['claude', `-- ${CLAUDE_BYPASS}`],
    ['codex', `--config "note=${CODEX_BYPASS} only as text"`],
    ['codex', `-- ${CODEX_BYPASS}`],
    ['codex', `"${CODEX_BYPASS}`]
  ] as const)('does not authorize %s text %j', (agent, args) => {
    expect(
      resolveAgentPermissionPosture(
        agent,
        { agentPermissionMode: 'ask', agentDefaultArgs: { [agent]: args } },
        'linux'
      ).effectiveBypass
    ).toBe(false)
  })

  it('reads typed arguments with the configured local Windows shell', () => {
    expect(
      resolveAgentPermissionPosture(
        'claude',
        {
          agentPermissionMode: 'ask',
          agentDefaultArgs: { claude: `\`${CLAUDE_BYPASS}` },
          terminalWindowsShell: 'powershell.exe'
        },
        'win32'
      ).effectiveBypass
    ).toBe(true)
    expect(
      resolveAgentPermissionPosture(
        'codex',
        {
          agentPermissionMode: 'ask',
          agentDefaultArgs: { codex: `^${CODEX_BYPASS}` },
          terminalWindowsShell: 'cmd.exe'
        },
        'win32'
      ).effectiveBypass
    ).toBe(true)
  })
})

describe('launch-ready records', () => {
  it('publishes every agent with its flag inline, and reads such a record back', () => {
    const record = composeTuiAgentLaunchArgsRecord({
      agentPermissionMode: 'bypass',
      agentPermissionModeOverrides: { codex: 'ask' },
      agentDefaultArgs: { claude: '--model opus', codex: '-m o3' }
    })
    expect(record.claude).toBe(`${CLAUDE_BYPASS} --model opus`)
    expect(record.codex).toBe('-m o3')
    expect(resolveComposedTuiAgentLaunchArgs('claude', record)).toBe(
      `${CLAUDE_BYPASS} --model opus`
    )
    // A record that predates an agent meant "the shipped default" for it.
    expect(resolveComposedTuiAgentLaunchArgs('claude', {})).toBe(CLAUDE_BYPASS)
    expect(resolveComposedTuiAgentLaunchArgs('claude', { claude: '' })).toBe('')
  })
})
