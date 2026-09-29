import type { GlobalSettings } from '../../shared/global-settings-types'
import type { Repo } from '../../shared/repo-types'
import {
  CLAUDE_TRUST_CONVERGE_METHOD,
  type ClaudeFolderTrustSpawnRequest
} from '../../shared/claude-folder-trust-spawn-request'
import { resolveTuiAgentLaunchEnv } from '../../shared/tui-agent-launch-defaults'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import { getActiveMultiplexer } from '../ssh/ssh-target-registry'
import { resolveClaudeWorktreeTrustTarget } from './claude-worktree-trust-eligibility'
import { convergeClaudeWorktreeTrustOnHost } from './claude-worktree-trust-host'
import { resolveLocalClaudeTrustRequest } from './claude-worktree-trust-spawn'

type LifecycleStore = {
  getRepo: (repoId: string) => Repo | undefined
  getWorktreeMeta: (worktreeId: string) => WorktreeMeta | undefined
  getAllWorktreeMeta: () => Record<string, WorktreeMeta>
  getSettings: () => Pick<GlobalSettings, 'claudeTrustOrcaWorktrees' | 'agentDefaultEnv'>
}

async function revokeOne(store: LifecycleStore, worktreeId: string): Promise<void> {
  const target = resolveClaudeWorktreeTrustTarget(store, worktreeId)
  if (!target) {
    return
  }
  if (target.connectionId) {
    const mux = getActiveMultiplexer(target.connectionId)
    if (!mux || mux.isDisposed?.()) {
      return
    }
    const request: ClaudeFolderTrustSpawnRequest = {
      worktreeRoot: target.worktreeRoot,
      mainCheckoutPath: target.mainCheckoutPath,
      trusted: false
    }
    // Why: relays predating this method reject it; the entry then lingers harmlessly.
    await mux.request(CLAUDE_TRUST_CONVERGE_METHOD, { request }).catch(() => {})
    return
  }
  const request = resolveLocalClaudeTrustRequest(
    { ...target, trusted: false },
    {
      ...process.env,
      ...resolveTuiAgentLaunchEnv('claude', store.getSettings().agentDefaultEnv)
    },
    null,
    null
  )
  if (request) {
    await convergeClaudeWorktreeTrustOnHost(request)
  }
}

/** Orca removes a worktree: its trust entry must not outlive it or pass to a reused path. */
export function revokeClaudeWorktreeTrustForRemoval(
  store: LifecycleStore,
  worktreeId: string
): void {
  // Why: cleanup must never gate the removal, so it runs detached and swallows failures.
  void revokeOne(store, worktreeId).catch(() => {})
}

/** The setting turned off: withdraw every entry Orca wrote for its worktrees. */
export async function revokeAllClaudeWorktreeTrust(store: LifecycleStore): Promise<void> {
  for (const worktreeId of Object.keys(store.getAllWorktreeMeta())) {
    await revokeOne(store, worktreeId).catch(() => {})
  }
}
