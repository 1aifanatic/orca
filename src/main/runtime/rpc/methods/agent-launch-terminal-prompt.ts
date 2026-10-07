/**
 * Host-side delivery of a launch's initial text to the terminal agent the launch just started.
 *
 * The twin of `agent-launch-structured-prompt`, and it exists for the same reason: `agent.launch`
 * created a terminal and reported the text as undelivered, which was only workable while the
 * surface that could paste — the desktop renderer's own pane — was also the one issuing the launch.
 * Mobile, the CLI and orchestration got an agent and no prompt. The host owns the PTY, so it can
 * write into one whether or not any window is open on it.
 *
 * This is the half the launch command cannot serve. An argv agent's prompt rides that command when
 * its typed line can carry it (`startup-line-prompt-carry`), and then no readiness race exists. What
 * reaches here is a `stdin-after-start` agent, whose CLI accepts no such argument; a prompt too long
 * or multi-line for the typed line; and a reused terminal, whose process was already running before
 * this launch existed. Readiness is `waitForLaunchedAgentComposer`, the one the worker start uses.
 *
 * Nothing here writes to a PTY itself. `sendTerminalAgentPrompt` is the runtime's one agent-prompt
 * writer: it frames the text as a bracketed paste so multi-line and special-character content is
 * not read as keystrokes, serializes concurrent submissions per PTY, pins the lifecycle generation
 * so a respawn cannot inherit the previous incarnation's text, and applies the per-agent submit
 * timing. It routes to local, WSL and SSH transports alike. Orchestration's worker dispatch
 * delivers a preamble through exactly this pair of calls.
 */

import { randomUUID } from 'node:crypto'
import type { TuiAgent } from '../../../../shared/tui-agent'
import type { RuntimeTerminalWait } from '../../../../shared/runtime-terminal-contracts'
import { isAgentPromptStalledError } from '../../agent-prompt-submission-verification'
import {
  waitForLaunchedAgentComposer,
  type LaunchedAgentReadinessRuntime
} from '../../launched-agent-composer-readiness'
import type { OrcaRuntimeService } from '../../orca-runtime'
import type { OwedLaunchPromptWriteStart } from '../../agent-launch-owed-prompt-record'
import {
  isDesktopLaunchCaller,
  launchPromptGuardOnUnprovableHost
} from './agent-launch-desktop-caller'
import {
  createLaunchedAgentWriteGuard,
  type LaunchedAgentWriteGuardRuntime
} from '../../launched-agent-write-guard'

/** The same budget orchestration gives a worker to reach its composer before dispatching to it. */
const AGENT_READY_TIMEOUT_MS = 60_000
/** How often a launch re-checks a blocking prompt the user may still dismiss. */
const BLOCKED_RECHECK_MS = 1_000

type TerminalPromptRuntime = LaunchedAgentReadinessRuntime &
  LaunchedAgentWriteGuardRuntime &
  Pick<OrcaRuntimeService, 'sendTerminalAgentPrompt'>

type ReadinessClock = { now: () => number; sleep: (ms: number) => Promise<void> }

const REAL_CLOCK: ReadinessClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * The launched agent's readiness, waiting out a blocking prompt until the budget ends.
 *
 * A trust or update dialog is the user's to answer, and they often do within seconds; giving up on
 * the first sight of it dropped a prompt the pane was about to accept. A dialog still up when the
 * budget ends is reported as it is, and nothing is written into it.
 */
async function waitThroughBlockingPrompts(
  runtime: TerminalPromptRuntime,
  handle: string,
  agent: TuiAgent,
  freshLaunch: boolean,
  clock: ReadinessClock,
  /** Main's desktop paste rule: past each agent's budget, write once the agent holds the pane. */
  desktopBudget: boolean
): Promise<RuntimeTerminalWait | 'budget-spent' | undefined> {
  const deadline = clock.now() + AGENT_READY_TIMEOUT_MS
  for (;;) {
    // At least 1 ms: the terminal wait reads 0 as "use the 5-minute default", and a late sleep can
    // land past the deadline.
    const timeoutMs = Math.max(1, deadline - clock.now())
    const wait = freshLaunch
      ? await waitForLaunchedAgentComposer(runtime, handle, agent, timeoutMs, {
          writeWhenBudgetSpent: desktopBudget
        })
      : // A reused pane was not freshly launched: its composer marker may be long gone.
        await runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs })
    if (
      wait === 'budget-spent' ||
      !wait?.blockedReason ||
      wait.satisfied ||
      deadline - clock.now() <= BLOCKED_RECHECK_MS
    ) {
      return wait
    }
    await clock.sleep(BLOCKED_RECHECK_MS)
  }
}

/**
 * The guard before every write, and W2 once, after the guard's first pass. For a live launch a W2
 * that cannot be recorded still lets the write through: bookkeeping never gates the prompt. A
 * resume writes only on a recorded W2: without it, a resume whose settle also failed would paste
 * again at every start until the row expired.
 */
function beforeFirstByte(
  guard: (ptyId: string) => Promise<void>,
  beginPromptWrite: (() => Promise<OwedLaunchPromptWriteStart>) | undefined,
  writeOnlyWhenRecorded: boolean
): (ptyId: string) => Promise<void> {
  let began = !beginPromptWrite
  return async (ptyId) => {
    await guard(ptyId)
    if (began || !beginPromptWrite) {
      return
    }
    began = true
    const start = await beginPromptWrite().catch((error: unknown) => {
      console.warn('[agent-launch] could not record that its prompt write began', error)
      return 'absent' as const
    })
    if (start === 'taken' || start === 'expired' || (writeOnlyWhenRecorded && start !== 'began')) {
      throw new Error('agent_launch_prompt_write_taken')
    }
  }
}

/**
 * Whether the text reached the pane.
 *
 * `false` is the answer for every failure, on the same rule the structured twin follows: a launch
 * whose agent is already running must not fail because its text did not land — the caller can
 * resend under `not-delivered`, but it cannot un-create a workspace.
 *
 * A stalled submission is deliberately `true`. The stall is raised by the verifier that runs AFTER
 * the write, so it proves only that a turn start went unobserved, never that the paste is missing.
 * Reporting it as undelivered would invite a resend that pastes the whole prompt a second time into
 * an agent already working on it — the failure `coordinator-task-dispatch` documents at its own
 * send. Here the usual preference flips: under-claiming normally costs one wasted resend, but a
 * resend into a live TUI costs a duplicate turn.
 */
export async function deliverTerminalAgentLaunchPrompt(args: {
  runtime: TerminalPromptRuntime
  handle: string
  agent: TuiAgent
  /** False for a reused terminal, whose agent was already running before this launch. */
  freshLaunch: boolean
  text: string
  clock?: ReadinessClock
  /** W2 of `agent-launch-owed-prompt-record`, once the guard has passed and before the first byte. */
  beginPromptWrite?: () => Promise<OwedLaunchPromptWriteStart>
  /** Whose launch this is, which picks the guard's answer on a host that cannot find the agent. */
  callerKey?: string
  /** Finishing an owed prompt after a restart, which main never did: the guard refuses on a host
   *  that cannot find the agent, whoever launched, and nothing is written without a recorded W2. */
  resumed?: boolean
  /** The text was written once the agent held the pane, its composer never seen ready. */
  onComposerUnobserved?: () => void
}): Promise<boolean> {
  if (args.text.trim().length === 0) {
    return false
  }
  // Before the paste and again before Enter, for a reused pane too: a ready signal can come from a
  // shell whose agent exited, so only a read that finds the agent in front lets the text through.
  const guard = createLaunchedAgentWriteGuard(args.runtime, args.agent, {
    unprovableHost: args.resumed ? 'refuse' : launchPromptGuardOnUnprovableHost(args.callerKey)
  })
  try {
    const wait = await waitThroughBlockingPrompts(
      args.runtime,
      args.handle,
      args.agent,
      args.freshLaunch,
      args.clock ?? REAL_CLOCK,
      isDesktopLaunchCaller(args.callerKey)
    )
    // An unsatisfied wait is a composer that never opened — a dialog left up, a dead process, an
    // agent that showed no readiness. Pasting anyway would answer whatever is on screen with it.
    const composerSeen = wait !== 'budget-spent'
    if (wait && wait !== 'budget-spent' && !wait.satisfied) {
      console.warn(
        `[agent-launch] the terminal agent did not become ready (${wait.status}); its launch prompt was not delivered`
      )
      return false
    }
    const sent = await args.runtime.sendTerminalAgentPrompt(args.handle, args.text, {
      inputKind: 'launch',
      // A fresh launch's composer was just seen ready; a reused pane's state is only inferred.
      // Past its budget too: main's blind paste submitted on its normal Enter timing.
      composerReady: args.freshLaunch,
      beforeWrite: beforeFirstByte(guard.beforeWrite, args.beginPromptWrite, args.resumed === true),
      // Paired: together these take the queued path, which settles an unobserved turn start into
      // an `input_accepted` receipt rather than raising it. Without the id the write is verified
      // strictly and a slow first turn throws.
      acceptQueued: true,
      requestId: randomUUID(),
      // The launch reply should not wait out a turn that has already been handed over; what the
      // agent does with the text is the pane's to show, and no receipt arm claims it.
      observationTimeoutMs: 0
    })
    if (sent.accepted && !composerSeen) {
      args.onComposerUnobserved?.()
    }
    return sent.accepted
  } catch (error) {
    if (isAgentPromptStalledError(error)) {
      return true
    }
    console.warn(
      '[agent-launch] the terminal agent started, its launch prompt was not delivered',
      error
    )
    return false
  } finally {
    guard.dispose()
  }
}
