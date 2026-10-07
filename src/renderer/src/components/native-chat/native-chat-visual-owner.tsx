import { createContext, useContext, useMemo, type ReactNode } from 'react'
import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'
import { useAppStore } from '@/store'
import { isNativeChatTabScopeCurrent } from './native-chat-tab-scope'

/** The structured chat a transcript belongs to: where its visuals are read and what owns them. */
export type NativeChatVisualOwner = {
  target: RuntimeClientTarget
  sessionId: string
  tabId: string
  worktreeId: string
}

export const NativeChatVisualOwnerContext = createContext<NativeChatVisualOwner | null>(null)

/** Null outside a structured chat's transcript, where no visual can be read. */
export function useNativeChatVisualOwner(): NativeChatVisualOwner | null {
  return useContext(NativeChatVisualOwnerContext)
}

/** Names the structured chat below it as the owner of the visuals its replies show. */
export function NativeChatVisualOwnerProvider({
  target,
  sessionId,
  tabId,
  worktreeId,
  children
}: {
  target: RuntimeClientTarget
  sessionId: string
  tabId: string
  worktreeId: string
  children: ReactNode
}): React.JSX.Element {
  const ownerPresent = useAppStore((state) =>
    isNativeChatTabScopeCurrent(state, { kind: 'structured', worktreeId, tabId })
  )
  const environmentId = target.kind === 'environment' ? target.environmentId : null
  const owner = useMemo<NativeChatVisualOwner | null>(
    () =>
      ownerPresent
        ? {
            target:
              environmentId === null ? { kind: 'local' } : { kind: 'environment', environmentId },
            sessionId,
            tabId,
            worktreeId
          }
        : null,
    [environmentId, ownerPresent, sessionId, tabId, worktreeId]
  )
  return (
    <NativeChatVisualOwnerContext.Provider value={owner}>
      {children}
    </NativeChatVisualOwnerContext.Provider>
  )
}
