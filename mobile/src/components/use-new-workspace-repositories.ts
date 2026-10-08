import { useEffect, useState } from 'react'
import type { ExecutionHostId } from '../../../src/shared/execution-host'
import type { RpcClient } from '../transport/rpc-client'
import { nativeChatRepoListRead } from '../session/mobile-session-read-operations'
import { getCachedRepos, setCachedRepos } from '../cache/repo-cache'
import { useLastVisitedWorktreeRepoId } from '../worktree/use-last-visited-worktree-repo'
import {
  getMobileNewWorkspaceDialogEligibleRepos,
  refreshMobileNewWorkspaceDialogSelectedRepo,
  resolveMobileNewWorkspaceDialogRepoId
} from '../worktree/new-workspace-dialog-repo-selection'
import type { MobileWorkspaceRepo } from './new-worktree-modal-types'

const NO_SERVER_CLIENTS: ReadonlyMap<ExecutionHostId, RpcClient> = new Map()

/** One host's repos, or null when it refused or failed to answer. */
async function listHostRepos(client: RpcClient): Promise<MobileWorkspaceRepo[] | null> {
  const listed = nativeChatRepoListRead.interpret(await nativeChatRepoListRead.request(client))
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Preserve the established response shape at this boundary.
  return listed.accepted ? (listed.value as MobileWorkspaceRepo[]) : null
}

/**
 * The desktop's repos, then each reachable server's tagged with that server, as the desktop's
 * composer offers them; null when the desktop's own list did not land. A server's SSH repos are
 * left out: their connection is the server's, which the phone's SSH gate cannot read.
 */
export async function listNewWorkspaceRepos(
  client: RpcClient,
  serverClients: ReadonlyMap<ExecutionHostId, RpcClient>
): Promise<{ desktop: MobileWorkspaceRepo[]; all: MobileWorkspaceRepo[] } | null> {
  const [desktop, ...servers] = await Promise.all([
    listHostRepos(client),
    ...[...serverClients].map(async ([executionHostId, serverClient]) =>
      ((await listHostRepos(serverClient).catch(() => null)) ?? [])
        .filter((repo) => !repo.connectionId)
        .map((repo) => ({ ...repo, executionHostId }))
    )
  ])
  return desktop ? { desktop, all: [...desktop, ...servers.flat()] } : null
}

export function useNewWorkspaceRepositories(args: {
  client: RpcClient | null
  /** The desktop's servers this phone can reach now, whose repos are offered too. */
  serverClients?: ReadonlyMap<ExecutionHostId, RpcClient>
  hostId?: string
  visible: boolean
}): {
  repos: MobileWorkspaceRepo[]
  selectedRepo: MobileWorkspaceRepo | null
  setSelectedRepo: (repo: MobileWorkspaceRepo | null) => void
  loading: boolean
} {
  const { client, serverClients = NO_SERVER_CLIENTS, hostId, visible } = args
  const [initialRepos] = useState(() =>
    hostId ? (getCachedRepos(hostId) as MobileWorkspaceRepo[] | null) : null
  )
  const [repos, setRepos] = useState<MobileWorkspaceRepo[]>(initialRepos ?? [])
  const [selectedRepo, setSelectedRepo] = useState<MobileWorkspaceRepo | null>(null)
  const [loading, setLoading] = useState(initialRepos == null)
  const lastVisitedRepo = useLastVisitedWorktreeRepoId(hostId, visible)

  useEffect(() => {
    if (!visible || !lastVisitedRepo.loaded || selectedRepo || repos.length === 0) {
      return
    }
    const eligibleRepos = getMobileNewWorkspaceDialogEligibleRepos(repos)
    const preferredRepoId = resolveMobileNewWorkspaceDialogRepoId({
      eligibleRepos,
      activeRepoId: lastVisitedRepo.repoId
    })
    const preferredRepo = repos.find((repo) => repo.id === preferredRepoId) ?? null
    if (preferredRepo) {
      setSelectedRepo(preferredRepo)
    }
  }, [lastVisitedRepo.loaded, lastVisitedRepo.repoId, repos, selectedRepo, visible])

  useEffect(() => {
    if (!visible || !client) {
      return
    }
    let stale = false
    setLoading(true)
    void listNewWorkspaceRepos(client, serverClients)
      .then((listed) => {
        if (stale || !listed) {
          return
        }
        const listedRepos = listed.all
        setRepos(listedRepos)
        // Only the desktop's own: a cached server repo could outlive that server's reachability.
        if (hostId) {
          setCachedRepos(hostId, listed.desktop)
        }
        setSelectedRepo((current) =>
          refreshMobileNewWorkspaceDialogSelectedRepo(listedRepos, current)
        )
      })
      .catch(() => undefined)
      .finally(() => {
        if (!stale) {
          setLoading(false)
        }
      })
    return () => {
      stale = true
    }
  }, [visible, client, serverClients, hostId])

  return { repos, selectedRepo, setSelectedRepo, loading: loading && repos.length === 0 }
}
