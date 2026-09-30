import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../../shared/electron-remote-runtime-client-capabilities'
import { isWebClientLocation } from '@/lib/web-client-location'
import { WEB_RUNTIME_CLIENT_CAPABILITIES } from '@/web/web-runtime-client-capabilities'

/** What this client tells a paired host it can do: the desktop's list, or the browser client's. */
export function pairedHostClientCapabilities(): readonly string[] {
  return isWebClientLocation()
    ? WEB_RUNTIME_CLIENT_CAPABILITIES
    : ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES
}
