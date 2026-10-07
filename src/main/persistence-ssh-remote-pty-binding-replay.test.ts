import { closeTestStores, testState, createStore } from './persistence-test-harness'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { rmSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { TEST_LEAF_1 } from './persistence-session-fixtures'
import type { WorkspaceSessionState } from '../shared/workspace-session-state-types'
import { setRendererSession } from './persistence/terminal-topology/terminal-renderer-presentation-save'

// Stub the ~/.ssh/config parser so the SSH-import test drives the real Store with deterministic hosts, not the operator's actual ~/.ssh/config.
const { loadUserSshConfigMock, sshConfigHostsToTargetsMock } = vi.hoisted(() => ({
  loadUserSshConfigMock: vi.fn(),
  sshConfigHostsToTargetsMock: vi.fn()
}))

vi.mock('./ssh/ssh-config-parser', () => ({
  loadUserSshConfig: loadUserSshConfigMock,
  sshConfigHostsToTargets: sshConfigHostsToTargetsMock
}))
const { trackMock, getCohortAtEmitMock } = vi.hoisted(() => ({
  trackMock: vi.fn(),
  getCohortAtEmitMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.dir
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (plaintext: string) => Buffer.from(`encrypted:${plaintext}`, 'utf-8'),
    decryptString: (ciphertext: Buffer) => {
      const decoded = ciphertext.toString('utf-8')
      if (!decoded.startsWith('encrypted:')) {
        throw new Error('invalid ciphertext')
      }
      return decoded.slice('encrypted:'.length)
    }
  }
}))

vi.mock('./telemetry/client', () => ({
  track: trackMock
}))

vi.mock('./telemetry/cohort-classifier', () => ({
  getCohortAtEmit: getCohortAtEmitMock
}))

describe('Store', () => {
  beforeEach(() => {
    testState.dir = mkdtempSync(join(tmpdir(), 'orca-test-'))
    trackMock.mockReset()
    getCohortAtEmitMock.mockReset()
    getCohortAtEmitMock.mockReturnValue({ nth_repo_added: 2 })
  })

  afterEach(async () => {
    await closeTestStores()
    rmSync(testState.dir, { recursive: true, force: true })
  })
  it('keeps the SSH host binding when a stale window save clears its pty map', async () => {
    const store = await createStore()
    const hostId = 'ssh:ssh-1'
    const session = {
      activeRepoId: 'r1',
      activeWorktreeId: 'wt1',
      activeTabId: 'tab1',
      tabsByWorktree: {
        wt1: [
          {
            id: 'tab1',
            worktreeId: 'wt1',
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            ptyId: 'ssh:ssh-1@@old'
          }
        ]
      },
      terminalLayoutsByTabId: {
        tab1: {
          root: { type: 'leaf' as const, leafId: TEST_LEAF_1 },
          activeLeafId: TEST_LEAF_1,
          expandedLeafId: null,
          ptyIdsByLeafId: { [TEST_LEAF_1]: 'ssh:ssh-1@@old' }
        }
      }
    }
    store.setWorkspaceSession(session, hostId)
    store.upsertSshRemotePtyLease({
      targetId: 'ssh-1',
      ptyId: 'old',
      worktreeId: 'wt1',
      tabId: 'tab1',
      leafId: TEST_LEAF_1,
      state: 'detached'
    })
    setRendererSession(
      store,
      {
        ...session,
        tabsByWorktree: {
          wt1: [{ ...session.tabsByWorktree.wt1[0], ptyId: null }]
        },
        terminalLayoutsByTabId: {
          tab1: {
            ...session.terminalLayoutsByTabId.tab1,
            ptyIdsByLeafId: {}
          }
        }
      },
      hostId
    )
    expect(store.getWorkspaceSession(hostId).terminalLayoutsByTabId.tab1.ptyIdsByLeafId).toEqual({
      [TEST_LEAF_1]: 'ssh:ssh-1@@old'
    })
  })

  // Another server feeds the window its runtime: rows, so the window's save stands there.
  it('takes the window rows as sent for a runtime host partition', async () => {
    const store = await createStore()
    const hostId = 'runtime:env-1'
    const session: WorkspaceSessionState = {
      activeRepoId: 'r1',
      activeWorktreeId: 'wt1',
      activeTabId: 'tab1',
      tabsByWorktree: {
        wt1: [
          {
            id: 'tab1',
            worktreeId: 'wt1',
            title: 'Terminal',
            customTitle: null,
            color: null,
            sortOrder: 0,
            createdAt: 1,
            ptyId: 'runtime-pty'
          }
        ]
      },
      terminalLayoutsByTabId: {
        tab1: {
          root: { type: 'leaf', leafId: TEST_LEAF_1 },
          activeLeafId: TEST_LEAF_1,
          expandedLeafId: null,
          ptyIdsByLeafId: { [TEST_LEAF_1]: 'runtime-pty' }
        }
      }
    }
    store.setWorkspaceSession(session, hostId)
    setRendererSession(
      store,
      {
        ...session,
        tabsByWorktree: {
          wt1: [{ ...session.tabsByWorktree.wt1[0]!, ptyId: null }]
        },
        terminalLayoutsByTabId: {
          tab1: { ...session.terminalLayoutsByTabId.tab1!, ptyIdsByLeafId: {} }
        }
      },
      hostId
    )
    expect(store.getWorkspaceSession(hostId).terminalLayoutsByTabId.tab1.ptyIdsByLeafId).toEqual({})
  })

  // `expired` is the client admitting it lost its route; the remote shell may still be running,
  // so the pane keeps the binding it needs to reattach.
})
