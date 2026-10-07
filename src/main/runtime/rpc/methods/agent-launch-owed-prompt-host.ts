/**
 * Where the host finishes a first prompt it still owed (`agent-launch-owed-prompt-resume`): at
 * startup, once it knows which terminals survived, and before a replay of that launch answers.
 */

import { getProfileUserDataPath } from '../../../orca-profiles/profile-storage-paths'
import {
  resumeOwedLaunchPrompt,
  resumeOwedLaunchPrompts,
  type OwedLaunchPromptResumeDeps
} from '../../../agent-launch/agent-launch-owed-prompt-resume'
import { readOwedLaunchPrompt } from '../../agent-launch-owed-prompt-record'
import type { AgentSessionRecordStore } from '../../agent-session-record-store'
import type { OrcaRuntimeService } from '../../orca-runtime'
import { hasPersistedStructuredAgentSessionStore } from '../../structured-agent-session-runtime'
import { activeAgentLaunchesFor } from './agent-launch-active-operations'
import { deliverTerminalAgentLaunchPrompt } from './agent-launch-terminal-prompt'
import type { AgentLaunchResult } from '../../../../shared/agent-launch-intent'
import type { LaunchedTerminal } from './agent-launch-replay'

function resumeDeps(
  runtime: OrcaRuntimeService,
  store: AgentSessionRecordStore
): OwedLaunchPromptResumeDeps {
  return {
    store,
    terminalForPane: (paneKey) => {
      const handle = runtime.getTerminalHandleForPaneKey(paneKey)
      return handle ? { handle, terminal: runtime.getTerminalPtyIdentity(handle) } : null
    },
    deliver: ({ callerKey, handle, agent, text, beginPromptWrite }) =>
      deliverTerminalAgentLaunchPrompt({
        runtime,
        handle,
        agent,
        // The agent has been running since before this host started: its launch readiness is gone.
        freshLaunch: false,
        text,
        beginPromptWrite,
        callerKey,
        resumed: true
      }),
    isLaunchRunning: (operationKey) => activeAgentLaunchesFor(runtime).has(operationKey),
    now: () => Date.now()
  }
}

/** How soon a prompt whose terminal was not found yet is looked for again: an SSH relay reconnects
 *  after the window's own startup step. Bounded by the owed prompt's deadline, which settles it. */
const RESWEEP_MS = 10_000
const resweepTimers = new WeakMap<OrcaRuntimeService, ReturnType<typeof setTimeout>>()

function sweepAgainSoon(runtime: OrcaRuntimeService): void {
  if (resweepTimers.has(runtime)) {
    return
  }
  const timer = setTimeout(() => {
    resweepTimers.delete(runtime)
    void resumeOwedAgentLaunchPrompts(runtime)
  }, RESWEEP_MS)
  timer.unref?.()
  resweepTimers.set(runtime, timer)
}

/** The PTY a launch's terminal surface holds as it is recorded (W1), for a resume to match. */
export function launchedTerminal(
  runtime: Partial<Pick<OrcaRuntimeService, 'getTerminalPtyIdentity'>>,
  result: AgentLaunchResult
): LaunchedTerminal | undefined {
  if (result.outcome.kind !== 'terminal') {
    return undefined
  }
  try {
    return runtime.getTerminalPtyIdentity?.(result.outcome.handle) ?? undefined
  } catch {
    // Runs while the surface is recorded, which must not throw: an unknown PTY is never resumed.
    return undefined
  }
}

/** Startup, after the terminal inventory refresh. Bookkeeping: it never throws. */
export async function resumeOwedAgentLaunchPrompts(runtime: OrcaRuntimeService): Promise<void> {
  try {
    // Only a host that has written records can owe a prompt; none must not create the database.
    const store =
      runtime.openedAgentSessionRecordStore() ??
      (hasPersistedStructuredAgentSessionStore(getProfileUserDataPath())
        ? await runtime.openAgentSessionRecordStore()
        : null)
    if (store && (await resumeOwedLaunchPrompts(resumeDeps(runtime, store)))) {
      sweepAgainSoon(runtime)
    }
  } catch (error) {
    console.warn('[agent-launch] could not resume owed launch prompts', error)
  }
}

/** A replay of a launch whose prompt is still owed answers once that prompt is settled. */
export async function settleOwedLaunchPromptBeforeReplay(
  runtime: OrcaRuntimeService,
  ref: { callerKey: string; operationId: string }
): Promise<void> {
  const store = await runtime.openAgentSessionRecordStore()
  const row = store.getOperationRow(ref.callerKey, ref.operationId)
  if (row && readOwedLaunchPrompt(row)) {
    // This replay is the operation's only run in this process: one still running would have been
    // joined instead, and the replay registered itself as running before reaching here.
    const resumed = await resumeOwedLaunchPrompt(
      { ...resumeDeps(runtime, store), isLaunchRunning: () => false },
      row
    )
    if (resumed === 'retry') {
      sweepAgainSoon(runtime)
    }
  }
}
