/**
 * The follow-ups this window waits on (`agent-launch-follow-ups`): ones its launches recorded that
 * the host has not settled yet, found at startup after a reload, or left behind by a click whose own
 * take missed. Each one's notes or threads stay unsendable while it waits. It is taken when the host
 * says its prompt settled, or once more just past an older host's deadline. A host that still
 * reports the launch pending keeps the wait subscribed until its settlement.
 *
 * One take per launch runs at a time: a second answer that finds it already gone must not release
 * the hold while the first take is still running it.
 */

import { ensureLocalRuntimeCapabilities } from '@/runtime/local-runtime-capabilities'
import type { AgentLaunchFollowUp } from '../../../shared/agent-launch-follow-up'
import { AGENT_LAUNCH_FOLLOW_UPS_RUNTIME_CAPABILITY } from '../../../shared/agent-launch-runtime-capability'
import {
  readLaunchFollowUp,
  runTakenLaunchFollowUps,
  takeLaunchFollowUps
} from './agent-launch-follow-ups'

/** How long past an older host's deadline a waiting window takes once more. */
const PAST_DEADLINE_GRACE_MS = 15_000
/** When to ask once more if the host supplied no deadline. */
const FALLBACK_WAIT_MS = 5 * 60_000
/** A click's own take that missed is asked again once this soon: the host's word came before it. */
const CLICK_RETAKE_MS = 3_000

export type RecordedLaunchFollowUpClock = {
  now: () => number
  /** Runs `run` after `ms`; returns its cancel. */
  schedule: (ms: number, run: () => void) => () => void
  /** The host's word that a launch settled its prompt; returns its unsubscribe. */
  onSettled: (listener: (operationId: string) => void) => () => void
}

const WINDOW_CLOCK: RecordedLaunchFollowUpClock = {
  now: () => Date.now(),
  schedule: (ms, run) => {
    const timer = setTimeout(run, ms)
    return () => clearTimeout(timer)
  },
  onSettled: (listener) =>
    window.api.ui.onAgentLaunchPromptSettled?.((event) => listener(event.operationId)) ?? (() => {})
}

type Waiting = { done: Promise<void>; finish: () => void }

class LaunchFollowUpWaiter {
  private readonly waiting = new Map<string, Waiting>()
  private readonly takes = new Map<string, Promise<void>>()
  /** Words heard for launches not waited on yet, kept only while startup's first take runs. */
  private heard: Set<string> | null = null
  private unsubscribe: (() => void) | null = null

  constructor(private readonly clock: RecordedLaunchFollowUpClock) {}

  /** Listens before anything is taken, so a word sent while startup asks is not lost. */
  startCollecting(): void {
    this.heard = new Set()
    this.listen()
  }

  stopCollecting(): void {
    this.heard = null
    this.stopListeningWhenIdle()
  }

  /** Holds what the follow-up acts on until it is run, or the wait gives up. */
  wait(
    operationId: string,
    followUp: AgentLaunchFollowUp,
    deadline?: number,
    retakeAfterMs?: number
  ): Promise<void> {
    const existing = this.waiting.get(operationId)
    if (existing) {
      return existing.done
    }
    let release: () => void = () => {}
    const done = new Promise<void>((resolve) => (release = resolve))
    readLaunchFollowUp(followUp)?.holdUntil?.(done)
    const waitMs = (deadline ?? this.clock.now() + FALLBACK_WAIT_MS) - this.clock.now()
    const cancelTimer = this.clock.schedule(Math.max(0, waitMs) + PAST_DEADLINE_GRACE_MS, () => {
      void this.take(operationId, true)
    })
    const cancelRetake =
      retakeAfterMs === undefined
        ? () => {}
        : this.clock.schedule(retakeAfterMs, () => void this.take(operationId, false))
    this.waiting.set(operationId, {
      done,
      finish: () => {
        cancelTimer()
        cancelRetake()
        release()
      }
    })
    this.listen()
    if (this.heard?.has(operationId)) {
      void this.take(operationId, true)
    }
    return done
  }

  private listen(): void {
    this.unsubscribe ??= this.clock.onSettled((operationId) => {
      if (this.waiting.has(operationId)) {
        void this.take(operationId, true)
      } else {
        this.heard?.add(operationId)
      }
    })
  }

  private stopListeningWhenIdle(): void {
    if (this.waiting.size === 0 && this.heard === null) {
      this.unsubscribe?.()
      this.unsubscribe = null
    }
  }

  private take(operationId: string, finishIfUnavailable: boolean): Promise<void> {
    const next = (this.takes.get(operationId) ?? Promise.resolve()).then(() =>
      this.takeNow(operationId, finishIfUnavailable)
    )
    this.takes.set(operationId, next)
    void next.finally(() => {
      if (this.takes.get(operationId) === next) {
        this.takes.delete(operationId)
      }
    })
    return next
  }

  private async takeNow(operationId: string, finishIfUnavailable: boolean): Promise<void> {
    if (!this.waiting.has(operationId)) {
      return
    }
    const take = await takeLaunchFollowUps(operationId)
    if (take && !take.pending.some((entry) => entry.operationId === operationId)) {
      await runTakenLaunchFollowUps(take.taken)
      this.finish(operationId)
    } else if (finishIfUnavailable && !take) {
      this.finish(operationId)
    }
  }

  private finish(operationId: string): void {
    this.waiting.get(operationId)?.finish()
    this.waiting.delete(operationId)
    this.stopListeningWhenIdle()
  }
}

const waiters = new WeakMap<RecordedLaunchFollowUpClock, LaunchFollowUpWaiter>()

function waiterFor(clock: RecordedLaunchFollowUpClock): LaunchFollowUpWaiter {
  let waiter = waiters.get(clock)
  if (!waiter) {
    waiter = new LaunchFollowUpWaiter(clock)
    waiters.set(clock, waiter)
  }
  return waiter
}

/**
 * Startup: holds what launches still on their way act on, before anything else, then runs the
 * follow-ups launches finished while this window was gone, and waits on the rest.
 */
export async function runRecordedLaunchFollowUps(
  clock: RecordedLaunchFollowUpClock = WINDOW_CLOCK
): Promise<void> {
  const capabilities = await ensureLocalRuntimeCapabilities()
  if (!capabilities?.includes(AGENT_LAUNCH_FOLLOW_UPS_RUNTIME_CAPABILITY)) {
    return
  }
  const waiter = waiterFor(clock)
  waiter.startCollecting()
  try {
    const first = await takeLaunchFollowUps()
    if (!first) {
      return
    }
    const waits = first.pending.map(({ operationId, followUp, deadline }) =>
      waiter.wait(operationId, followUp, deadline)
    )
    waiter.stopCollecting()
    await runTakenLaunchFollowUps(first.taken)
    await Promise.all(waits)
  } finally {
    waiter.stopCollecting()
  }
}

/**
 * A click's follow-up still on the record after its own take missed: waited on as startup's are,
 * and asked for again once soon, since the host's word that it settled came before that take.
 */
export function waitForRecordedLaunchFollowUp(
  operationId: string,
  followUp: AgentLaunchFollowUp,
  deadline?: number,
  clock: RecordedLaunchFollowUpClock = WINDOW_CLOCK
): Promise<void> {
  return waiterFor(clock).wait(operationId, followUp, deadline, CLICK_RETAKE_MS)
}
