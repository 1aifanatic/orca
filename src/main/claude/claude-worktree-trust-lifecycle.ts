import type { GlobalSettings } from '../../shared/global-settings-types'
import type { Repo } from '../../shared/repo-types'
import {
  CLAUDE_TRUST_CONVERGE_METHOD,
  readClaudeTrustConfigEnv,
  type ClaudeFolderTrustSpawnRequest,
  type ClaudeTrustConvergeParams
} from '../../shared/claude-folder-trust-spawn-request'
import { resolveTuiAgentLaunchEnv } from '../../shared/tui-agent-launch-defaults'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import { getActiveMultiplexer } from '../ssh/ssh-target-registry'
import { resolveClaudeWorktreeTrustTarget } from './claude-worktree-trust-eligibility'
import {
  convergeClaudeWorktreesTrustOnHost,
  type ClaudeWorktreeTrustHostRequest
} from './claude-worktree-trust-host'
import { resolveLocalClaudeTrustRequest } from './claude-worktree-trust-spawn'

type LifecycleStore = {
  getRepo: (repoId: string) => Repo | undefined
  getWorktreeMeta: (worktreeId: string) => WorktreeMeta | undefined
  getAllWorktreeMeta: () => Record<string, WorktreeMeta>
  getSettings: () => Pick<GlobalSettings, 'claudeTrustOrcaWorktrees' | 'agentDefaultEnv'>
}

/** Targets resolve before the first await, so a removal still reads the metadata it drops next. */
async function revokeWorktrees(
  store: LifecycleStore,
  worktreeIds: readonly string[]
): Promise<void> {
  // Why: a user-set CLAUDE_CONFIG_DIR moved the grant into another file; revoke must find it there.
  const claudeLaunchEnv = resolveTuiAgentLaunchEnv('claude', store.getSettings().agentDefaultEnv)
  const localEnv = { ...process.env, ...claudeLaunchEnv }
  const local: ClaudeWorktreeTrustHostRequest[] = []
  const relayRequests = new Map<string, ClaudeFolderTrustSpawnRequest[]>()
  for (const worktreeId of worktreeIds) {
    const target = resolveClaudeWorktreeTrustTarget(store, worktreeId)
    if (target?.connectionId) {
      const requests = relayRequests.get(target.connectionId) ?? []
      requests.push({
        worktreeRoot: target.worktreeRoot,
        mainCheckoutPath: target.mainCheckoutPath,
        trusted: false
      })
      relayRequests.set(target.connectionId, requests)
    } else if (target) {
      const request = resolveLocalClaudeTrustRequest(
        { ...target, trusted: false },
        localEnv,
        null,
        null
      )
      if (request) {
        local.push(request)
      }
    }
  }
  // Why: one batch per host, so a large config is parsed once rather than once per worktree.
  const relayRevocations = [...relayRequests].map(async ([connectionId, requests]) => {
    const mux = getActiveMultiplexer(connectionId)
    if (!mux || mux.isDisposed?.()) {
      return
    }
    // Why: relays predating this method reject it; the entries then linger harmlessly.
    await mux.request(CLAUDE_TRUST_CONVERGE_METHOD, {
      requests,
      env: readClaudeTrustConfigEnv(claudeLaunchEnv)
    } satisfies ClaudeTrustConvergeParams)
  })
  await Promise.allSettled([convergeClaudeWorktreesTrustOnHost(local), ...relayRevocations])
}

/** Orca removes a worktree: its trust entry must not outlive it or pass to a reused path. */
export function revokeClaudeWorktreeTrustForRemoval(
  store: LifecycleStore,
  worktreeId: string
): void {
  // Why: cleanup must never gate the removal, so it runs detached and swallows failures.
  void revokeWorktrees(store, [worktreeId]).catch(() => {})
}

/** The setting turned off: withdraw every entry Orca wrote for its worktrees. */
export async function revokeAllClaudeWorktreeTrust(store: LifecycleStore): Promise<void> {
  await revokeWorktrees(store, Object.keys(store.getAllWorktreeMeta())).catch(() => {})
}
