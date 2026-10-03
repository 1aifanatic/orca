import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { z } from 'zod'
import { currentWorkerEntryLayout, resolveWorkerThreadEntryPath } from '../worker-thread-entry-path'
import {
  editorRecoveryResponseSchema,
  type EditorRecoveryCommand
} from './editor-recovery-protocol'
import {
  editorRecoveryAckSchema,
  editorRecoveryDraftSchema,
  editorRecoveryEntrySchema,
  editorRecoveryStatusSchema,
  type EditorRecoveryChange,
  type EditorRecoveryMetadata
} from '../../shared/editor-recovery'

export function resolveEditorRecoveryWorkerPath(moduleDir = __dirname): string {
  const entry = resolveWorkerThreadEntryPath(
    currentWorkerEntryLayout(moduleDir),
    'editor-recovery-worker-entry.js'
  )
  return (
    [entry, join(dirname(entry), '..', 'editor-recovery-worker-entry.js')].find(existsSync) ?? entry
  )
}

export class EditorRecoveryWorker {
  private readonly worker: Worker
  private nextRequestId = 1
  private failed: Error | null = null
  private readonly pending = new Map<
    number,
    {
      resolve: (value: unknown) => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()

  constructor(
    databasePath: string,
    workerPath = resolveEditorRecoveryWorkerPath(),
    private readonly timeoutMs = 15_000
  ) {
    this.worker = new Worker(workerPath, { workerData: { databasePath } })
    this.worker.unref()
    this.worker.on('message', (message: unknown) => {
      const parsed = editorRecoveryResponseSchema.safeParse(message)
      if (!parsed.success) {
        this.fail(new Error('Invalid recovery writer response'))
        return
      }
      const response = parsed.data
      const request = this.pending.get(response.requestId)
      if (!request) {
        this.fail(new Error('Unexpected recovery writer acknowledgement'))
        return
      }
      this.pending.delete(response.requestId)
      clearTimeout(request.timer)
      if (response.ok) {
        request.resolve(response.result)
      } else {
        request.reject(new Error(response.error))
      }
    })
    this.worker.on('error', (error: unknown) =>
      this.fail(error instanceof Error ? error : new Error(String(error)))
    )
    this.worker.on('exit', () => this.fail(new Error('Recovery writer stopped')))
  }
  get isRunning(): boolean {
    return this.failed === null
  }

  async list() {
    return z.array(editorRecoveryEntrySchema).parse(await this.dispatch({ kind: 'list' }))
  }
  async read(id: string) {
    return editorRecoveryDraftSchema.nullable().parse(await this.dispatch({ kind: 'read', id }))
  }
  async status(ids: string[]) {
    return z.array(editorRecoveryStatusSchema).parse(await this.dispatch({ kind: 'status', ids }))
  }
  async apply(changes: EditorRecoveryChange[]) {
    const acknowledgements = z
      .array(editorRecoveryAckSchema)
      .parse(await this.dispatch({ kind: 'apply', changes }))
    if (
      acknowledgements.length !== changes.length ||
      acknowledgements.some(
        (ack, index) =>
          ack.id !== changes[index]?.id ||
          (ack.revision !== null && ack.revision !== (changes[index]?.expectedRevision ?? 0) + 1)
      )
    ) {
      this.fail(new Error('Invalid recovery commit acknowledgement'))
      throw this.failed
    }
    return acknowledgements
  }
  async importLegacy(drafts: { metadata: EditorRecoveryMetadata; content: string }[]) {
    await this.dispatch({ kind: 'import', drafts })
  }
  async restore(resources: EditorRecoveryMetadata[], checkpointIds: string[]) {
    return z
      .object({
        drafts: z.array(editorRecoveryDraftSchema.nullable()),
        resolvedIds: z.array(z.string())
      })
      .parse(await this.dispatch({ kind: 'restore', resources, checkpointIds }))
  }
  async export(id: string, revision: number, targetPath: string) {
    return z.string().parse(await this.dispatch({ kind: 'export', id, revision, targetPath }))
  }
  async close() {
    await this.dispatch({ kind: 'close' })
  }

  private dispatch(command: EditorRecoveryCommand): Promise<unknown> {
    if (this.failed) {
      return Promise.reject(this.failed)
    }
    const requestId = this.nextRequestId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.fail(new Error('Recovery writer did not acknowledge the checkpoint')),
        this.timeoutMs
      )
      this.pending.set(requestId, { resolve, reject, timer })
      try {
        this.worker.postMessage({ requestId, command })
      } catch (error) {
        this.pending.delete(requestId)
        clearTimeout(timer)
        reject(error)
      }
    })
  }

  private fail(error: Error): void {
    this.failed ??= error
    for (const request of this.pending.values()) {
      clearTimeout(request.timer)
      request.reject(this.failed)
    }
    this.pending.clear()
    void this.worker.terminate()
  }
}
