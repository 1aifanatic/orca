import { expect, it } from 'vitest'
import { createTestStore } from './store-test-helpers'
import { decodeHookResumeSession } from '../../../../shared/agent-resume-identity'

it('captures matched launch settings with the owner and keeps them across inherited child events', () => {
  const store = createTestStore()
  const paneKey = 'tab-1:leaf-1'
  const launchConfig = { agentArgs: '--model captured', agentEnv: { PROFILE: 'owner' } }
  const owner = decodeHookResumeSession({ key: 'session_id', id: 'claude-owner' }, 'claude', null)!
  store.getState().registerAgentLaunchConfig(paneKey, launchConfig, {
    agentType: 'claude',
    launchToken: 'owner-launch'
  })
  store
    .getState()
    .setAgentStatus(
      paneKey,
      { agentType: 'claude', state: 'working', prompt: 'delegate' },
      undefined,
      { updatedAt: Date.now() },
      { tabId: 'tab-1', worktreeId: 'wt-1' },
      { providerSession: owner, launchToken: 'owner-launch' }
    )
  const captured = store.getState().agentStatusByPaneKey[paneKey].providerSession
  expect(captured).toMatchObject({
    id: 'claude-owner',
    resumeIdentity: { agent: 'claude', launchConfig }
  })
  store
    .getState()
    .setAgentStatus(
      paneKey,
      { agentType: 'codex', state: 'working', prompt: 'child' },
      undefined,
      undefined,
      undefined,
      {
        providerSession: decodeHookResumeSession(
          { key: 'session_id', id: 'codex-child' },
          'codex',
          null
        ),
        launchToken: 'owner-launch',
        launchConfig: { agentArgs: '--child', agentEnv: {} }
      }
    )
  expect(store.getState().agentStatusByPaneKey[paneKey].providerSession).toEqual(captured)
  store.getState().captureAllSleepingAgentSessions('quit')
  expect(store.getState().sleepingAgentSessionsByPaneKey[paneKey].providerSession).toEqual(captured)
})
