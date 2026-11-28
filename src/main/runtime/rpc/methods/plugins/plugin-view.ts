import { defineMethod } from '../../core'
import type { PluginViewDesktop } from '../../../../plugins/view/plugin-view-desktop'
import {
  PluginOpenParams,
  PluginShotChromeParams,
  PluginShotEditorParams,
  PluginShotParams,
  PluginShotReplayParams
} from '../../../../../shared/rpc-contract/plugins/plugins-params'

import { resolvePluginViewForRpc, setPluginViewForRpc } from './plugin-rpc-slots'

export { setPluginViewForRpc }

async function requirePluginView(): Promise<PluginViewDesktop> {
  const view = await resolvePluginViewForRpc()
  if (!view) {
    throw new Error('Showing plugin panels is only available in the Orca desktop app')
  }
  return view
}

export const PLUGIN_VIEW_METHODS = [
  defineMethod({
    // Renderer state only: the window is never shown, raised or focused.
    name: 'plugins.open',
    permission: 'host-admin',
    params: PluginOpenParams,
    handler: async (params) => (await requirePluginView()).open(params)
  }),
  defineMethod({
    name: 'plugins.shot',
    permission: 'host-admin',
    params: PluginShotParams,
    handler: async (params) => (await requirePluginView()).shot(params)
  }),
  defineMethod({
    name: 'plugins.shotEditor',
    permission: 'host-admin',
    params: PluginShotEditorParams,
    handler: async (params) => (await requirePluginView()).shotEditor(params)
  }),
  defineMethod({
    name: 'plugins.shotChrome',
    permission: 'host-admin',
    params: PluginShotChromeParams,
    handler: async (params) => (await requirePluginView()).shotChrome(params)
  }),
  defineMethod({
    // Never opens the plugin's panel or reaches its guest or worker; see plugin-view-replay-shot.
    name: 'plugins.shotReplay',
    permission: 'host-admin',
    params: PluginShotReplayParams,
    handler: async (params) => (await requirePluginView()).shotReplay(params)
  })
]
