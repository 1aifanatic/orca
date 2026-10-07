import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>()
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, callback: (...args: unknown[]) => unknown) =>
      mocks.handlers.set(name, callback),
    on: vi.fn()
  }
}))
import { registerSessionHandlers } from './session'

const LEAF = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
const REQUEST = { worktreeId: 'repo::/wt', tabId: 'tab', root: { type: 'leaf', leafId: LEAF } }

let committed = false
const setTerminalTabLayout = vi.fn(async () => {
  await Promise.resolve()
  committed = true
  return { status: 'committed' as const }
})
// Names the push only once the commit has landed.
const settleTerminalTopology = vi.fn(() => (committed ? 9 : 0))
let homeHostId: string | null = 'local'
const getTerminalTopologyHomeHostId = vi.fn(() => homeHostId)

function setLayout(args: unknown): unknown {
  return mocks.handlers.get('session:terminal-set-layout')?.({}, args)
}

beforeEach(() => {
  mocks.handlers.clear()
  setTerminalTabLayout.mockClear()
  committed = false
  homeHostId = 'local'
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reaches only the store's layout commit.
  const store = { setTerminalTabLayout } as never
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler reaches only the home lookup and the topology settle.
  registerSessionHandlers(store, { getTerminalTopologyHomeHostId, settleTerminalTopology } as never)
})

describe('session:terminal-set-layout', () => {
  it('replies with the publishSeq of the push holding the commit', async () => {
    await expect(setLayout(REQUEST)).resolves.toEqual({ status: 'committed', publishSeq: 9 })
    expect(setTerminalTabLayout).toHaveBeenCalledWith(REQUEST, 'local')
    expect(settleTerminalTopology).toHaveBeenCalledWith(REQUEST.worktreeId)
  })

  it('refuses a malformed request without touching the store', async () => {
    await expect(setLayout({ ...REQUEST, root: { type: 'leaf' } })).resolves.toEqual({
      status: 'refused',
      reason: 'invalid_request'
    })
    expect(setTerminalTabLayout).not.toHaveBeenCalled()
  })

  it('writes nothing when the worktree has no resolvable home partition', async () => {
    homeHostId = null
    await expect(setLayout(REQUEST)).resolves.toEqual({
      status: 'refused',
      reason: 'home_unresolved',
      publishSeq: 0
    })
    expect(setTerminalTabLayout).not.toHaveBeenCalled()
  })
})
