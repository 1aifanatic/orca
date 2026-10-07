import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'
import type { Store } from '../persistence'
import {
  closeMoveTestStores,
  LEFT,
  MOVED,
  newDataFile,
  openStore,
  seedSplitSource,
  SOURCE,
  WT
} from '../persistence/terminal-topology/terminal-leaf-move-fixture'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>()
}))
vi.mock('electron', () => ({
  app: {
    getPath: () => tmpdir(),
    getName: () => 'orca-test',
    getVersion: () => '0.0.0-test',
    isPackaged: false,
    on: () => {},
    whenReady: () => Promise.resolve()
  },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString()
  },
  ipcMain: {
    handle: (name: string, callback: (...args: unknown[]) => unknown) =>
      mocks.handlers.set(name, callback),
    on: () => {}
  },
  BrowserWindow: { getAllWindows: () => [] }
}))
import { registerSessionHandlers } from './session'

const ADOPT = { worktreeId: WT, tabId: SOURCE, leafId: MOVED, ptyId: 'pty-adopted' }
let homeHostId: string | null = 'local'
let store: Store

function bindLeaf(args: unknown): Promise<unknown> {
  return Promise.resolve(mocks.handlers.get('session:terminal-bind-leaf')?.({}, args))
}

// A split whose second pane lost its binding while its agent kept running.
beforeEach(async () => {
  mocks.handlers.clear()
  homeHostId = 'local'
  store = openStore(newDataFile())
  await seedSplitSource(store)
  await store.retirePtyBinding({ worktreeId: WT, tabId: SOURCE, leafId: MOVED, ptyId: 'pty-agent' })
  registerSessionHandlers(
    store,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reaches only the home lookup and the topology settle.
    { getTerminalTopologyHomeHostId: () => homeHostId, settleTerminalTopology: () => 4 } as never
  )
})

afterEach(closeMoveTestStores)

describe('session:terminal-bind-leaf', () => {
  it("records an adopted agent's PTY on its pane in a split, so a remount reattaches", async () => {
    await expect(bindLeaf(ADOPT)).resolves.toEqual({ status: 'bound', publishSeq: 4 })

    expect(store.getWorkspaceSession().terminalLayoutsByTabId[SOURCE]?.ptyIdsByLeafId).toEqual({
      [LEFT]: 'pty-left',
      [MOVED]: 'pty-adopted'
    })
  })

  it('never creates a pane main does not hold', async () => {
    const before = store.getWorkspaceSession()

    await expect(
      bindLeaf({ ...ADOPT, leafId: '33333333-3333-4333-8333-333333333333' })
    ).resolves.toEqual({ status: 'refused', reason: 'not_bound', publishSeq: 4 })
    expect(store.getWorkspaceSession()).toEqual(before)
  })

  it('writes nothing when the home is unresolved, or for a malformed request', async () => {
    const before = store.getWorkspaceSession()
    homeHostId = null

    await expect(bindLeaf(ADOPT)).resolves.toEqual({
      status: 'refused',
      reason: 'home_unresolved',
      publishSeq: 4
    })
    await expect(bindLeaf({ ...ADOPT, leafId: 'not-a-leaf' })).resolves.toEqual({
      status: 'refused',
      reason: 'invalid_request'
    })
    expect(store.getWorkspaceSession()).toEqual(before)
  })
})
