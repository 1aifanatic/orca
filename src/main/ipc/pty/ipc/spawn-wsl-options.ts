import { prepareWslGuestTerminalSpawn } from '../../../wsl/wsl-guest-terminal-preparation'
import { clearProviderPtyState } from '../provider/state-cleanup'
import type { PtyIpcSpawnState } from './spawn-state'

export async function preparePtyIpcWslOptions(ctx: PtyIpcSpawnState): Promise<void> {
  if (!ctx.wslGuest || ctx.preAdoptedStablePane) {
    return
  }
  if (!ctx.wslGuest.fresh) {
    ctx.spawnOptions.sessionId = ctx.effectiveSessionAppId
    ctx.spawnOptions.attachOnly = true
    return
  }
  if (!ctx.guestHostEnvPolicy || !ctx.effectiveSessionId) {
    throw new Error('Guest terminal launch policy is unavailable')
  }
  try {
    ctx.spawnOptions = await prepareWslGuestTerminalSpawn(
      ctx.wslGuest.prepared,
      ctx.spawnOptions,
      ctx.guestHostEnvPolicy
    )
  } catch (error) {
    clearProviderPtyState(ctx.effectiveSessionId)
    throw error
  }
}
