import type { UISlicePreferences } from './ui-slice-contract-preferences'

/** Workspace reveals (and the filter lifting that serves them) only apply while the workspace
 *  list is the sidebar body; in the activity view they are skipped, never redirected. */
export function isSidebarOnWorkspaceList(state: {
  sidebarBody?: UISlicePreferences['sidebarBody']
}): boolean {
  return state.sidebarBody !== 'agents'
}
