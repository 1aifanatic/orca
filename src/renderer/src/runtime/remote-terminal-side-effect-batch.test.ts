import { describe, expect, it } from 'vitest'
import { makePaneKey } from '../../../shared/stable-pane-id'
import { toRemoteRuntimePtyId } from '../../../shared/remote-runtime-pty-id'
import { toWebTerminalSurfaceTabId } from '../../../shared/terminal-surface-id'
import { remapHostAgentStatus } from './web-session-tabs-sync/agent-status-primitives'
import {
  toClientTerminalSideEffectBatch,
  toMirroredHostPaneKey
} from './remote-terminal-side-effect-batch'

const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const HOST_PANE_KEY = makePaneKey('host-tab', LEAF_ID)

// Why: a host fact's completion must reach the coordinator that this client's mirrored status
// row for the same pane feeds, so both must name the pane alike.
describe('remote terminal side-effect batches', () => {
  it('maps a host pane key to the key of the mirrored status row for that pane', () => {
    const mirrored = remapHostAgentStatus({
      type: 'terminal',
      id: `host-tab::${LEAF_ID}`,
      title: 'Terminal',
      parentTabId: 'host-tab',
      leafId: LEAF_ID,
      isActive: true,
      status: 'ready',
      terminal: 'host-terminal',
      agentStatus: {
        state: 'working',
        prompt: '',
        agentType: 'opencode2',
        paneKey: HOST_PANE_KEY,
        updatedAt: 1,
        stateStartedAt: 1,
        stateHistory: []
      }
    })

    expect(toMirroredHostPaneKey(HOST_PANE_KEY)).toBe(mirrored?.paneKey)
  })

  it('maps no key that names no terminal leaf', () => {
    expect(toMirroredHostPaneKey('host-tab:1')).toBeNull()
  })

  it('names the batch’s PTY, tab and pane in this client’s ids', () => {
    expect(
      toClientTerminalSideEffectBatch(
        {
          ptyId: 'host-pty',
          seq: 3,
          worktreeId: 'wt-1',
          tabId: 'host-tab',
          paneKey: HOST_PANE_KEY,
          facts: [{ kind: 'agent-run-ended', agentType: 'opencode2' }]
        },
        'env-1'
      )
    ).toEqual({
      ptyId: toRemoteRuntimePtyId('host-pty', 'env-1'),
      seq: 3,
      worktreeId: 'wt-1',
      tabId: toWebTerminalSurfaceTabId('host-tab'),
      paneKey: toMirroredHostPaneKey(HOST_PANE_KEY),
      facts: [{ kind: 'agent-run-ended', agentType: 'opencode2' }]
    })
  })
})
