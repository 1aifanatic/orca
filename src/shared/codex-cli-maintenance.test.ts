import { describe, expect, it } from 'vitest'
import { codexCliInstallation } from './codex-cli-installation'
import { CodexMaintenanceStateSchema, codexMaintenanceAction } from './codex-cli-maintenance'
import {
  agentSessionRefusalFailure,
  parseAgentSessionWriteFailure
} from './agent-session-write-failure'

describe('Codex maintenance policy and mixed-version replies', () => {
  it('installs missing Codex and chooses updates by installation source', () => {
    expect(codexMaintenanceAction(codexCliInstallation(false, null), false)).toEqual({
      kind: 'install',
      command: 'npm install -g @openai/codex'
    })
    expect(codexMaintenanceAction(codexCliInstallation(true, '0.135.0'), false)?.command).toBe(
      'codex update'
    )
    expect(codexMaintenanceAction(codexCliInstallation(true, '0.135.0'), true)?.command).toBe(
      'npm install -g @openai/codex'
    )
  })
  it('withholds actions for unknown and supported installations', () => {
    expect(codexMaintenanceAction(codexCliInstallation(true, null), false)).toBeNull()
    expect(codexMaintenanceAction(codexCliInstallation(true, '0.136.0'), false)).toBeNull()
  })
  it.each([null, '0.135.0'])(
    'retains the checked failure facts after a reload: %s',
    (installedVersion) => {
      const refusal = agentSessionRefusalFailure({
        code: 'agent_session_operation_invalid',
        details: {
          reason: 'attachFailed',
          codexInstallation: { installedVersion, minimumVersion: '0.136.0' }
        }
      })
      const saved = JSON.parse(JSON.stringify(refusal))
      expect(parseAgentSessionWriteFailure(saved)).toEqual(refusal)
      expect(refusal).toMatchObject({
        details: { codexInstallation: { installedVersion, minimumVersion: '0.136.0' } }
      })
    }
  )
  it('degrades newer host states without dropping version evidence or the log', () => {
    const result = CodexMaintenanceStateSchema.parse({
      installation: {
        status: 'future-health-state',
        version: '0.150.0',
        minimumVersion: '0.136.0'
      },
      action: { kind: 'future-action', command: 'future command' },
      canRun: true,
      job: {
        id: 'job',
        phase: 'future-phase',
        action: { kind: 'future-action', command: 'future command' },
        output: 'host log',
        exitCode: null,
        error: null
      }
    })
    expect(result.installation.status).toBe('unknown')
    expect(result.installation.version).toBe('0.150.0')
    expect(result.action?.kind).toBe('unknown')
    expect(result.job?.phase).toBe('unknown')
    expect(result.job?.output).toBe('host log')
  })
})
