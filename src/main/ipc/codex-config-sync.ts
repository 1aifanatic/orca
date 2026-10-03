import { ipcMain } from 'electron'
import { join } from 'node:path'
import { getSystemCodexHomePath, resolveOrcaManagedCodexHomePath } from '../codex/codex-home-paths'
import { getCodexConfigSyncStatus } from '../codex/config-sync-stall'
import { resolveCodexSharedSettingsNotice } from '../codex-accounts/codex-shared-settings-notice'
import type {
  CodexConfigSyncStatus,
  CodexSharedSettingsNotice
} from '../../shared/codex-config-sync-types'
import type { CodexMirroredHomeStatus } from '../codex-accounts/runtime-home-service'

/** The read-only slice of the runtime home service these channels need. */
type CodexMirroredHomeResolver = {
  getMirroredHostHomePathForStatus: () => CodexMirroredHomeStatus
  isHostSystemDefaultRealHome: () => boolean
}

/** Registers the read-only IPC channels for Codex config sync health and the Windows shared-settings notice. */
export function registerCodexConfigSyncHandlers(runtimeHome: CodexMirroredHomeResolver): void {
  ipcMain.removeHandler('codexConfigSync:status')
  ipcMain.handle('codexConfigSync:status', (): CodexConfigSyncStatus => {
    const systemHomePath = getSystemCodexHomePath()
    const mirrored = runtimeHome.getMirroredHostHomePathForStatus()
    if (mirrored.kind === 'unavailable') {
      // Why: do not throw — the settings pane catches thrown status errors and
      // would show nothing at all. Report the stall so the user sees why.
      return {
        state: 'stalled',
        reason: 'managed-home-unavailable',
        systemConfigPath: join(systemHomePath, 'config.toml')
      }
    }
    const runtimeHomePath = mirrored.homePath
    if (!runtimeHomePath) {
      // Why: the system default runs Codex directly against ~/.codex, so there
      // is no mirror that can fall behind. Reporting on the shared home here
      // would warn about a config that lane never reads.
      return {
        state: 'synced',
        reason: null,
        systemConfigPath: join(systemHomePath, 'config.toml')
      }
    }
    return getCodexConfigSyncStatus({ runtimeHomePath, systemHomePath })
  })

  ipcMain.removeHandler('codexConfigSync:sharedSettingsNotice')
  ipcMain.handle('codexConfigSync:sharedSettingsNotice', (): CodexSharedSettingsNotice | null => {
    if (process.platform !== 'win32' || !runtimeHome.isHostSystemDefaultRealHome()) {
      return null
    }
    try {
      return resolveCodexSharedSettingsNotice(
        resolveOrcaManagedCodexHomePath(),
        getSystemCodexHomePath()
      )
    } catch {
      // Why quiet: the renderer asks once per session, so a locked file just waits for the next one.
      return null
    }
  })
}
