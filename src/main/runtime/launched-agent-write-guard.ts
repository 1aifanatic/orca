import type { TuiAgent } from '../../shared/tui-agent'
import type { OrcaRuntimeService } from './orca-runtime'

/** A shell back at its prompt turns bracketed paste on, and Orca's shell integration marks it. */
const SHELL_RETURN_MARKERS = ['\x1b[?2004', '\x1b]133;'] as const
const MARKER_CARRY_CHARS = Math.max(...SHELL_RETURN_MARKERS.map((marker) => marker.length)) - 1

export type LaunchedAgentWriteGuardRuntime = Pick<
  OrcaRuntimeService,
  'isLaunchShellInFront' | 'subscribeToTerminalData'
>

/**
 * The check before each write of a launch prompt: the paste, its Enter, and Codex's second Enter.
 * A shell proven in front refuses the write. Once a read finds none, later writes reuse it until the
 * terminal shows a shell coming back to its prompt, so Enter follows the paste on the desktop's
 * timing instead of waiting out another process read.
 */
export function createLaunchedAgentWriteGuard(
  runtime: LaunchedAgentWriteGuardRuntime,
  agent: TuiAgent
): { beforeWrite: (ptyId: string) => Promise<void>; dispose: () => void } {
  let cleared: { ptyId: string; shellMayHaveReturned: boolean; unsubscribe: () => void } | null =
    null
  const dispose = (): void => {
    cleared?.unsubscribe()
    cleared = null
  }
  const beforeWrite = async (ptyId: string): Promise<void> => {
    if (cleared?.ptyId === ptyId && !cleared.shellMayHaveReturned) {
      return
    }
    dispose()
    let carry = ''
    const watch = { ptyId, shellMayHaveReturned: false, unsubscribe: (): void => {} }
    // Subscribed before the read, so a shell that returns while it runs is not missed.
    watch.unsubscribe = runtime.subscribeToTerminalData(ptyId, (data) => {
      const window = carry + data
      carry = window.slice(-MARKER_CARRY_CHARS)
      if (SHELL_RETURN_MARKERS.some((marker) => window.includes(marker))) {
        watch.shellMayHaveReturned = true
      }
    })
    let shellInFront: boolean
    try {
      shellInFront = await runtime.isLaunchShellInFront(ptyId, agent)
    } catch (error) {
      watch.unsubscribe()
      throw error
    }
    if (shellInFront) {
      watch.unsubscribe()
      throw new Error('agent_not_in_foreground')
    }
    cleared = watch
  }
  return { beforeWrite, dispose }
}
