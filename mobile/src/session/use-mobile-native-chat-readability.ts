import { useEffect, useState } from 'react'
import type { RpcClient } from '../transport/rpc-client'
import {
  nativeChatRepoListRead,
  type MobileRuntimeRepoSummary
} from './mobile-session-read-operations'
import { isFloatingWorkspaceWorktreeId } from './floating-workspace'
import { resumeFolderWorkspaceListRead } from '../agent-history/mobile-agent-history-operations'
import {
  isMobileFolderNativeChatReadable,
  isMobileNativeChatTranscriptReadable
} from './mobile-native-chat-eligibility'
import { getRepoIdFromMobileWorktreeId } from './mobile-session-route-helpers'
import type { MobileNativeChatReadability } from './mobile-session-chat-view'

type ReadabilityState = {
  client: RpcClient | null
  worktreeId: string
  readability: MobileNativeChatReadability
}

// Why per host and worktree: a client swap re-reads, and a settled answer should not regress to unknown meanwhile.
const settledReadabilityByScope = new Map<string, 'readable' | 'unreadable'>()

function readabilityScope(hostId: string | null, worktreeId: string): string | null {
  return hostId === null ? null : `${hostId}\0${worktreeId}`
}

export function useMobileNativeChatReadability(
  client: RpcClient | null,
  worktreeId: string
): boolean {
  return useMobileNativeChatReadabilityState(client, null, worktreeId) === 'readable'
}

/** Tri-state readability: `unknown` while the read is pending, `failed` once it could not be read. */
export function useMobileNativeChatReadabilityState(
  client: RpcClient | null,
  hostId: string | null,
  worktreeId: string
): MobileNativeChatReadability {
  const isFloatingWorkspace = isFloatingWorkspaceWorktreeId(worktreeId)
  const scope = readabilityScope(hostId, worktreeId)
  const [state, setState] = useState<ReadabilityState>({
    client: null,
    worktreeId: '',
    readability: 'unknown'
  })
  useEffect(() => {
    // Why: the floating workspace always runs on the paired host and has no repo connection to resolve.
    if (isFloatingWorkspace) {
      return
    }
    let active = true
    const settle = (readable: boolean): void => {
      if (!active) {
        return
      }
      const readability = readable ? 'readable' : 'unreadable'
      if (scope !== null) {
        settledReadabilityByScope.set(scope, readability)
      }
      setState({ client, worktreeId, readability })
    }
    const fail = (): void => {
      if (active) {
        setState({ client, worktreeId, readability: 'failed' })
      }
    }
    if (!client) {
      setState({ client, worktreeId, readability: 'unknown' })
      return
    }
    if (worktreeId.startsWith('folder:')) {
      void resumeFolderWorkspaceListRead
        .request(client)
        .then((response) => {
          const result = resumeFolderWorkspaceListRead.interpret(response)
          settle(result.accepted && isMobileFolderNativeChatReadable(result.value, worktreeId))
        })
        .catch(fail)
      return () => {
        active = false
      }
    }
    void nativeChatRepoListRead
      .request(client)
      .then((response) => {
        const accepted = nativeChatRepoListRead.interpret(response)
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Preserve the established response shape at this boundary.
        const repos = accepted.accepted
          ? ((accepted.value as MobileRuntimeRepoSummary[]) ?? [])
          : []
        const repoId = getRepoIdFromMobileWorktreeId(worktreeId)
        const repo = repos.find((candidate) => candidate.id === repoId)
        settle(repo ? isMobileNativeChatTranscriptReadable(repo.connectionId ?? null) : false)
      })
      .catch(fail)
    return () => {
      active = false
    }
  }, [client, isFloatingWorkspace, scope, worktreeId])
  if (isFloatingWorkspace) {
    return 'readable'
  }
  // Why: route reuse renders before its new effect resolves; never expose the
  // previous repo's readability under a different client/worktree key.
  if (state.client === client && state.worktreeId === worktreeId) {
    return state.readability
  }
  return (scope !== null ? settledReadabilityByScope.get(scope) : undefined) ?? 'unknown'
}
