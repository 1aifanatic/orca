import { randomUUID } from 'node:crypto'
import { executeCodexMaintenanceProcess } from './codex-maintenance-process'
import { spawnProcess, type ProcessSpec } from '../../shared/child-process/run-process'
import type { CodexMaintenanceJob, CodexMaintenanceState } from '../../shared/codex-cli-maintenance'
import { invalidateCodexCliInstallation } from './codex-cli-installation'
import {
  resolveCodexMaintenanceCommand,
  type CodexMaintenanceContext,
  type ResolvedCodexMaintenanceCommand
} from './codex-maintenance-command'

type ResolvedCommand = ResolvedCodexMaintenanceCommand
type JobEntry = { job: CodexMaintenanceJob; finishedAt: number | null }

export class CodexMaintenanceRunner {
  private readonly jobs = new Map<string, JobEntry>()
  private active: Promise<CodexMaintenanceState> | null = null
  private revision = 0
  private unsettledProcess: (() => boolean) | null = null

  constructor(
    private readonly deps = {
      resolve: (context: CodexMaintenanceContext) => resolveCodexMaintenanceCommand(context),
      spawn: (spec: ProcessSpec) => spawnProcess(spec),
      invalidate: () => invalidateCodexCliInstallation()
    }
  ) {}

  async status(
    jobId?: string,
    context: CodexMaintenanceContext = {}
  ): Promise<CodexMaintenanceState> {
    this.prune()
    const revision = this.revision
    let current = await this.deps.resolve(context)
    if (revision !== this.revision) {
      current = await this.deps.resolve(context)
    }
    const job = jobId
      ? (this.jobs.get(jobId)?.job ?? null)
      : ([...this.jobs.values()].at(-1)?.job ?? null)
    return {
      installation: current.installation,
      action: current.action,
      canRun: Boolean(current.spec) && !this.unsettledProcess?.(),
      job
    }
  }

  start(context: CodexMaintenanceContext = {}): Promise<CodexMaintenanceState> {
    if (this.active) {
      return this.active
    }
    if (this.unsettledProcess?.()) {
      return Promise.reject(new Error('The previous Codex updater is still live.'))
    }
    this.unsettledProcess = null
    // Acquire before resolving the binary; simultaneous surfaces share the same job.
    this.revision += 1
    this.active = this.begin(context).catch((error: unknown) => {
      this.active = null
      throw error
    })
    return this.active
  }

  private async begin(context: CodexMaintenanceContext): Promise<CodexMaintenanceState> {
    const resolved = await this.deps.resolve(context)
    if (!resolved.action || !resolved.spec) {
      throw new Error('Codex does not need installation or an update.')
    }
    const job: CodexMaintenanceJob = {
      id: randomUUID(),
      phase: 'queued',
      action: resolved.action,
      output: `$ ${resolved.action.command}\n`,
      exitCode: null,
      error: null
    }
    this.jobs.set(job.id, { job, finishedAt: null })
    void this.execute(job, resolved, context)
    return {
      installation: resolved.installation,
      action: resolved.action,
      canRun: true,
      job: { ...job }
    }
  }

  private async execute(
    job: CodexMaintenanceJob,
    resolved: ResolvedCommand,
    context: CodexMaintenanceContext
  ): Promise<void> {
    const append = (chunk: Buffer | string): void => {
      const bytes = Buffer.from(job.output + chunk.toString())
      job.output = bytes.subarray(-128 * 1024).toString('utf8')
    }
    try {
      if (!resolved.spec) {
        throw new Error('Codex maintenance command is unavailable.')
      }
      job.phase = 'running'
      const result = await executeCodexMaintenanceProcess(resolved.spec, append, {
        spawn: this.deps.spawn
      })
      job.exitCode = result.code
      job.error = result.error
      job.termination = result.termination
      if (result.termination === 'unverifiable') {
        this.unsettledProcess = result.isLive
      }
    } catch (error) {
      job.error = error instanceof Error ? error.message : String(error)
    } finally {
      this.revision += 1
      this.deps.invalidate()
      try {
        await (resolved.recheck?.() ?? this.deps.resolve(context))
      } catch (error) {
        append(`\n${error instanceof Error ? error.message : String(error)}\n`)
      }
      job.phase = 'completed'
      const entry = this.jobs.get(job.id)
      if (entry) {
        entry.finishedAt = Date.now()
      }
      this.active = null
      this.prune()
    }
  }

  private prune(): void {
    for (const [id, entry] of this.jobs) {
      if (
        entry.finishedAt !== null &&
        (Date.now() - entry.finishedAt > 30 * 60_000 || this.jobs.size > 16)
      ) {
        this.jobs.delete(id)
      }
    }
  }
}

export const codexMaintenanceRunner = new CodexMaintenanceRunner()
