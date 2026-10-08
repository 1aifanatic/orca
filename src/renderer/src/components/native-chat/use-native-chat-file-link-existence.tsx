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

type FileLinkHostEpoch = {
  /** The SSH connection generation while connected; null while it is not. */
  sshUp: string | null
  /** Changes when the runtime host answers again or is paired again. */
  runtime: string
}

function useFileLinkHostEpoch(
  connectionId: string | null | undefined,
  runtimeEnvironmentId: string | null
): FileLinkHostEpoch {
  const sshUp = useAppStore((s) => {
    const state = connectionId ? s.sshConnectionStates.get(connectionId) : undefined
    return state?.status === 'connected' ? String(state.connectionGeneration ?? 0) : null
  })
  const runtimeStatus = useAppStore((s) => {
    const status = runtimeEnvironmentId
      ? s.runtimeStatusByEnvironmentId.get(runtimeEnvironmentId)
      : undefined
    return status ? `${status.connectionGeneration ?? 0}:${status.hostContactEpoch ?? 0}` : ''
  })
  const pairing = useSyncExternalStore(subscribeToPairings, () =>
    runtimeEnvironmentId ? getRuntimeEnvironmentRevision(runtimeEnvironmentId) : undefined
  )
  return { sshUp, runtime: `${runtimeStatus}|${pairing ?? ''}` }
}

/** Asks again about watched paths when a turn ends or the workspace's host comes back. */
function useRecheckFileLinks(
  existence: NativeChatFileLinkExistence | null,
  isWorking: boolean,
  { sshUp, runtime }: FileLinkHostEpoch
): void {
  const seen = useRef<{
    existence: NativeChatFileLinkExistence | null
    isWorking: boolean
    sshUp: string | null
    runtime: string
  } | null>(null)
  useEffect(() => {
    const previous = seen.current
    seen.current = { existence, isWorking, sshUp, runtime }
    // Why: a fresh checker has nothing to recheck; its messages are asking right now.
    if (!existence || previous?.existence !== existence) {
      return
    }
    const turnEnded = previous.isWorking && !isWorking
    // Why: only a host coming back (or a new connection) can change answers; going down cannot.
    const sshReturned = sshUp !== null && sshUp !== previous.sshUp
    if (turnEnded || sshReturned || runtime !== previous.runtime) {
      existence.recheck()
    }
  }, [existence, isWorking, sshUp, runtime])
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
            runtimeEnvironmentId,
            connectionId
          })
        : null,
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
