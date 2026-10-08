import { useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import type { FileLinkExists } from '@/components/sidebar/comment-markdown-native-chat-file-links'
import type { NativeChatFileLinkContext } from './native-chat-file-link'
import {
  createNativeChatFileLinkExistence,
  NativeChatFileLinkExistenceContext,
  type NativeChatFileLinkSnapshot
} from './native-chat-file-link-existence'

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
  const runtimeEnvironmentId = context?.runtimeEnvironmentId
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
    [runtimeEnvironmentId, worktreeId, worktreePath]
  )
  useEffect(() => {
    if (!isWorking) {
      existence?.forgetMissing()
    }
  }, [existence, isWorking])
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
