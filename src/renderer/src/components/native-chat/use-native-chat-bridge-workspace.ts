import { useMemo } from 'react'
import { useAppStore } from '../../store'
import {
  selectNativeChatBridgeMembership,
  selectNativeChatRuntimeEnvironmentId
} from './native-chat-runtime-owner'
import type { NativeChatBridgeTabScope } from './native-chat-tab-scope'

/**
 * A bridge chat's supplied workspace: its scope, its runtime owner (null keeps the local path),
 * and whether its tab is still in that workspace. Membership is separate because a null owner
 * means local, so a missing tab must suspend transcript IO rather than read local session data.
 */
export function useNativeChatBridgeWorkspace(
  worktreeId: string,
  terminalTabId: string
): {
  scope: NativeChatBridgeTabScope
  runtimeEnvironmentId: string | null
  isWorkspaceMember: boolean
} {
  const scope = useMemo<NativeChatBridgeTabScope>(
    () => ({ kind: 'bridge', worktreeId, tabId: terminalTabId }),
    [terminalTabId, worktreeId]
  )
  // Primitive selections (no useShallow), so unrelated publications rerender nothing.
  const runtimeEnvironmentId = useAppStore((s) =>
    selectNativeChatRuntimeEnvironmentId(s, worktreeId)
  )
  const isWorkspaceMember = useAppStore((s) => selectNativeChatBridgeMembership(s, scope))
  return { scope, runtimeEnvironmentId, isWorkspaceMember }
}
