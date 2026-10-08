import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalRenderItem
} from '../../../shared/agent-session-journal-types'
import type { JournalLoad } from './journal-open'
import type { JournalReducerState } from './journal-reducer'
import type { JournalRow } from './journal-row-schema'
import type { AgentSessionJournal } from './journal-store'
import { lostLiveWorkJournalBody, staleSubagentRosterRevisions } from './journal-subagent-liveness'

/** Readable reopen facts survive a failed cleanup write; a new revision supersedes them. */
export class JournalReopenedLiveWork {
  private readonly reopened = new Map<string, AgentJournalRenderItem>()
  private boundary = { epoch: '', sequence: 0 }
  private pending: Promise<void> | null = null

  constructor(
    private readonly deps: {
      sessionId: string
      state: () => JournalReducerState
      journal: () => AgentSessionJournal
    }
  ) {}

  adopt(loaded: JournalLoad): void {
    this.reopened.clear()
    this.boundary = { epoch: loaded.state.epoch, sequence: loaded.state.lastSequence }
    for (const [itemId, item] of loaded.state.items) {
      if (!lostLiveWorkJournalBody(item.body)) {
        continue
      }
      this.reopened.set(itemId, item)
      loaded.state.items.set(itemId, { ...item, body: this.readBody(item.body) })
    }
  }

  settle(): Promise<void> {
    if (!this.pending) {
      this.pending = Promise.resolve()
        .then(() => this.persist())
        .finally(() => {
          this.pending = null
        })
    }
    return this.pending
  }

  hasUnpersistedItem(itemId: string): boolean {
    const original = this.reopened.get(itemId)
    return original !== undefined && this.matchesReopenedItem(itemId, original)
  }

  afterCommit(): void {
    for (const [itemId, original] of this.reopened) {
      if (!this.matchesReopenedItem(itemId, original)) {
        this.reopened.delete(itemId)
      }
    }
    if (this.reopened.size > 0) {
      void (this.pending ?? Promise.resolve()).then(() => this.settle())
    }
  }

  readRow(row: JournalRow): JournalRow {
    if (row.epoch !== this.boundary.epoch || row.seq > this.boundary.sequence) {
      return row
    }
    if (row.kind === 'item') {
      return { ...row, body: this.readBody(row.body) }
    }
    if (row.kind === 'lifecycle-batch') {
      return {
        ...row,
        mutations: row.mutations.map((mutation) =>
          mutation.kind === 'item' ? { ...mutation, body: this.readBody(mutation.body) } : mutation
        )
      }
    }
    return row
  }

  private readBody(body: AgentJournalRenderItem['body']): AgentJournalRenderItem['body'] {
    return lostLiveWorkJournalBody(body) ?? body
  }

  private matchesReopenedItem(itemId: string, original: AgentJournalRenderItem): boolean {
    const state = this.deps.state()
    return (
      state.epoch === this.boundary.epoch && state.items.get(itemId)?.revision === original.revision
    )
  }

  private async persist(): Promise<void> {
    for (const [itemId, original] of this.reopened) {
      const revision = staleSubagentRosterRevisions([original])[0]
      if (!revision) {
        this.reopened.delete(itemId)
        continue
      }
      try {
        await this.deps.journal().appendResolvedItem(
          () => {
            if (!this.matchesReopenedItem(itemId, original)) {
              this.reopened.delete(itemId)
              return null
            }
            return revision
          },
          { fence: this.deps.state().highestFence, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
        )
        this.reopened.delete(itemId)
      } catch (error) {
        console.warn('[journal-open] stale live-work cleanup skipped:', {
          sessionId: this.deps.sessionId,
          itemId,
          error: error instanceof Error ? error.message : String(error)
        })
      }
    }
  }
}
