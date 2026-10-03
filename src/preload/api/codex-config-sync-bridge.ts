import { ipcRenderer } from 'electron'
import type {
  CodexConfigSyncStatus,
  CodexSharedSettingsNotice
} from '../../shared/codex-config-sync-types'
import type { PreloadApi } from '../api-types'

export const codexConfigSyncApi = {
  status: (): Promise<CodexConfigSyncStatus> => ipcRenderer.invoke('codexConfigSync:status'),
  sharedSettingsNotice: (): Promise<CodexSharedSettingsNotice | null> =>
    ipcRenderer.invoke('codexConfigSync:sharedSettingsNotice')
} satisfies PreloadApi['codexConfigSync']
