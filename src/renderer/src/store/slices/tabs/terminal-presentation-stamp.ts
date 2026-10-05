import type { AppState } from '../../types'
import { resolveTerminalTabViewMode } from '../../../../../shared/terminal-tab-view-mode'
import { terminalLayoutNodeLeafIds } from '../../../../../shared/native-chat-leaf-ownership'

/**
 * Causal ordering for a terminal tab's presentation (view, chat owner, launch hint, pane
 * bindings). Not a view fact: a delayed agent-exit retirement compares it so a newer user switch,
 * rebinding or relaunch always supersedes the older exit, even when the values came back.
 */
export type TerminalPresentationStamp = {
  revision: number
  /** Wall clock of the last change; same-machine exit observations compare against it. */
  changedAtMs: number
  /** Advanced only when the launch hint changes: keys remembered exit evidence to one launch. */
  launchRevision: number
}

type PresentationState = Pick<
  AppState,
  'tabsByWorktree' | 'unifiedTabsByWorktree' | 'terminalLayoutsByTabId'
>

// Why random: tokens published before a renderer reload must never match the new store's revisions.
const PRESENTATION_EPOCH = Math.random().toString(36).slice(2, 10)
const EMPTY_STAMP: TerminalPresentationStamp = { revision: 0, changedAtMs: 0, launchRevision: 0 }
const stampsByTabId = new Map<string, TerminalPresentationStamp>()
const signaturesByTabId = new Map<string, { presentation: string; launch: string }>()

function bump(tabId: string, launchChanged: boolean, nowMs = Date.now()): void {
  const current = stampsByTabId.get(tabId) ?? EMPTY_STAMP
  stampsByTabId.set(tabId, {
    revision: current.revision + 1,
    changedAtMs: Math.max(nowMs, current.changedAtMs),
    launchRevision: current.launchRevision + (launchChanged ? 1 : 0)
  })
}

function rowSignature(
  state: PresentationState,
  worktreeId: string,
  row: AppState['tabsByWorktree'][string][number]
): { presentation: string; launch: string } {
  const unified = (state.unifiedTabsByWorktree?.[worktreeId] ?? []).find(
    (tab) => tab.contentType === 'terminal' && (tab.entityId === row.id || tab.id === row.id)
  )
  const layout = state.terminalLayoutsByTabId?.[row.id]
  const bindings = layout?.ptyIdsByLeafId ?? {}
  const binding = terminalLayoutNodeLeafIds(layout?.root)
    .map((leafId) => `${leafId}=${bindings[leafId] ?? ''}`)
    .join(',')
  return {
    presentation: [
      resolveTerminalTabViewMode(unified, row) ?? '',
      layout?.chatLeafId ?? '',
      row.launchAgent ?? '',
      row.ptyId ?? '',
      binding
    ].join('|'),
    launch: row.launchAgent ?? ''
  }
}

function observe(state: PresentationState, previous: PresentationState): void {
  if (
    state.tabsByWorktree === previous.tabsByWorktree &&
    state.unifiedTabsByWorktree === previous.unifiedTabsByWorktree &&
    state.terminalLayoutsByTabId === previous.terminalLayoutsByTabId
  ) {
    return
  }
  const seen = new Set<string>()
  for (const [worktreeId, rows] of Object.entries(state.tabsByWorktree ?? {})) {
    // Why per worktree: title churn rewrites one worktree's rows; the rest cost one compare.
    const worktreeChanged =
      rows !== previous.tabsByWorktree?.[worktreeId] ||
      state.unifiedTabsByWorktree?.[worktreeId] !== previous.unifiedTabsByWorktree?.[worktreeId]
    for (const row of rows) {
      seen.add(row.id)
      const layoutChanged =
        state.terminalLayoutsByTabId?.[row.id] !== previous.terminalLayoutsByTabId?.[row.id]
      const before = signaturesByTabId.get(row.id)
      if (before && !worktreeChanged && !layoutChanged) {
        continue
      }
      const signature = rowSignature(state, worktreeId, row)
      if (before?.presentation !== signature.presentation) {
        bump(row.id, before !== undefined && before.launch !== signature.launch)
      }
      signaturesByTabId.set(row.id, signature)
    }
  }
  if (state.tabsByWorktree !== previous.tabsByWorktree) {
    for (const tabId of signaturesByTabId.keys()) {
      if (!seen.has(tabId)) {
        signaturesByTabId.delete(tabId)
        stampsByTabId.delete(tabId)
      }
    }
  }
}

/** Call once from inside the store's state creator, passing its `api`. */
export function installTerminalPresentationStampTracking(api: {
  subscribe: (listener: (state: PresentationState, previous: PresentationState) => void) => unknown
}): void {
  api.subscribe((state, previous) => observe(state, previous))
}

/** An accepted user/client switch, even to the value already shown, orders after older exits. */
export function noteTerminalPresentationIntent(tabId: string): void {
  bump(tabId, false)
}

/** A launch into an existing tab, even of the same agent: earlier exit evidence no longer applies. */
export function noteTerminalPresentationLaunch(tabId: string): void {
  bump(tabId, true)
}

export function readTerminalPresentationStamp(tabId: string): TerminalPresentationStamp {
  return stampsByTabId.get(tabId) ?? EMPTY_STAMP
}

/** The token this store publishes for a tab; equal only while nothing reordered its presentation. */
export function readTerminalPresentationToken(tabId: string): string {
  return `${PRESENTATION_EPOCH}.${readTerminalPresentationStamp(tabId).revision}`
}

export function resetTerminalPresentationStampsForTest(): void {
  stampsByTabId.clear()
  signaturesByTabId.clear()
}
