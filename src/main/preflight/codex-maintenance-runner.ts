import { randomUUID } from 'node:crypto'
import { spawnProcess, type ProcessSpec } from '../../shared/child-process/run-process'
import type { CodexMaintenanceJob, CodexMaintenanceState } from '../../shared/codex-cli-maintenance'
import { invalidateCodexCliInstallation } from './codex-cli-installation'
import { resolveCodexMaintenanceCommand } from './codex-maintenance-command'

type ResolvedCommand = Awaited<ReturnType<typeof resolveCodexMaintenanceCommand>>
type JobEntry = { job: CodexMaintenanceJob; finishedAt: number | null }

export class CodexMaintenanceRunner {
  private readonly jobs = new Map<string, JobEntry>()
  private active: Promise<CodexMaintenanceState> | null = null
  private installation: ResolvedCommand | null = null
  private revision = 0

  constructor(
    private readonly deps = {
      resolve: () => resolveCodexMaintenanceCommand(),
      spawn: (spec: ProcessSpec) => spawnProcess(spec),
      invalidate: () => invalidateCodexCliInstallation()
    }
  ) {}

  async status(jobId?: string): Promise<CodexMaintenanceState> {
    this.prune()
    const revision = this.revision
    const resolved =
      (jobId || this.active) && this.installation ? this.installation : await this.deps.resolve()
    if (revision === this.revision) {
      this.installation = resolved
    }
    const current = this.installation ?? resolved
    const job = jobId
      ? (this.jobs.get(jobId)?.job ?? null)
      : ([...this.jobs.values()].at(-1)?.job ?? null)
    return { installation: current.installation, action: current.action, canRun: true, job }
  }

  start(): Promise<CodexMaintenanceState> {
    if (this.active) {
      return this.active
    }
    // Acquire before resolving the binary; simultaneous surfaces share the same job.
    this.revision += 1
    this.active = this.begin().catch((error: unknown) => {
      this.active = null
      throw error
    })
    return this.active
  }

  private async begin(): Promise<CodexMaintenanceState> {
    const resolved = await this.deps.resolve()
    this.installation = resolved
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
    void this.execute(job, resolved)
    return {
      installation: resolved.installation,
      action: resolved.action,
      canRun: true,
      job: { ...job }
    }
  }

  private async execute(job: CodexMaintenanceJob, resolved: ResolvedCommand): Promise<void> {
    const append = (chunk: Buffer | string): void => {
      const bytes = Buffer.from(job.output + chunk.toString())
      job.output = bytes.subarray(-128 * 1024).toString('utf8')
    }
    try {
      if (!resolved.spec) {
        throw new Error('Codex maintenance command is unavailable.')
      }
      job.phase = 'running'
      const child = this.deps.spawn(resolved.spec)
      let forceTimer: ReturnType<typeof setTimeout> | undefined
      const timer = setTimeout(() => {
        job.error = 'Codex maintenance timed out.'
        child.kill()
        forceTimer = setTimeout(() => child.kill('SIGKILL'), 2_000)
        forceTimer.unref()
      }, 10 * 60_000)
      timer.unref()
      await new Promise<void>((resolve) => {
        child.stdout.on('data', append)
        child.stderr.on('data', append)
        for (const stream of [child.stdin, child.stdout, child.stderr]) {
          stream.on('error', (error: Error) => append(`\n${error.message}\n`))
        }
        child.once('error', (error) => {
          job.error = error.message
          if (!child.pid) {
            clearTimeout(timer)
            clearTimeout(forceTimer)
            resolve()
          }
        })
        child.once('close', (code, signal) => {
          clearTimeout(timer)
          clearTimeout(forceTimer)
          job.exitCode = code
          if (signal && !job.error) {
            job.error = `Command exited after signal ${signal}`
          }
          resolve()
        })
        child.stdin.end()
      })
    } catch (error) {
      job.error = error instanceof Error ? error.message : String(error)
    } finally {
      this.revision += 1
      this.deps.invalidate()
      try {
        this.installation = await this.deps.resolve()
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
