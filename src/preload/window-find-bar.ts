import { installWindowFindBar } from './window-find-bar-controller'

// Why: raw require keeps the sandboxed preload standalone in the main-process CJS build.
const { ipcRenderer } = require('electron')

// Why no contextBridge: the bar page is Orca's own static markup; it never needs to call main itself.
window.addEventListener('DOMContentLoaded', () => installWindowFindBar(document, ipcRenderer))
