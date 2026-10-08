import { ipcRenderer } from 'electron'
import type { PreloadApi } from '../api-types'
import type { TerminalTopologySlice } from '../../shared/terminal-topology-slice'

export const sessionApi = {
  // hostId is optional; main defaults it to 'local' so existing omitting call sites keep the local session partition.
  get: (hostId) => ipcRenderer.invoke('session:get', hostId),
  listHostIds: () => ipcRenderer.invoke('session:list-host-ids'),
  set: (args, hostId) => ipcRenderer.invoke('session:set', args, hostId),
  patch: (args, hostId) => ipcRenderer.invoke('session:patch', args, hostId),
  createTerminalSurface: (args) => ipcRenderer.invoke('session:terminal-create-surface', args),
  closeTerminalSurface: (args) => ipcRenderer.invoke('session:close-terminal-surface', args),
  commitTerminalSleepingRecords: (changes) =>
    ipcRenderer.invoke('session:commit-terminal-sleeping-records', changes),
  setTerminalLayout: (args) => ipcRenderer.invoke('session:terminal-set-layout', args),
  bindTerminalLeaf: (args) => ipcRenderer.invoke('session:terminal-bind-leaf', args),
  clearTerminalLaunchAgent: (args) =>
    ipcRenderer.invoke('session:terminal-clear-launch-agent', args),
  getTerminalTopologySlices: () => ipcRenderer.invoke('session:get-terminal-topology-slices'),
  onTerminalTopologyChanged: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, slice: TerminalTopologySlice): void =>
      callback(slice)
    ipcRenderer.on('session:terminal-topology-changed', listener)
    return () => ipcRenderer.removeListener('session:terminal-topology-changed', listener)
  },
  flush: () => ipcRenderer.invoke('session:flush'),
  readTerminalScrollback: (args) =>
    ipcRenderer.sendSync('session:read-terminal-scrollback-sync', args),
  /** Synchronous session save for beforeunload — blocks until flushed to disk. */
  setSync: (args, hostId) => {
    ipcRenderer.sendSync('session:set-sync', args, hostId)
  }
} satisfies PreloadApi['session']
