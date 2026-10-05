import { useCallback, useState, type RefObject } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import { showPinnedWorktreesInGroupsRead } from '../transport/settings-read-operations'
import type { ConnectionState } from '../transport/types'

/** Mirrors desktop's "Also show pinned worktrees in their original lists" (off by default). */
export function useHostShowPinnedInGroups(args: {
  client: RpcClient | null
  connState: ConnectionState
  clientRef: RefObject<RpcClient | null>
}) {
  const { client, connState, clientRef } = args
  const [showPinnedInGroups, setShowPinnedInGroups] = useState(false)

  const syncShowPinnedInGroups = useCallback(async () => {
    if (!client || connState !== 'connected') {
      return
    }
    try {
      const reply = await showPinnedWorktreesInGroupsRead.request(client)
      if (clientRef.current !== client) {
        return
      }
      const setting = showPinnedWorktreesInGroupsRead.interpret(reply)
      if (setting.accepted) {
        setShowPinnedInGroups(setting.value)
      }
    } catch {
      // Best-effort: keep the current placement until the next focus/connect.
    }
  }, [client, connState])

  return { showPinnedInGroups, syncShowPinnedInGroups }
}
