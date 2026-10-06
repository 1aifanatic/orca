import type { ProfileStateWriterConnectionOptions } from './profile-state-writer-connection'
import { recordProfileStateWriterRecovery } from './profile-state-writer-diagnostics'
import { ProfileStateWriterError } from './profile-state-writer-errors'
import type {
  ProfileStateWriterFailureOutcome,
  ProfileStateWriterInitialization
} from './profile-state-writer-protocol'
import { ProfileStateWriteWorkerClient } from './profile-state-writer-worker-client'

/** Only a worker that stopped answering is replaced; SQL errors and protocol bugs stay stopped. */
const RECOVERABLE_CODES = new Set(['profile-state-writer-timeout', 'profile-state-writer-exit'])
export const PROFILE_STATE_WRITER_RECOVERY_LIMIT = 3
const PROFILE_STATE_WRITER_RECOVERY_WINDOW_MS = 10 * 60_000

type RecoveryOutcome = { committed: boolean }

class RecoveryRefusal extends ProfileStateWriterError {
  constructor(
    readonly reason: string,
    code: string,
    message: string,
    outcome: ProfileStateWriterFailureOutcome,
    cause?: unknown
  ) {
    super(code, message, outcome, cause === undefined ? undefined : { cause })
  }
}

/**
 * Replace a writer that stopped answering without restarting Orca. A replacement
 * starts only after the old thread has exited, at the last acknowledged revision;
 * its initialization proves from SQLite whether the interrupted write committed.
 */
export class ProfileStateWriterSupervisor {
  private writer: ProfileStateWriteWorkerClient
  private replacement: ProfileStateWriteWorkerClient | undefined
  private readonly recoveries = new WeakMap<
    ProfileStateWriteWorkerClient,
    Promise<RecoveryOutcome>
  >()
  private recovering: Promise<void> | undefined
  private stopped: Error | undefined
  private closing = false
  private closed: Promise<void> | undefined
  private readonly attempts: number[] = []

  constructor(
    private readonly initialization: ProfileStateWriterInitialization,
    private readonly options: ProfileStateWriterConnectionOptions = {}
  ) {
    this.writer = this.spawn(initialization, options.reportInitializationFailure)
  }

  get ready(): Promise<void> {
    return this.writer.ready
  }

  get acknowledgedRevision(): number {
    if (this.stopped) {
      throw this.stopped
    }
    return this.writer.acknowledgedRevision
  }

  /** A recoverable fault is not a refusal: the next command waits for its replacement. */
  assertWritable(): void {
    if (this.stopped) {
      throw this.stopped
    }
    if (!this.recovering && !this.isRecoverable(this.writer)) {
      this.writer.assertWritable()
    }
  }

  write(invoke: (writer: ProfileStateWriteWorkerClient) => Promise<unknown>): Promise<void> {
    return this.execute(
      (writer) => invoke(writer).then(() => {}),
      () => {}
    )
  }

  read<T>(invoke: (writer: ProfileStateWriteWorkerClient) => Promise<T>): Promise<T> {
    return this.execute(invoke)
  }

  stopAdmission(): void {
    this.closing = true
    this.writer.stopAdmission()
  }

  /** Waits out an in-flight recovery, which cannot install a writer once closing. */
  close(): Promise<void> {
    this.stopAdmission()
    const closeWriters = () =>
      Promise.all([this.writer.close(), this.replacement?.close()]).then(() => {})
    // Close synchronously when idle so already-admitted commands keep their ordering.
    this.closed ??= this.recovering ? this.recovering.then(closeWriters) : closeWriters()
    return this.closed
  }

  async abort(): Promise<void> {
    this.closing = true
    await Promise.all([this.writer.abort(), this.replacement?.abort(), this.recovering])
  }

  private async execute<T>(
    invoke: (writer: ProfileStateWriteWorkerClient) => Promise<T>,
    committedResult?: () => T
  ): Promise<T> {
    let replaying = false
    for (;;) {
      // Dispatch in the caller's turn when idle; a later close must not overtake it.
      // An interrupted command replays first, ahead of callers that queued behind recovery.
      if (this.recovering && !replaying) {
        await this.recovering
      }
      replaying = false
      if (this.stopped) {
        throw this.stopped
      }
      const writer = this.writer
      if (this.isRecoverable(writer)) {
        // An idle fault: nothing was interrupted, so the replacement simply takes this command.
        await this.recover(writer).catch(() => {})
        continue
      }
      const faultBeforeDispatch = writer.faulted
      try {
        return await invoke(writer)
      } catch (error) {
        // The eager failure handler may already have settled this writer's recovery.
        const recovery =
          faultBeforeDispatch === undefined && writer.faulted?.error === error
            ? (this.recoveries.get(writer) ??
              (this.isRecoverable(writer) ? this.recover(writer) : undefined))
            : undefined
        if (!recovery) {
          throw error
        }
        const { committed } = await recovery
        if (committed && committedResult) {
          // SQLite holds this command's operation id: retrying would duplicate it.
          return committedResult()
        }
        // Disk is still at the acknowledged revision, so the same command is safe to replay.
        replaying = true
      }
    }
  }

  private isRecoverable(writer: ProfileStateWriteWorkerClient): boolean {
    const fault = writer.faulted
    return (
      fault !== undefined &&
      writer.admitted &&
      !this.closing &&
      !this.stopped &&
      fault.error instanceof ProfileStateWriterError &&
      RECOVERABLE_CODES.has(fault.error.code)
    )
  }

  private recover(failed: ProfileStateWriteWorkerClient): Promise<RecoveryOutcome> {
    let recovery = this.recoveries.get(failed)
    if (!recovery) {
      recovery = this.replace(failed)
      this.recoveries.set(failed, recovery)
      const tracked: Promise<void> = recovery.then(
        () => {},
        () => {}
      )
      this.recovering = tracked
      void tracked.finally(() => {
        if (this.recovering === tracked) {
          this.recovering = undefined
        }
      })
    }
    return recovery
  }

  private async replace(failed: ProfileStateWriteWorkerClient): Promise<RecoveryOutcome> {
    const interrupted = failed.faulted?.interrupted
    const operationId = interrupted?.command.startsWith('write-')
      ? interrupted.operationId
      : undefined
    const acknowledgedRevision = failed.lastAcknowledgedRevision
    const details = { attempt: 0, acknowledgedRevision, interruptedCommand: interrupted?.command }
    // An unresolved write keeps the caller from rolling back state that may be durable.
    let outcome: ProfileStateWriterFailureOutcome =
      operationId === undefined ? 'known-failure' : 'indeterminate'
    try {
      details.attempt = this.admitAttempt(outcome, failed.faulted?.error)
      recordProfileStateWriterRecovery('started', details)
      if (!(await failed.waitForExit())) {
        throw new RecoveryRefusal(
          'previous-writer-alive',
          'profile-state-writer-exit-unconfirmed',
          'Profile state writer did not exit, so a replacement could race it',
          outcome
        )
      }
      this.assertNotClosing(outcome)
      const replacement = this.spawn({
        ...this.initialization,
        revision: acknowledgedRevision,
        ...(operationId !== undefined && { interruptedOperation: operationId })
      })
      // Failed startup still owns a thread until close or abort confirms its exit.
      this.replacement = replacement
      try {
        await replacement.ready
      } catch (cause) {
        throw new RecoveryRefusal(
          'replacement-refused',
          'profile-state-writer-recovery-failed',
          'Profile state writer could not be safely restarted',
          outcome,
          cause
        )
      }
      const committed =
        operationId !== undefined &&
        replacement.lastAcknowledgedRevision === acknowledgedRevision + 1
      outcome = 'known-failure'
      if (this.closing) {
        await replacement.close().catch(() => {})
        // A proven commit still answers its caller; only further commands are refused.
        if (committed) {
          return { committed }
        }
        this.assertNotClosing(outcome)
      }
      this.writer = replacement
      this.replacement = undefined
      recordProfileStateWriterRecovery('succeeded', { ...details, committed })
      return { committed }
    } catch (cause) {
      const refusal =
        cause instanceof RecoveryRefusal
          ? cause
          : new RecoveryRefusal(
              'unexpected',
              'profile-state-writer-recovery-failed',
              'Profile state writer could not be safely restarted',
              outcome,
              cause
            )
      recordProfileStateWriterRecovery('refused', {
        ...details,
        reason: refusal.reason,
        error: refusal.cause ?? refusal
      })
      this.stop(refusal, refusal.reason !== 'closing')
      throw refusal
    }
  }

  private admitAttempt(outcome: ProfileStateWriterFailureOutcome, cause: unknown): number {
    const now = (this.options.clock ?? (() => performance.now()))()
    while (
      this.attempts.length > 0 &&
      now - this.attempts[0] >= PROFILE_STATE_WRITER_RECOVERY_WINDOW_MS
    ) {
      this.attempts.shift()
    }
    if (this.attempts.length >= PROFILE_STATE_WRITER_RECOVERY_LIMIT) {
      throw new RecoveryRefusal(
        'limit',
        'profile-state-writer-recovery-limit',
        'Profile state writer failed repeatedly',
        outcome,
        cause
      )
    }
    this.attempts.push(now)
    return this.attempts.length
  }

  private assertNotClosing(outcome: ProfileStateWriterFailureOutcome): void {
    if (this.closing) {
      throw new RecoveryRefusal(
        'closing',
        'profile-state-writer-closed',
        'Profile state writer is closing',
        outcome
      )
    }
  }

  private spawn(
    initialization: ProfileStateWriterInitialization,
    reportInitializationFailure?: boolean
  ): ProfileStateWriteWorkerClient {
    // The constructor may report a startup failure before the binding below exists.
    const created: { writer?: ProfileStateWriteWorkerClient } = {}
    created.writer = new ProfileStateWriteWorkerClient(initialization, {
      ...this.options,
      reportInitializationFailure,
      onFailure: (error) => this.handleFailure(created.writer, error)
    })
    return created.writer
  }

  private handleFailure(writer: ProfileStateWriteWorkerClient | undefined, error: Error): void {
    // A writer not yet installed reports through its ready promise instead.
    if (writer !== undefined && writer !== this.writer) {
      return
    }
    if (writer !== undefined && this.isRecoverable(writer)) {
      // Recover eagerly so the alert waits for the outcome and the next save is not delayed.
      void this.recover(writer).catch(() => {})
      return
    }
    this.stop(error, true)
  }

  /** Report the final failure once; a closing refusal is intentional and stays quiet. */
  private stop(error: Error, notify: boolean): void {
    if (this.stopped) {
      return
    }
    this.stopped = error
    if (!notify) {
      return
    }
    try {
      this.options.onFailure?.(error)
    } catch (notificationError) {
      console.error('[persistence] Could not report stopped saving:', notificationError)
    }
  }
}
