import { z } from 'zod'
import { toRuntimeExecutionHostId } from './execution-host'
import type { ExecutionHostHealth } from './execution-host-health'

// Why: both are answered by the paired desktop itself; the phone lists servers the desktop shows.
export const MOBILE_RELAY_HOSTS_LIST_METHOD = 'mobileRelay.hosts.list'
export const MOBILE_RELAY_HOST_WORKTREES_METHOD = 'mobileRelay.hosts.worktrees'

/** Whether the desktop can relay the phone to this server now; `update-needed` is the server's build. */
export type MobileRelayHostRelay = 'ready' | 'update-needed' | 'unavailable'

export type MobileRelayHost = {
  hostId: `runtime:${string}`
  label: string
  health: ExecutionHostHealth
  relay: MobileRelayHostRelay
}

export type MobileRelayHostsListResult = { hosts: MobileRelayHost[] }

export const MobileRelayHostWorktreesParamsSchema = z
  .object({ hostId: z.string().min(1).max(1024) })
  .strict()

/** One of a server's own `worktree.ps` rows (RuntimeWorktreePsSummary), carrying the server's host id. */
export type MobileRelayServerWorktreeRow = Record<string, unknown> & { hostId: `runtime:${string}` }

/**
 * The server's own `worktree.ps` rows as the desktop last fetched them. `stale` means this call
 * could not refresh them; rows are never rewritten beyond their host id.
 */
export type MobileRelayHostWorktreesResult =
  | {
      worktrees: MobileRelayServerWorktreeRow[]
      totalCount: number
      truncated: boolean
      fetchedAt: number
      stale: boolean
    }
  | { worktrees: null }

/**
 * A server's rows name hosts relative to that server (`local`, its own `ssh:` targets). Like the
 * desktop sidebar, the phone shows every one of them under the server, so all become its host id.
 */
export function stampServerWorktreeRows<Row extends { hostId?: string }>(
  environmentId: string,
  rows: readonly Row[]
): (Row & { hostId: `runtime:${string}` })[] {
  const hostId = toRuntimeExecutionHostId(environmentId)
  return rows.map((row) => ({ ...row, hostId }))
}
