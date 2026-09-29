import {
  judgeForegroundAgent,
  observeHostInspection,
  type ForegroundAgentJudgement
} from '../../shared/foreground-agent-verdict'
import { admitRemoteForegroundEvidence } from '../../shared/remote-foreground-evidence-admission'
import { parseAppSshPtyId } from '../../shared/ssh-pty-id'
import { recognizeAgentProcess } from '../../shared/agent-process-recognition'
import type { RuntimePtyController } from './runtime-pty-controller-contract'
import type {
  PtyForegroundAgentRefresh,
  PtyForegroundProcessRead,
  PtyForegroundProcessReadEntry
} from './runtime-terminal-contracts'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'

type ForegroundPty = Pick<
  RuntimePtyWorktreeRecord,
  | 'connectionId'
  | 'incarnationId'
  | 'connected'
  | 'launchAgent'
  | 'foregroundAgent'
  | 'foregroundAgentIncarnationId'
>

type Dependencies = {
  getController(): RuntimePtyController | null
  getPty(ptyId: string): ForegroundPty | null
  touchSnapshot(ptyId: string): void
  finishDelayedSnapshot(ptyId: string, changed: boolean): void
}

export class RuntimePtyForegroundAgent {
  private readonly refreshes = new Map<string, PtyForegroundAgentRefresh>()
  private readonly reads = new Map<string, PtyForegroundProcessReadEntry>()
  private readonly delayedTitles = new Map<string, number>()

  constructor(private readonly deps: Dependencies) {}

  read(ptyId: string, afterTitle = 0): Promise<PtyForegroundProcessRead> | null {
    const controller = this.deps.getController()
    if (!controller) {
      return null
    }
    const pending = this.reads.get(ptyId)
    if (pending?.controller === controller && pending.startedAfterTitleObservation >= afterTitle) {
      return pending.promise
    }
    if (pending?.controller === controller) {
      return pending.promise.then(
        () =>
          this.read(ptyId, afterTitle) ?? {
            controller,
            judgement: judgeForegroundAgent({ kind: 'unavailable' })
          }
      )
    }
    const unavailable: PtyForegroundProcessRead = {
      controller,
      judgement: judgeForegroundAgent({ kind: 'unavailable' })
    }
    let processRead: Promise<ForegroundAgentJudgement>
    try {
      processRead = this.readProcess(controller, ptyId)
    } catch {
      const entry: PtyForegroundProcessReadEntry = {
        controller,
        startedAfterTitleObservation: afterTitle,
        promise: Promise.resolve(unavailable)
      }
      entry.promise = entry.promise.finally(() => this.deleteRead(ptyId, entry))
      this.reads.set(ptyId, entry)
      return entry.promise
    }
    let entry: PtyForegroundProcessReadEntry
    const incarnationId = this.deps.getPty(ptyId)?.incarnationId
    const promise = processRead
      .then((judgement) =>
        this.deps.getPty(ptyId)?.incarnationId === incarnationId
          ? { controller, judgement }
          : unavailable
      )
      .catch(() => unavailable)
      .finally(() => this.deleteRead(ptyId, entry))
    entry = { controller, startedAfterTitleObservation: afterTitle, promise }
    this.reads.set(ptyId, entry)
    return entry.promise
  }

  refresh(ptyId: string, afterTitle = 0): Promise<boolean> {
    const pending = this.refreshes.get(ptyId)
    if (pending) {
      pending.requestedAfterTitleObservation = Math.max(
        pending.requestedAfterTitleObservation,
        afterTitle
      )
      return pending.promise
    }
    const entry: PtyForegroundAgentRefresh = {
      promise: Promise.resolve(false),
      startedAfterTitleObservation: afterTitle,
      requestedAfterTitleObservation: afterTitle
    }
    entry.promise = (async () => {
      while (true) {
        entry.startedAfterTitleObservation = entry.requestedAfterTitleObservation
        const changed = await this.load(ptyId, entry.startedAfterTitleObservation)
        if (changed || entry.requestedAfterTitleObservation <= entry.startedAfterTitleObservation) {
          return changed
        }
      }
    })().finally(() => {
      if (this.refreshes.get(ptyId) === entry) {
        this.refreshes.delete(ptyId)
      }
    })
    this.refreshes.set(ptyId, entry)
    return entry.promise
  }

  /** Exit confirmation and `pty.foregroundAgent` come from this one current-incarnation read. */
  confirm(ptyId: string, afterTitle = 0): Promise<PtyForegroundProcessRead> | null {
    const pty = this.deps.getPty(ptyId)
    const read = this.read(ptyId, afterTitle)
    if (!pty || !read) {
      return read
    }
    const incarnationId = pty.incarnationId
    return read.then((result) => {
      if (this.isCurrent(ptyId, pty, incarnationId, result)) {
        this.apply(ptyId, pty, result.judgement)
      }
      return result
    })
  }

  /** The shell's own 133;D retired an agent on a host that cannot prove a shell by read. */
  markExited(ptyId: string): void {
    const pty = this.deps.getPty(ptyId)
    if (pty) {
      this.apply(ptyId, pty, { verdict: 'exited', processName: null, canCertifyExit: false })
    }
  }

  getPending(ptyId: string, afterTitle: number): Promise<boolean> | undefined {
    return this.refreshes.has(ptyId) ? this.refresh(ptyId, afterTitle) : undefined
  }

  getReads(): ReadonlyMap<string, PtyForegroundProcessReadEntry> {
    return this.reads
  }

  delaySnapshot(ptyId: string, titleAt: number, refresh: Promise<boolean>): void {
    this.delayedTitles.set(ptyId, titleAt)
    void refresh.then((changed) => {
      if (this.delayedTitles.get(ptyId) !== titleAt) {
        return
      }
      this.delayedTitles.delete(ptyId)
      this.deps.finishDelayedSnapshot(ptyId, changed)
    })
  }

  hasDelayedSnapshot(ptyId: string): boolean {
    return this.delayedTitles.has(ptyId)
  }

  clearDelayedSnapshot(ptyId: string): void {
    this.delayedTitles.delete(ptyId)
  }

  private async load(ptyId: string, afterTitle: number): Promise<boolean> {
    const controller = this.deps.getController()
    const pty = this.deps.getPty(ptyId)
    if (!controller || !pty?.connected || pty.launchAgent) {
      return false
    }
    const incarnationId = pty.incarnationId
    const result = await this.read(ptyId, afterTitle)
    return result && this.isCurrent(ptyId, pty, incarnationId, result)
      ? this.apply(ptyId, pty, result.judgement)
      : false
  }

  private isCurrent(
    ptyId: string,
    pty: ForegroundPty,
    incarnationId: string | null | undefined,
    result: PtyForegroundProcessRead
  ): boolean {
    return (
      result.controller === this.deps.getController() &&
      this.deps.getPty(ptyId) === pty &&
      pty.connected &&
      pty.incarnationId === incarnationId
    )
  }

  private apply(ptyId: string, pty: ForegroundPty, judgement: ForegroundAgentJudgement): boolean {
    if (judgement.verdict === 'unverifiable') {
      return false
    }
    const agent =
      judgement.verdict === 'live'
        ? (recognizeAgentProcess(judgement.processName)?.agent ?? null)
        : null
    if (agent) {
      pty.foregroundAgentIncarnationId = pty.incarnationId
    }
    if (pty.foregroundAgent === agent) {
      return false
    }
    pty.foregroundAgent = agent
    this.deps.touchSnapshot(ptyId)
    return true
  }

  private async readProcess(
    controller: RuntimePtyController,
    ptyId: string
  ): Promise<ForegroundAgentJudgement> {
    const pty = this.deps.getPty(ptyId)
    if (!pty?.connectionId) {
      const cached = await controller.getForegroundProcess(ptyId)
      if (recognizeAgentProcess(cached)) {
        return judgeForegroundAgent({ kind: 'process-name', processName: cached })
      }
      // Cached display names cannot certify that the agent returned to its shell.
      return judgeForegroundAgent(
        controller.confirmForegroundProcess
          ? { kind: 'process-name', processName: await controller.confirmForegroundProcess(ptyId) }
          : { kind: 'unavailable' }
      )
    }
    const incarnationId = pty.incarnationId
    const started = performance.now()
    const inspection = await controller.inspectProcess?.(
      ptyId,
      incarnationId ? { expectedIncarnationId: incarnationId } : {}
    )
    return judgeForegroundAgent(
      observeHostInspection(inspection, (evidence) =>
        admitRemoteForegroundEvidence(evidence, {
          expectedPtyId: parseAppSshPtyId(ptyId)?.relayPtyId ?? ptyId,
          expectedIncarnationId: incarnationId,
          requestStartedAtMonotonic: started,
          receivedAtMonotonic: performance.now(),
          lastAuthorityGeneration: null,
          lastObservationEpoch: -1
        })
      )
    )
  }

  private deleteRead(ptyId: string, entry: PtyForegroundProcessReadEntry): void {
    if (this.reads.get(ptyId) === entry) {
      this.reads.delete(ptyId)
    }
  }
}
