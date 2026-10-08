import { useContext, useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from 'react'
import { useAppStore } from '@/store'
import { getConnectionIdFromState } from '@/lib/connection-context'
import {
  getRuntimeEnvironmentRevision,
  onRuntimeEnvironmentRevisionsChanged
} from '@/runtime/runtime-environment-revision'
import type { FileLinkExists } from '@/components/sidebar/comment-markdown-native-chat-file-links'
import type { NativeChatFileLinkContext } from './native-chat-file-link'
import {
  createNativeChatFileLinkExistence,
  NativeChatFileLinkExistenceContext,
  type NativeChatFileLinkExistence,
  type NativeChatFileLinkSnapshot
} from './native-chat-file-link-existence'

const subscribeToPairings = (onChange: () => void): (() => void) =>
  onRuntimeEnvironmentRevisionsChanged(onChange)

/** Changes when the host answering for this workspace reconnects or is paired again. */
function useFileLinkHostEpoch(
  connectionId: string | null | undefined,
  runtimeEnvironmentId: string | null
): string {
  const ssh = useAppStore((s) => {
    const state = connectionId ? s.sshConnectionStates.get(connectionId) : undefined
    return state ? `${state.status}:${state.connectionGeneration ?? 0}` : ''
  })
  const runtime = useAppStore((s) => {
    const status = runtimeEnvironmentId
      ? s.runtimeStatusByEnvironmentId.get(runtimeEnvironmentId)
      : undefined
    return status ? `${status.connectionGeneration ?? 0}:${status.hostContactEpoch ?? 0}` : ''
  })
  const pairing = useSyncExternalStore(subscribeToPairings, () =>
    runtimeEnvironmentId ? getRuntimeEnvironmentRevision(runtimeEnvironmentId) : undefined
  )
  return `${ssh}|${runtime}|${pairing ?? ''}`
}

/** Asks again about watched paths when a turn ends or the workspace's host comes back. */
function useRecheckFileLinks(
  existence: NativeChatFileLinkExistence | null,
  isWorking: boolean,
  hostEpoch: string
): void {
  const seen = useRef<{
    existence: NativeChatFileLinkExistence | null
    isWorking: boolean
    hostEpoch: string
  } | null>(null)
  useEffect(() => {
    const previous = seen.current
    seen.current = { existence, isWorking, hostEpoch }
    // Why: a fresh checker has nothing to recheck; its messages are asking right now.
    if (!existence || previous?.existence !== existence) {
      return
    }
    if ((previous.isWorking && !isWorking) || previous.hostEpoch !== hostEpoch) {
      existence.recheck()
    }
  }, [existence, isWorking, hostEpoch])
}

/** One per chat view: paths in its transcript are checked on the workspace's host. */
export function NativeChatFileLinkExistenceProvider({
  context,
  isWorking,
  children
}: {
  context: NativeChatFileLinkContext | null
  isWorking: boolean
  children: ReactNode
}): React.JSX.Element {
  const worktreeId = context?.worktreeId
  const worktreePath = context?.worktreePath
  const runtimeEnvironmentId = context?.runtimeEnvironmentId ?? null
  const connectionId = useAppStore((s) =>
    worktreeId ? getConnectionIdFromState(s, worktreeId) : null
  )
  const existence = useMemo(
    () =>
      worktreeId && worktreePath
        ? createNativeChatFileLinkExistence({
            cwd: worktreePath,
            worktreeId,
            worktreePath,
            runtimeEnvironmentId
          })
        : null,
    // Why connectionId: answers belong to the host that gave them, so a workspace whose SSH
    // connection resolves or changes starts over; lookups read the connection from the store.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [connectionId, runtimeEnvironmentId, worktreeId, worktreePath]
  )
  const hostEpoch = useFileLinkHostEpoch(connectionId, runtimeEnvironmentId)
  useRecheckFileLinks(existence, isWorking, hostEpoch)
  return (
    <NativeChatFileLinkExistenceContext.Provider value={existence}>
      {children}
    </NativeChatFileLinkExistenceContext.Provider>
  )
}

const subscribeToNothing = (): (() => void) => () => {}
const getNoSnapshot = (): null => null

/** Undefined when this chat cannot open files, so nothing is underlined. */
export function useNativeChatFileLinkExists(
  enabled: boolean,
  streaming: boolean
): FileLinkExists | undefined {
  const existence = useContext(NativeChatFileLinkExistenceContext)
  const watcher = useMemo(
    () => (enabled && existence ? existence.watch() : null),
    [enabled, existence]
  )
  const getSnapshot = watcher?.getSnapshot ?? getNoSnapshot
  const snapshot: NativeChatFileLinkSnapshot | null = useSyncExternalStore(
    watcher?.subscribe ?? subscribeToNothing,
    getSnapshot,
    getSnapshot
  )
  // Why: text still streaming in ends mid-path; ask the host once the reply settles.
  return snapshot ? (streaming ? snapshot.peek : snapshot.check) : undefined
}
