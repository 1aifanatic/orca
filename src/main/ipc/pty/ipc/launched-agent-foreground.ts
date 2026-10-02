import { getPtyIpc } from '../../pty-host-bindings'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'
import type { LaunchedAgentForeground } from '../../../runtime/launched-agent-foreground'

/** The renderer's launch-prompt receipt asks the question #24257's crash guard asks before a paste. */
export function installLaunchedAgentForegroundIpcHandler(
  runtime: OrcaRuntimeService | undefined
): void {
  getPtyIpc().handle(
    'pty:readLaunchedAgentForeground',
    async (_event, args: { id: string; agent: string }): Promise<LaunchedAgentForeground> => {
      if (!runtime || typeof args?.id !== 'string' || !isTuiAgent(args.agent)) {
        return 'unknown'
      }
      return runtime.readLaunchedAgentForeground(args.id, args.agent)
    }
  )
}
