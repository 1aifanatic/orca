import { useCallback, useState } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import { showPinnedWorktreesInGroupsRead } from '../transport/settings-read-operations'
import type { ConnectionState } from '../transport/types'

/** Mirrors desktop's "Also show pinned worktrees in their original lists" (off by default). */
export function useHostShowPinnedInGroups(args: {
  client: RpcClient | null
  connState: ConnectionState
}) {
  const { client, connState } = args
  // Why keyed by client: the screen is reused across hosts, so a value only counts for the client that reported it.
  const [setting, setSetting] = useState<{ client: RpcClient; show: boolean } | null>(null)

  const syncShowPinnedInGroups = useCallback(async () => {
    if (!client || connState !== 'connected') {
      return
    }
    try {
      const reply = showPinnedWorktreesInGroupsRead.interpret(
        await showPinnedWorktreesInGroupsRead.request(client)
      )
      if (reply.accepted) {
        setSetting({ client, show: reply.value })
      }
    } catch {
      // Best-effort: keep the current placement until the next focus/connect.
    }
  }, [client, connState])

  return { showPinnedInGroups: setting?.client === client && setting.show, syncShowPinnedInGroups }
}
