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
  // Why keyed by client: the screen is reused across hosts and clientRef trails a switch by one effect.
  const [setting, setSetting] = useState<{ client: RpcClient; show: boolean } | null>(null)

  const syncShowPinnedInGroups = useCallback(async () => {
    if (!client || connState !== 'connected') {
      return
    }
    try {
      const reply = await showPinnedWorktreesInGroupsRead.request(client)
      // A replaced client's late reply must not overwrite the current client's value.
      if (clientRef.current !== client) {
        return
      }
      const read = showPinnedWorktreesInGroupsRead.interpret(reply)
      if (read.accepted) {
        setSetting({ client, show: read.value })
      }
    } catch {
      // Best-effort: keep the current placement until the next focus/connect.
    }
  }, [client, connState])

  return { showPinnedInGroups: setting?.client === client && setting.show, syncShowPinnedInGroups }
}
