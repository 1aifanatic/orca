import { toSshExecutionHostId } from '../../../../shared/execution-host'
import { rejectPaneSpawnReservation, reserveIdlePaneSpawn } from '../pane/spawn-reservation'
import { ptySizes } from '../delivery/visibility-state'
import {
  beginPtyIpcSpawn,
  resolveEarlyPaneKey,
  resolveEarlyPaneSpawnReservationKey
} from './spawn-begin'
import { resolveStablePaneOwner } from '../pane/stable-owner'
import { preparePtyIpcSpawnPreflight } from './spawn-preflight'
import { assemblePtyIpcSpawnEnv } from './spawn-env'
import { buildPtyIpcSpawnOptions } from './spawn-options'
import { executePtyIpcSpawn } from './spawn-execute'
import { commitPtyIpcSpawn } from './spawn-commit'
import { createPtyIpcSpawnState, type PtyIpcSpawnState } from './spawn-state'
import { triggerPtySpawnPushTargetMaterialization } from './spawn-push-target-materialization'
import type { PtySpawnIpcArgs, PtySpawnIpcDeps } from './spawn-types'

function releaseAbandonedAgentTeamsLeader(ctx: PtyIpcSpawnState): void {
  if (!ctx.agentTeamsLeaderHandle) {
    return
  }
  ctx.deps.runtime?.releaseClaudeAgentTeamsLeaderForHandle?.(ctx.agentTeamsLeaderHandle)
  ctx.agentTeamsLeaderHandle = null
}

function restoreProvisionalPtySize(ctx: PtyIpcSpawnState): void {
  if (ctx.effectiveSessionId === undefined) {
    return
  }
  const key = ctx.effectiveSessionAppId ?? ctx.effectiveSessionId
  if (ctx.hadSessionSizeBeforeAttach && ctx.sessionSizeBeforeAttach) {
    ptySizes.set(key, ctx.sessionSizeBeforeAttach)
  } else {
    ptySizes.delete(key)
  }
}

export async function runPtyIpcSpawn(deps: PtySpawnIpcDeps, args: PtySpawnIpcArgs) {
  const ctx = createPtyIpcSpawnState(deps, args)
  const replacedPaneKey =
    args.replacesPtyId !== undefined ? resolveEarlyPaneSpawnReservationKey(args) : null
  if (replacedPaneKey) {
    // Why: hold the pane across the stop, so a spawn for it arriving meanwhile (a hidden tab
    // revealed mid-restart) joins the replacement instead of reattaching the owner being stopped.
    ctx.paneSpawnReservation = await reserveIdlePaneSpawn(replacedPaneKey)
    ctx.paneSpawnReservationKey = replacedPaneKey
  }
  try {
    if (args.replacesPtyId !== undefined) {
      const owner = resolveStablePaneOwner(
        deps.runtime,
        deps.store,
        resolveEarlyPaneKey(args),
        args.worktreeId,
        args.connectionId
      )
      if (owner && owner.ptyId !== args.replacesPtyId) {
        throw new Error('terminal_pane_owner_changed')
      }
      await deps.stopReplacedPty(args.replacesPtyId)
      // A stopped daemon session is tombstoned; retire its binding before owner resolution can reattach it.
      if (
        owner?.hasPersistedBinding &&
        args.worktreeId &&
        !(await deps.store?.retirePtyBinding(
          {
            worktreeId: args.worktreeId,
            tabId: owner.tabId,
            leafId: owner.leafId,
            ptyId: owner.ptyId,
            incarnationId: owner.persistedIncarnationId
          },
          args.connectionId ? toSshExecutionHostId(args.connectionId) : undefined
        ))
      ) {
        throw new Error('terminal_pane_owner_changed')
      }
    }
    triggerPtySpawnPushTargetMaterialization(deps, args)
    const early = await beginPtyIpcSpawn(ctx)
    if (early) {
      return early
    }
    await preparePtyIpcSpawnPreflight(ctx)
    await assemblePtyIpcSpawnEnv(ctx)
    const earlyReserved = await buildPtyIpcSpawnOptions(ctx).catch((error: unknown) => {
      restoreProvisionalPtySize(ctx)
      throw error
    })
    if (earlyReserved) {
      // Why: this request lost the pane to the reservation winner, so its
      // pre-allocated leader handle never binds to a PTY. Nothing else can
      // evict the team env assembly created for it — exit/close cleanup keys
      // off handleByPtyId — so every lost race would leak one team forever.
      releaseAbandonedAgentTeamsLeader(ctx)
      return earlyReserved
    }
    await executePtyIpcSpawn(ctx)
    return await commitPtyIpcSpawn(ctx)
  } catch (err) {
    releaseAbandonedAgentTeamsLeader(ctx)
    if (ctx.preSpawnHiddenMarkId !== null) {
      ctx.deps.transitionSpawnHiddenRendererPtyDeliveryState(ctx.preSpawnHiddenMarkId, false)
    }
    if (ctx.pendingRegistrationPtyId) {
      deps.runtime?.cancelPendingPtyRegistration?.(
        ctx.pendingRegistrationPtyId,
        ctx.rejectedRegistrationCandidate?.incarnationId
      )
      ctx.pendingRegistrationPtyId = null
    }
    // Why: once the reservation is created, any later throw —
    // spawn failure, persist failure, or a post-spawn helper such as
    // seedHeadlessTerminal/registerPty/track — must settle it. Otherwise
    // it lingers in paneSpawnReservationsByOwnerKey and every future spawn
    // for this pane awaits a promise that never resolves. reject is a
    // no-op once the reservation has already resolved.
    rejectPaneSpawnReservation(ctx.paneSpawnReservationKey, ctx.paneSpawnReservation, err)
    throw err
  } finally {
    ctx.releaseWorktreeSpawn?.()
    ctx.finishTerminalInstall()
  }
}
