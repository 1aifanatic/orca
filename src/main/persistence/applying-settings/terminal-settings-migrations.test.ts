import { describe, expect, it } from 'vitest'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { migrateAgentLaunchProfile } from './terminal-settings-migrations'
import {
  composeTuiAgentLaunchArgsRecord,
  composeTuiAgentLaunchEnvRecord,
  resolveComposedTuiAgentLaunchArgs
} from '../../../shared/tui-agent-launch-defaults'
import { PERMISSION_AGENT_IDS, YOLO_TUI_AGENT_ARGS } from '../../../shared/tui-agent-permissions'
import type { TuiAgent } from '../../../shared/tui-agent'

const CLAUDE_BYPASS = '--dangerously-skip-permissions'
const CODEX_BYPASS = '--dangerously-bypass-approvals-and-sandbox'
const YOLO_ENV = { goose: { GOOSE_MODE: 'auto' } }

function legacy(settings: Partial<GlobalSettings>): GlobalSettings {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: This test only supplies the settings fields consumed by this migration.
  return settings as GlobalSettings
}

/** Every agent in Yolo, the way a profile migrated by an older build stores it. */
function allYoloArgs(): Partial<Record<TuiAgent, string>> {
  return { ...YOLO_TUI_AGENT_ARGS }
}

describe('migrateAgentLaunchProfile', () => {
  it('lifts an all-Yolo profile into a Yolo default with no leftover text', () => {
    const { profile, migrated } = migrateAgentLaunchProfile(
      legacy({
        agentYoloDefaultsMigrated: true,
        agentDefaultArgs: allYoloArgs(),
        agentDefaultEnv: YOLO_ENV
      })
    )

    expect(migrated).toBe(true)
    expect(profile.agentPermissionMode).toBe('bypass')
    expect(profile.agentPermissionModeOverrides).toEqual({})
    expect(profile.agentDefaultArgs?.claude).toBe('')
    expect(profile.agentDefaultEnv?.goose).toEqual({})
  })

  it('lifts an all-Manual profile into a Manual default', () => {
    const { profile } = migrateAgentLaunchProfile(
      legacy({ agentYoloDefaultsMigrated: true, agentDefaultArgs: {}, agentDefaultEnv: {} })
    )

    expect(profile.agentPermissionMode).toBe('ask')
    expect(profile.agentPermissionModeOverrides).toEqual({})
  })

  // The #23853 report: Settings read Yolo, yet Claude's custom Arguments held no flag, so Claude
  // launched prompting. The migration must keep what actually launched and say so per agent.
  it('keeps custom arguments without the flag as Manual for that agent only', () => {
    const { profile } = migrateAgentLaunchProfile(
      legacy({
        agentYoloDefaultsMigrated: true,
        agentDefaultArgs: { ...allYoloArgs(), claude: '--model opus' },
        agentDefaultEnv: YOLO_ENV
      })
    )

    expect(profile.agentPermissionMode).toBe('bypass')
    expect(profile.agentPermissionModeOverrides).toEqual({ claude: 'ask' })
    expect(profile.agentDefaultArgs?.claude).toBe('--model opus')
  })

  it('lifts the flag out of custom arguments that also carry it', () => {
    const { profile } = migrateAgentLaunchProfile(
      legacy({
        agentYoloDefaultsMigrated: true,
        agentDefaultArgs: {
          ...allYoloArgs(),
          claude: `--model opus ${CLAUDE_BYPASS} --append-system-prompt "keep ${CLAUDE_BYPASS} here"`
        },
        agentDefaultEnv: YOLO_ENV
      })
    )

    expect(profile.agentPermissionModeOverrides).toEqual({})
    expect(profile.agentDefaultArgs?.claude).toBe(
      `--model opus --append-system-prompt "keep ${CLAUDE_BYPASS} here"`
    )
  })

  it('leaves agents with a command override in Manual on a never-migrated profile', () => {
    const { profile } = migrateAgentLaunchProfile(
      legacy({ agentCmdOverrides: { codex: '/opt/codex' } })
    )

    expect(profile.agentPermissionMode).toBe('bypass')
    expect(profile.agentPermissionModeOverrides).toEqual({ codex: 'ask' })
    expect(profile.agentDefaultArgs?.codex).toBe('')
  })

  it('keeps agents added after an older migration in Manual', () => {
    const { profile } = migrateAgentLaunchProfile(
      legacy({
        agentYoloDefaultsMigrated: true,
        agentDefaultArgs: { claude: CLAUDE_BYPASS, codex: CODEX_BYPASS },
        agentDefaultEnv: {}
      })
    )

    expect(profile.agentPermissionMode).toBe('ask')
    expect(profile.agentPermissionModeOverrides).toEqual({ claude: 'bypass', codex: 'bypass' })
    expect(profile.agentDefaultArgs?.droid).toBe('')
  })

  it('updates the previous Devin default before lifting it', () => {
    const { profile } = migrateAgentLaunchProfile(
      legacy({
        agentYoloDefaultsMigrated: true,
        agentDefaultArgs: { ...allYoloArgs(), devin: '--permission-mode bypass' },
        agentDefaultEnv: YOLO_ENV
      })
    )

    expect(profile.agentPermissionModeOverrides?.devin).toBeUndefined()
    expect(profile.agentDefaultArgs?.devin).toBe('')
  })

  it('is lossless: composing the result launches every agent with what it had', () => {
    const before = {
      ...allYoloArgs(),
      claude: `--model opus ${CLAUDE_BYPASS}`,
      codex: '-m o3',
      gemini: '',
      // Bypass beside another permission option: the launch must keep both.
      'claude-agent-teams': `${CLAUDE_BYPASS} --permission-mode plan`
    }
    const { profile } = migrateAgentLaunchProfile(
      legacy({
        agentYoloDefaultsMigrated: true,
        agentDefaultArgs: before,
        agentDefaultEnv: { goose: { GOOSE_MODE: 'auto', EXTRA: '1' } }
      })
    )
    const composed = composeTuiAgentLaunchArgsRecord(profile)

    for (const agent of PERMISSION_AGENT_IDS) {
      const original = resolveComposedTuiAgentLaunchArgs(agent, before).split(/\s+/).filter(Boolean)
      const after = (composed[agent] ?? '').split(/\s+/).filter(Boolean)
      expect([...after].sort()).toEqual([...original].sort())
    }
    expect(composeTuiAgentLaunchEnvRecord(profile).goose).toEqual({
      GOOSE_MODE: 'auto',
      EXTRA: '1'
    })
  })

  it('is idempotent: a typed profile loads unchanged', () => {
    const { profile: first } = migrateAgentLaunchProfile(
      legacy({
        agentYoloDefaultsMigrated: true,
        agentDefaultArgs: { ...allYoloArgs(), claude: '--model opus' },
        agentDefaultEnv: YOLO_ENV
      })
    )
    const second = migrateAgentLaunchProfile(legacy({ ...first }))

    expect(second.migrated).toBe(false)
    expect(second.profile).toEqual(first)
  })

  // Why: the yolo-defaults pass reads the flag inline, so re-running it on typed extras would put
  // the Devin flag back into the free text.
  it('does not re-run the yolo-defaults pass on a typed profile', () => {
    const { profile, migrated } = migrateAgentLaunchProfile(
      legacy({
        agentYoloDefaultsMigrated: true,
        agentPermissionMode: 'ask',
        agentDefaultArgs: { devin: '--permission-mode bypass' }
      })
    )

    expect(migrated).toBe(false)
    expect(profile.agentDefaultArgs?.devin).toBe('--permission-mode bypass')
    expect(profile.agentDefaultArgs?.droid).toBeUndefined()
  })
})
