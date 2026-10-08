import { z } from 'zod'
import { DELEGATED_MOBILE_DEVICES_RUNTIME_CAPABILITY } from '../../../shared/delegated-mobile-device-contract'
import {
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import { buildExecutionHostRegistry } from '../../../shared/execution-host-registry'
import type {
  MobileRelayHost,
  MobileRelayHostRelay,
  MobileRelayHostsListResult,
  MobileRelayHostWorktreesResult,
  MobileRelayServerWorktreeRow
} from '../../../shared/mobile-relay-hosts-contract'
import { lastVerifiedRuntimeStatus } from '../../../shared/runtime-host-status'
import type { RuntimeStatus } from '../../../shared/runtime-types'
import type { MobileDesktopRelayHosts } from './mobile-desktop-relay-hosts'

const WorktreePsReplySchema = z.object({
  worktrees: z.array(z.looseObject({})),
  totalCount: z.number(),
  truncated: z.boolean()
})

type CachedServerWorktrees = {
  fence: string
  fetchedAt: number
  worktrees: MobileRelayServerWorktreeRow[]
  totalCount: number
  truncated: boolean
}

type DescribedHost = MobileRelayHost & { environmentId: string; fence: string }

/**
 * The configured servers the desktop shows, for the phone: health from the desktop's own status
 * (the sidebar's mapping), and each server's workspace list as the desktop itself last fetched it,
 * so a server that is offline or too old to relay to still lists. Replies relayed to a phone are
 * never read here.
 */
export class MobileRelayHostCatalog {
  private readonly cached = new Map<string, CachedServerWorktrees>()
  private readonly refreshing = new Map<string, Promise<boolean>>()

  constructor(
    private readonly options: {
      hosts: MobileDesktopRelayHosts
      hostLabelOverrides: () => ReadonlyMap<ExecutionHostId, string>
      now?: () => number
    }
  ) {}

  list(): MobileRelayHostsListResult {
    return {
      hosts: this.describe().map(({ hostId, label, health, relay }) => ({
        hostId,
        label,
        health,
        relay
      }))
    }
  }

  async worktrees(hostId: string): Promise<MobileRelayHostWorktreesResult> {
    const parsed = parseExecutionHostId(hostId)
    const host =
      parsed?.kind === 'runtime'
        ? this.describe().find((entry) => entry.environmentId === parsed.environmentId)
        : undefined
    if (!host) {
      return { worktrees: null }
    }
    const refreshed = host.health === 'available' && (await this.refresh(host))
    const cached = this.cached.get(host.environmentId)
    // Why: rows from before a re-pair may belong to a different server.
    if (!cached || cached.fence !== host.fence) {
      return { worktrees: null }
    }
    const { fence: _fence, ...rows } = cached
    return { ...rows, stale: !refreshed }
  }

  private describe(): DescribedHost[] {
    const { environments, statusByEnvironmentId } = this.options.hosts.list()
    const fences = new Map(environments.map((environment) => [environment.id, environment.fence]))
    return buildExecutionHostRegistry({
      repos: [],
      settings: null,
      hostSource: 'configured-only',
      runtimeEnvironments: environments,
      runtimeStatusByEnvironmentId: statusByEnvironmentId,
      hostLabelOverrides: this.options.hostLabelOverrides()
    }).flatMap((entry) => {
      const parsed = parseExecutionHostId(entry.id)
      const fence = parsed?.kind === 'runtime' ? fences.get(parsed.environmentId) : undefined
      if (parsed?.kind !== 'runtime' || fence === undefined) {
        return []
      }
      const answer = lastVerifiedRuntimeStatus(statusByEnvironmentId.get(parsed.environmentId))
      return [
        {
          hostId: parsed.id,
          environmentId: parsed.environmentId,
          fence,
          label: entry.label,
          health: entry.health,
          relay: relayVerdict(entry.health, answer)
        }
      ]
    })
  }

  private refresh(host: DescribedHost): Promise<boolean> {
    const inFlight = this.refreshing.get(host.environmentId)
    if (inFlight) {
      return inFlight
    }
    const refresh = this.fetchAsDesktop(host).finally(() =>
      this.refreshing.delete(host.environmentId)
    )
    this.refreshing.set(host.environmentId, refresh)
    return refresh
  }

  private async fetchAsDesktop(host: DescribedHost): Promise<boolean> {
    try {
      const resolved = await this.options.hosts.resolve(host.environmentId)
      if (!resolved) {
        return false
      }
      const response = await this.options.hosts.call(resolved, 'worktree.ps', {
        supportsWorktreeVisibilitySourceDefaults: true
      })
      const reply = response.ok ? WorktreePsReplySchema.safeParse(response.result) : null
      if (!reply?.success) {
        return false
      }
      this.cached.set(host.environmentId, {
        // Why the listing's fence, taken before the fetch: a re-pair mid-fetch must not adopt these rows.
        fence: host.fence,
        fetchedAt: (this.options.now ?? Date.now)(),
        worktrees: stampServerWorktreeRows(host.environmentId, reply.data.worktrees),
        totalCount: reply.data.totalCount,
        truncated: reply.data.truncated
      })
      return true
    } catch {
      // An unreachable server keeps its last rows; they are served as stale.
      return false
    }
  }
}

function relayVerdict(
  health: MobileRelayHost['health'],
  answer: RuntimeStatus | null
): MobileRelayHostRelay {
  if (!answer) {
    return 'unavailable'
  }
  // Why: a build's capabilities do not expire, so an old server stays update-needed while offline.
  if (!(answer.capabilities ?? []).includes(DELEGATED_MOBILE_DEVICES_RUNTIME_CAPABILITY)) {
    return 'update-needed'
  }
  return health === 'available' ? 'ready' : 'unavailable'
}

/**
 * A server's rows name hosts relative to that server (`local`, its own `ssh:` targets). Like the
 * desktop sidebar, the phone shows every one of them under the server, so all become its host id.
 */
function stampServerWorktreeRows<Row extends { hostId?: string }>(
  environmentId: string,
  rows: readonly Row[]
): (Row & { hostId: `runtime:${string}` })[] {
  const hostId = toRuntimeExecutionHostId(environmentId)
  return rows.map((row) => ({ ...row, hostId }))
}
