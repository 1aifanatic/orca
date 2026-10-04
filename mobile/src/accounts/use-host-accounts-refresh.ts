import { useCallback, useState } from 'react'
import { decodeAccountsSnapshot, type AccountsSnapshot } from '../components/AccountUsage'
import type { RpcClient } from '../transport/rpc-client'
import type { ConnectionState } from '../transport/types'
import { getHostAccountEvidence } from './host-account-evidence'

export function useHostAccountsRefresh({
  client,
  hostId,
  connState,
  onSnapshot,
  onInvalidSnapshot,
  onError
}: {
  client: RpcClient | null
  hostId: string
  connState: ConnectionState
  onSnapshot: (snapshot: AccountsSnapshot) => void
  onInvalidSnapshot: () => void
  onError: (message: string) => void
}) {
  const [refreshing, setRefreshing] = useState(false)
  const accountEvidence = client ? getHostAccountEvidence(client, hostId) : null
  const refresh = useCallback(async () => {
    if (!client || !accountEvidence || connState !== 'connected') {
      return
    }
    setRefreshing(true)
    let read: ReturnType<typeof accountEvidence.read> | undefined
    try {
      const request = client.sendRequest('accounts.list')
      read = accountEvidence.read(request)
      const res = await request
      if (!read.isCurrent()) {
        return
      }
      if (res.ok) {
        if (!read.accept()) {
          return
        }
        onSnapshot(decodeAccountsSnapshot(res.result))
      } else {
        onError(res.error.message)
      }
    } catch (e) {
      if (read && !read.isCurrent()) {
        return
      }
      if (e instanceof Error && e.message === 'Invalid accounts snapshot from host') {
        onInvalidSnapshot()
      } else {
        onError(e instanceof Error ? e.message : String(e))
      }
    } finally {
      setRefreshing(false)
    }
  }, [onSnapshot, accountEvidence, client, connState, onInvalidSnapshot, onError])
  return { refresh, refreshing }
}
