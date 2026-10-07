import { ipcRenderer } from 'electron'
import type {
  RemoteWorkspaceChangedEvent,
  RemoteWorkspacePushStatusEvent
} from '../../shared/remote-workspace-types'
import type { PreloadApi } from '../api-types'

export const remoteWorkspaceApi = {
  get: (args) => ipcRenderer.invoke('remoteWorkspace:get', args),
  importPeerTopology: (pull) => ipcRenderer.invoke('remoteWorkspace:importPeerTopology', pull),
  listEnabledConnectedTargets: () =>
    ipcRenderer.invoke('remoteWorkspace:listEnabledConnectedTargets'),
  listConnectedClients: (args) => ipcRenderer.invoke('remoteWorkspace:listConnectedClients', args),
  clientId: () => ipcRenderer.invoke('remoteWorkspace:clientId'),
  onChanged: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, data: RemoteWorkspaceChangedEvent) =>
      callback(data)
    ipcRenderer.on('remoteWorkspace:changed', listener)
    return () => ipcRenderer.removeListener('remoteWorkspace:changed', listener)
  },
  onPushStatus: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, data: RemoteWorkspacePushStatusEvent) =>
      callback(data)
    ipcRenderer.on('remoteWorkspace:pushStatus', listener)
    return () => ipcRenderer.removeListener('remoteWorkspace:pushStatus', listener)
  }
} satisfies PreloadApi['remoteWorkspace']
