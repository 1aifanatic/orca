import { ipcMain } from 'electron'
import { registerManagedServerActions } from '../runtime/managed-server-actions-registry'
import { createManagedOrcadActions, type ManagedOrcadActionOptions } from './managed-orcad-actions'
import { requiredString } from './orcad-runtime-lifecycle-handlers'

export function registerOrcadRuntimeMaintenanceHandlers(options: ManagedOrcadActionOptions): void {
  const actions = createManagedOrcadActions(options)
  // Why: the CLI reaches these same actions over runtime RPC (managedServer.*).
  registerManagedServerActions(actions)
  ipcMain.handle(
    'runtimeEnvironments:updateOrcad',
    (_event, args: { selector: string; force?: boolean }) =>
      actions.update(requiredString(args?.selector, 'Server'), args?.force === true)
  )
  ipcMain.handle('runtimeEnvironments:rollbackOrcad', (_event, args: { selector: string }) =>
    actions.rollback(requiredString(args?.selector, 'Server'))
  )
  ipcMain.handle('runtimeEnvironments:recoverOrcad', (_event, args: { selector: string }) =>
    actions.recover(requiredString(args?.selector, 'Server'))
  )
  ipcMain.handle('runtimeEnvironments:stopOrcad', (_event, args: { selector: string }) =>
    actions.stop(requiredString(args?.selector, 'Server'))
  )
  ipcMain.handle('runtimeEnvironments:cancelOrcadStop', (_event, args: { selector: string }) =>
    actions.cancelStop(requiredString(args?.selector, 'Server'))
  )
}
