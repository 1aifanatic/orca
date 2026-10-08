// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatFileLinkContext } from './native-chat-file-link'
import type * as ExistenceModule from './native-chat-file-link-existence'
import { NativeChatFileLinkExistenceProvider } from './use-native-chat-file-link-existence'

type StoreState = {
  connectionId: string | null | undefined
  sshConnectionStates: Map<string, { status: string; connectionGeneration?: number }>
  runtimeStatusByEnvironmentId: Map<string, unknown>
}

const mocks = vi.hoisted(() => {
  const store: StoreState = {
    connectionId: 'ssh-1',
    sshConnectionStates: new Map(),
    runtimeStatusByEnvironmentId: new Map()
  }
  const created: { recheck: () => void }[] = []
  return { store, created }
})

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: StoreState) => unknown) => selector(mocks.store)
}))
vi.mock('@/lib/connection-context', () => ({
  getConnectionIdFromState: (state: StoreState) => state.connectionId
}))
vi.mock('./native-chat-file-link-existence', async (importOriginal) => ({
  ...(await importOriginal<typeof ExistenceModule>()),
  createNativeChatFileLinkExistence: () => {
    const existence = { watch: vi.fn(), recheck: vi.fn() }
    mocks.created.push(existence)
    return existence
  }
}))

const context: NativeChatFileLinkContext = {
  worktreeId: 'wt-1',
  worktreePath: '/repo',
  runtimeEnvironmentId: null
}

function renderProvider(isWorking: boolean) {
  return render(
    <NativeChatFileLinkExistenceProvider context={context} isWorking={isWorking}>
      {null}
    </NativeChatFileLinkExistenceProvider>
  )
}

describe('NativeChatFileLinkExistenceProvider', () => {
  afterEach(() => {
    cleanup()
    mocks.created.length = 0
    mocks.store.connectionId = 'ssh-1'
    mocks.store.sshConnectionStates = new Map()
  })

  it('rechecks when a turn ends, not when the chat mounts', () => {
    const view = renderProvider(false)
    view.rerender(
      <NativeChatFileLinkExistenceProvider context={context} isWorking>
        {null}
      </NativeChatFileLinkExistenceProvider>
    )
    expect(mocks.created[0].recheck).not.toHaveBeenCalled()

    view.rerender(
      <NativeChatFileLinkExistenceProvider context={context} isWorking={false}>
        {null}
      </NativeChatFileLinkExistenceProvider>
    )

    expect(mocks.created).toHaveLength(1)
    expect(mocks.created[0].recheck).toHaveBeenCalledOnce()
  })

  it('rechecks when the SSH connection comes back', () => {
    mocks.store.sshConnectionStates = new Map([['ssh-1', { status: 'reconnecting' }]])
    const view = renderProvider(false)

    mocks.store.sshConnectionStates = new Map([
      ['ssh-1', { status: 'connected', connectionGeneration: 2 }]
    ])
    view.rerender(
      <NativeChatFileLinkExistenceProvider context={context} isWorking={false}>
        {null}
      </NativeChatFileLinkExistenceProvider>
    )

    expect(mocks.created[0].recheck).toHaveBeenCalledOnce()
  })

  it('starts over when the workspace connection resolves', () => {
    mocks.store.connectionId = undefined
    const view = renderProvider(false)

    mocks.store.connectionId = 'ssh-1'
    view.rerender(
      <NativeChatFileLinkExistenceProvider context={context} isWorking={false}>
        {null}
      </NativeChatFileLinkExistenceProvider>
    )

    expect(mocks.created).toHaveLength(2)
    expect(mocks.created[0].recheck).not.toHaveBeenCalled()
    expect(mocks.created[1].recheck).not.toHaveBeenCalled()
  })
})
