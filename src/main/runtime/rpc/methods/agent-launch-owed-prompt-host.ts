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

function resumeDeps(
  runtime: OrcaRuntimeService,
  store: AgentSessionRecordStore
): OwedLaunchPromptResumeDeps {
  return {
    store,
    terminalHandleForPane: (paneKey) => runtime.getTerminalHandleForPaneKey(paneKey),
    deliver: ({ callerKey, handle, agent, text, beginPromptWrite }) =>
      deliverTerminalAgentLaunchPrompt({
        runtime,
        handle,
        agent,
        // The agent has been running since before this host started: its launch readiness is gone.
        freshLaunch: false,
        text,
        beginPromptWrite,
        callerKey
      }),
    isLaunchRunning: (operationKey) => activeAgentLaunchesFor(runtime).has(operationKey),
    now: () => Date.now()
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
    if (store) {
      await resumeOwedLaunchPrompts(resumeDeps(runtime, store))
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
    await resumeOwedLaunchPrompt(
      { ...resumeDeps(runtime, store), isLaunchRunning: () => false },
      row
    )
  }
}
