import { foregroundAgentVerdict } from '../../shared/foreground-agent-verdict'
import { admitRemoteForegroundEvidence } from '../../shared/remote-foreground-evidence-admission'
import { isClientOnlyUnverifiableInspection } from '../../shared/terminal-process-inspection'
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
  'connectionId' | 'incarnationId' | 'connected' | 'launchAgent' | 'foregroundAgent'
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
        () => this.read(ptyId, afterTitle) ?? { controller, process: null, available: false }
      )
    }
    const unavailable: PtyForegroundProcessRead = { controller, process: null, available: false }
    let processRead: Promise<string | null>
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
      .then((process) =>
        this.deps.getPty(ptyId)?.incarnationId === incarnationId
          ? { controller, process, available: true }
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
    if (!result || result.controller !== this.deps.getController() || !result.available) {
      return false
    }
    if (this.deps.getPty(ptyId) !== pty || !pty.connected || pty.incarnationId !== incarnationId) {
      return false
    }
    if (foregroundAgentVerdict(result.process) === 'unverifiable') {
      return false
    }
    const agent = recognizeAgentProcess(result.process)?.agent ?? null
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
  ): Promise<string | null> {
    const pty = this.deps.getPty(ptyId)
    if (!pty?.connectionId) {
      const cached = await controller.getForegroundProcess(ptyId)
      if (recognizeAgentProcess(cached)) {
        return cached
      }
      // Cached display names cannot certify that the agent returned to its shell.
      return controller.confirmForegroundProcess ? controller.confirmForegroundProcess(ptyId) : null
    }
    const incarnationId = pty.incarnationId
    const started = performance.now()
    const inspection = await controller.inspectProcess?.(
      ptyId,
      incarnationId ? { expectedIncarnationId: incarnationId } : {}
    )
    if (!inspection || isClientOnlyUnverifiableInspection(inspection)) {
      return null
    }
    const evidence = admitRemoteForegroundEvidence(inspection.foregroundProcessEvidence, {
      expectedPtyId: parseAppSshPtyId(ptyId)?.relayPtyId ?? ptyId,
      expectedIncarnationId: incarnationId,
      requestStartedAtMonotonic: started,
      receivedAtMonotonic: performance.now(),
      lastAuthorityGeneration: null,
      lastObservationEpoch: -1
    })
    return evidence?.verdict === 'live' ? evidence.processName : null
  }

  private deleteRead(ptyId: string, entry: PtyForegroundProcessReadEntry): void {
    if (this.reads.get(ptyId) === entry) {
      this.reads.delete(ptyId)
    }
  }
}
