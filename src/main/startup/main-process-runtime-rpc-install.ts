// The runtime RPC server the launch serves chats, mobile and remote clients over.

import { app } from 'electron'
import { is } from '@electron-toolkit/utils'
import {
  getCanonicalUserDataPath,
  migrateMobilePairingDataToCanonicalUserDataPath
} from '../persistence'
import { OrcaRuntimeRpcServer } from '../runtime/runtime-rpc'
import { registerMobileHandlers } from '../ipc/mobile'
import { getDesktopRelayStatus } from './main-process-relay-status'
import { getBundledWebClientRoot, type getServeOptions } from './main-process-serve'
import { mainProcessState as state } from './main-process-state'

type RuntimeService = NonNullable<typeof state.runtime>

export function installRuntimeRpc(
  runtime: RuntimeService,
  serveOptions: ReturnType<typeof getServeOptions> | null
): OrcaRuntimeRpcServer {
  // Why: existing installs may have pairing creds under the late app.getPath('userData'); copy them forward before switching to the canonical path.
  migrateMobilePairingDataToCanonicalUserDataPath(app.getPath('userData'))
  // Why: parallel E2E Electron instances would race the fixed port (EADDRINUSE); port 0 gives each a random OS-assigned port.
  const isE2E = Boolean(process.env.ORCA_E2E_USER_DATA_DIR)
  const requestedE2EWsPort = process.env.ORCA_E2E_RUNTIME_WS_PORT
  const e2eWsPort = requestedE2EWsPort === undefined ? 0 : Number(requestedE2EWsPort)
  if (isE2E && (!Number.isInteger(e2eWsPort) || e2eWsPort < 0 || e2eWsPort > 65_535)) {
    throw new Error(`Invalid ORCA_E2E_RUNTIME_WS_PORT value: ${requestedE2EWsPort}`)
  }
  // Why: pin dev to 6769 so `pnpm dev` doesn't race packaged Orca on 6768 and fall back to a random port, breaking deterministic mobile pairing/repro (STA-1511).
  const devWsPort = is.dev && !isE2E ? 6769 : undefined
  const runtimeRpc = new OrcaRuntimeRpcServer({
    runtime,
    // Why: mobile pairing needs the stable pre-setName() path (getCanonicalUserDataPath), not a late app.getPath('userData') that drops paired devices across restarts.
    userDataPath: getCanonicalUserDataPath(),
    enableWebSocket: true,
    // Why: STA-2370 — the desktop app binds the WS listener to loopback until the user pairs a device;
    // `orca serve` is an explicit remote opt-in, and E2E keeps the wide bind its harness connects over.
    exposeNetworkByDefault: Boolean(serveOptions) || isE2E,
    ...(isE2E ? { wsPort: e2eWsPort } : {}),
    ...(devWsPort !== undefined ? { wsPort: devWsPort } : {}),
    ...(serveOptions?.wsPort !== undefined
      ? {
          wsPort: serveOptions.wsPort,
          // Why: only explicit `orca serve --port` overrides a stale STA-1511 fallback (issue #8535); default/dev stay fallback-first for pairing stability.
          preferPinnedWsPort: true
        }
      : {}),
    webClientRoot: getBundledWebClientRoot()
  })
  state.runtimeRpc = runtimeRpc
  registerMobileHandlers(runtimeRpc, {
    getRelayStatus: getDesktopRelayStatus,
    consumePendingUnpairedDeviceAuthFailure: (webContentsId) => {
      if (
        !state.mainWindow ||
        state.mainWindow.isDestroyed() ||
        state.mainWindow.webContents.id !== webContentsId ||
        !state.pendingUnpairedDeviceAuthFailure
      ) {
        return false
      }
      state.pendingUnpairedDeviceAuthFailure = false
      return true
    }
  })
  // Why: repeated direct auth failures otherwise look like a client that never connects; point users to re-pairing.
  runtimeRpc.setOnUnpairedDeviceAuthFailure(() => {
    // Why: runtime startup races renderer mount; retain the one-shot until the listener consumes it.
    state.pendingUnpairedDeviceAuthFailure = true
    if (state.mainWindow && !state.mainWindow.isDestroyed()) {
      state.mainWindow.webContents.send('mobile:unpairedDeviceAuthFailure')
    }
  })
  return runtimeRpc
}
