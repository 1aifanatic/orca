import { describe, expect, it } from 'vitest'
import { buildAgentStartupPlan } from '@/lib/tui-agent-startup'
import { buildFullCreationStartup } from './full-creation-startup'
import { tuiAgentToAgentKind } from '../../../../shared/agent-kind'

describe('the full composer’s renderer-spawned startup', () => {
  // Why: SSH repos, folder repos, repos with default tabs and a failed backend spawn all take this
  // path; without the file the agent is pointed at nothing and the prompt is lost.
  it('carries the launch file its command points at', () => {
    const startupPlan = buildAgentStartupPlan({
      agent: 'claude',
      prompt: 'x'.repeat(200_000),
      cmdOverrides: {},
      platform: 'linux',
      isRemote: true
    })
    const startup = buildFullCreationStartup({
      startupPlan,
      backendSpawnedStartup: false,
      agent: 'claude',
      shouldSeedInitialAgentStatus: false,
      prompt: 'x'.repeat(200_000),
      telemetry: {
        agent_kind: tuiAgentToAgentKind('claude'),
        launch_source: 'new_workspace_composer',
        request_kind: 'new'
      }
    })
    expect(startupPlan?.launchFile).toBeDefined()
    expect(startup?.launchFile).toEqual(startupPlan?.launchFile)
    expect(startup?.command).toContain(startupPlan?.launchFile?.placeholder)
  })
})
