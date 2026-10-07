import type { RuntimeTerminalWait } from '../../shared/runtime-terminal-contracts'
import type { TuiAgent } from '../../shared/tui-agent'
import { resolveDraftPasteReadyTimeoutMs } from '../../shared/draft-paste-ready-timeout'
import type { LaunchedAgentReadinessRuntime } from './launched-agent-composer-readiness'

/** Uses the existing guarded scanner with main's draft/submit selection and composer budget. */
export async function waitForDesktopNewTabComposer(
  runtime: LaunchedAgentReadinessRuntime,
  handle: string,
  agent: TuiAgent,
  submit: boolean
): Promise<RuntimeTerminalWait | 'budget-spent'> {
  try {
    return await runtime.waitForFreshWorkerComposer(
      handle,
      agent,
      resolveDraftPasteReadyTimeoutMs(agent),
      {
        requireComposerMarker: false,
        stopOnDialog: true,
        submit
      }
    )
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'timeout') {
      throw error
    }
    if (agent === 'codex') {
      return { handle, condition: 'tui-idle', satisfied: false, status: 'running', exitCode: null }
    }
  }
  const fallback = await runtime.waitForTerminal(handle, {
    condition: 'tui-idle',
    timeoutMs: 1_000,
    launchReadiness: true
  })
  return fallback.satisfied ? 'budget-spent' : fallback
}
