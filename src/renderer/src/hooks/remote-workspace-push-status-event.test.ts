import { describe, expect, it, vi } from 'vitest'
import type { RemoteWorkspacePushStatusEvent } from '../../../shared/remote-workspace-types'
import { i18n } from '@/i18n/i18n'
import { PSEUDO_LOCALIZATION_LOCALE } from '@/i18n/pseudo-localization'
import { appState, snapshot } from './__tests__/remote-workspace-target-sync-test-harness'
import { applyRemoteWorkspacePushStatusEvent } from './remote-workspace-push-status'

const TOKEN = snapshot(4).hostObservationToken

function hydratedState(overrides: Parameters<typeof appState>[0] = {}) {
  return appState({
    remoteWorkspaceHydratedTargetIds: new Set(['target-a']),
    remoteWorkspaceSyncStatusByTargetId: {
      'target-a': { phase: 'synced', revision: 4, hostObservationToken: TOKEN }
    },
    ...overrides
  })
}

function pushed(result: RemoteWorkspacePushStatusEvent['result']): RemoteWorkspacePushStatusEvent {
  return {
    targetId: 'target-a',
    authority: { revision: 4, hostObservationToken: TOKEN },
    result
  }
}

describe('applyRemoteWorkspacePushStatusEvent', () => {
  it('acknowledges a pending layout edit the host now holds, and only that one', () => {
    const held = { targetId: 'target-a', root: null }
    const otherRoot = {
      targetId: 'target-a',
      root: { type: 'leaf' as const, leafId: '11111111-1111-4111-8111-111111111111' }
    }
    const state = hydratedState({
      pendingDirectSshLayoutEditsByTabId: { 'tab-a': held, 'tab-b': otherRoot }
    })
    const uploaded = snapshot(5)
    uploaded.session.terminalLayoutsByTabId = {
      'tab-a': { root: null, activeLeafId: null, expandedLeafId: null },
      'tab-b': { root: null, activeLeafId: null, expandedLeafId: null }
    }

    applyRemoteWorkspacePushStatusEvent(state, pushed({ ok: true, snapshot: uploaded }))

    expect(state.acknowledgeDirectSshLayoutEdits).toHaveBeenCalledWith({ 'tab-a': held })
    expect(state.setRemoteWorkspaceSyncStatus).toHaveBeenCalledWith(
      'target-a',
      expect.objectContaining({ phase: 'synced', direction: 'push', revision: 5 })
    )
  })

  it.each([
    ['stale-revision', 'Workspace changed on another device'],
    ['unavailable', 'Remote workspace sync unavailable']
  ] as const)('localizes the %s export fallback', async (reason, message) => {
    const previousLanguage = i18n.language
    await i18n.changeLanguage(PSEUDO_LOCALIZATION_LOCALE)
    try {
      const state = hydratedState()

      applyRemoteWorkspacePushStatusEvent(state, pushed({ ok: false, reason }))

      expect(state.setRemoteWorkspaceSyncStatus).toHaveBeenLastCalledWith(
        'target-a',
        expect.objectContaining({ message: `[${message}]` })
      )
    } finally {
      await i18n.changeLanguage(previousLanguage)
    }
  })

  it('reports a thrown export as an error', () => {
    const state = hydratedState()

    applyRemoteWorkspacePushStatusEvent(state, { ...pushed(null), error: 'socket closed' })

    expect(state.setRemoteWorkspaceSyncStatus).toHaveBeenCalledWith(
      'target-a',
      expect.objectContaining({ phase: 'error', direction: 'push', message: 'socket closed' })
    )
  })

  it.each([
    ['mid-pull', { remoteWorkspaceHydratedTargetIds: new Set<string>() }],
    [
      'conflicted',
      {
        remoteWorkspaceSyncStatusByTargetId: {
          'target-a': { phase: 'conflict' as const, revision: 4, hostObservationToken: TOKEN }
        }
      }
    ],
    [
      'observing another host',
      {
        remoteWorkspaceSyncStatusByTargetId: {
          'target-a': { phase: 'synced' as const, revision: 4, hostObservationToken: 'other' }
        }
      }
    ]
  ])('ignores a report while the window is %s', (_name, overrides) => {
    const acknowledgeDirectSshLayoutEdits = vi.fn()
    const state = hydratedState({ ...overrides, acknowledgeDirectSshLayoutEdits })

    applyRemoteWorkspacePushStatusEvent(state, pushed({ ok: true, snapshot: snapshot(5) }))

    expect(state.setRemoteWorkspaceSyncStatus).not.toHaveBeenCalled()
    expect(acknowledgeDirectSshLayoutEdits).not.toHaveBeenCalled()
  })
})
