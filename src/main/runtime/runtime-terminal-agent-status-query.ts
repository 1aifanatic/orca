import {
  detectAgentStatusFromTitle,
  isOpenCodeNativeTitle,
  isShellProcess,
  type AgentStatus
} from '../../shared/agent-detection'
import { recognizeAgentProcess } from '../../shared/agent-process-recognition'
import type { RuntimeTerminalAgentStatus } from '../../shared/runtime-types'
import type { RuntimePtyController } from './runtime-pty-controller-contract'
import type { RuntimeLeafRecord, RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import {
  terminalTitleBlocksExplicitAgentStatus,
  agentTitleProvesAgentPresence,
  getLatestAgentCandidate
} from './runtime-worktree-status-projection'
import { detectTerminalWaitBlockedReason } from './terminal-wait-detection'
import { getTerminalState } from './terminal-wait-results'
import { buildTerminalWaitText } from './terminal-wait-tail-state'

export type RuntimeTerminalAgentStatusSnapshot = {
  waitText: string
  waitBlockedAt: number | null
  title: string | null
  titleStatus: AgentStatus | null
  titleStatusIsLive: boolean
  /** The title is the agent's own and display has retired it (stale-working clear). */
  titleRetiredForDisplay: boolean
}

type Dependencies = {
  getController(): RuntimePtyController | null
  getLivePty(handle: string): { pty: RuntimePtyWorktreeRecord } | null
  getLiveLeaf(handle: string): { leaf: RuntimeLeafRecord }
  getPrimaryLeaf(ptyId: string): RuntimeLeafRecord | null
  getTabTitle(tabId: string): string | null
  getExplicitStatus(
    handle: string
  ): { status: NonNullable<RuntimeTerminalAgentStatus['status']>; updatedAt: number } | null
  getLifecycleStatus(
    ptyId: string
  ): { status: AgentStatus | null; updatedAt: number } | null | undefined
  isRunning(handle: string): Promise<boolean>
  hasTitleDisplayClear(ptyId: string): boolean
}

export class RuntimeTerminalAgentStatusQuery {
  private readonly inFlight = new Map<string, Promise<RuntimeTerminalAgentStatus>>()

  constructor(private readonly deps: Dependencies) {}

  async getStatus(handle: string): Promise<RuntimeTerminalAgentStatus> {
    const existing = this.inFlight.get(handle)
    if (existing) {
      return existing
    }
    const request = this.readStatus(handle)
    this.inFlight.set(handle, request)
    try {
      return await request
    } finally {
      if (this.inFlight.get(handle) === request) {
        this.inFlight.delete(handle)
      }
    }
  }

  private async readStatus(handle: string): Promise<RuntimeTerminalAgentStatus> {
    const ptyId = this.getPtyId(handle)
    const terminal = this.getSnapshot(handle, ptyId)
    const explicitStatus = this.deps.getExplicitStatus(handle)
    const lifecycle = this.deps.getLifecycleStatus(ptyId)
    const blockedByWaitText = detectTerminalWaitBlockedReason(terminal.waitText)
    const liveTitleClearsBlockedText =
      terminal.titleStatusIsLive &&
      terminal.titleStatus !== null &&
      terminal.titleStatus !== 'permission' &&
      !isOpenCodeNativeTitle(terminal.title) &&
      blockedByWaitText !== 'agent-approval-prompt'
    const newestPermissionAt = Math.max(
      explicitStatus?.status === 'permission' ? explicitStatus.updatedAt : -1,
      lifecycle?.status === 'permission' ? lifecycle.updatedAt : -1,
      terminal.waitBlockedAt ?? -1
    )
    const newestClearAt = Math.max(
      explicitStatus && explicitStatus.status !== 'permission' ? explicitStatus.updatedAt : -1,
      lifecycle?.status && lifecycle.status !== 'permission' ? lifecycle.updatedAt : -1
    )
    if (terminal.titleStatus === 'permission' && terminal.titleStatusIsLive) {
      return { handle, isRunningAgent: true, status: 'permission' }
    }
    if (
      blockedByWaitText &&
      (!liveTitleClearsBlockedText || lifecycle?.status === terminal.titleStatus) &&
      (blockedByWaitText === 'agent-approval-prompt' ||
        (newestPermissionAt >= 0 && newestPermissionAt >= newestClearAt))
    ) {
      return { handle, isRunningAgent: true, status: 'permission' }
    }
    if (explicitStatus) {
      // Why: permission titles can linger after hooks report the agent resumed.
      // Fresh hook state is tighter, but current shell/management evidence wins.
      const isRunningAgent =
        !terminalTitleBlocksExplicitAgentStatus(terminal.title) &&
        !(await this.terminalHasShellForegroundProcess(handle, ptyId))
      this.assertTerminalAgentStatusPtyBinding(handle, ptyId)
      return {
        handle,
        isRunningAgent,
        status: isRunningAgent ? explicitStatus.status : null
      }
    }
    if (terminal.titleStatus) {
      // Activity-only titles need the same identity check as the presence query, and so does a
      // title the stale-working timer retired: the agent may have exited behind it.
      if (
        terminal.titleRetiredForDisplay ||
        !agentTitleProvesAgentPresence(terminal.title, 'agent')
      ) {
        const isRunningAgent = await this.deps.isRunning(handle)
        this.assertTerminalAgentStatusPtyBinding(handle, ptyId)
        return {
          handle,
          isRunningAgent,
          status: isRunningAgent ? terminal.titleStatus : null
        }
      }
      return { handle, isRunningAgent: true, status: terminal.titleStatus }
    }

    const isRunningAgent = await this.deps.isRunning(handle)
    this.assertTerminalAgentStatusPtyBinding(handle, ptyId)
    return { handle, isRunningAgent, status: null }
  }

  getPtyId(handle: string): string {
    const pty = this.deps.getLivePty(handle)
    if (pty) {
      if (!pty.pty.connected) {
        throw new Error('terminal_gone')
      }
      return pty.pty.ptyId
    }
    const { leaf } = this.deps.getLiveLeaf(handle)
    if (getTerminalState(leaf) !== 'running') {
      throw new Error('terminal_exited')
    }
    if (!leaf.ptyId) {
      throw new Error('terminal_gone')
    }
    return leaf.ptyId
  }

  private assertTerminalAgentStatusPtyBinding(handle: string, expectedPtyId: string): void {
    if (this.getPtyId(handle) === expectedPtyId) {
      return
    }
    // Why: delayed process evidence belongs only to the PTY that started the
    // read, while callers still rely on the established stale-handle contract.
    throw new Error('terminal_handle_stale')
  }

  getSnapshot(handle: string, expectedPtyId: string): RuntimeTerminalAgentStatusSnapshot {
    const pty = this.deps.getLivePty(handle)
    if (pty) {
      if (!pty.pty.connected || pty.pty.ptyId !== expectedPtyId) {
        throw new Error('terminal_not_writable')
      }
      const leaf = this.deps.getPrimaryLeaf(pty.pty.ptyId)
      const leafOsc = { title: leaf?.lastOscTitle, updatedAt: leaf?.lastOscTitleAt }
      const ptyOsc = { title: pty.pty.lastOscTitle, updatedAt: pty.pty.lastOscTitleAt }
      const latest =
        (leaf
          ? getLatestAgentCandidate(
              { title: leaf.paneTitle, updatedAt: leaf.paneTitleUpdatedAt },
              leafOsc
            )
          : null) ??
        getLatestAgentCandidate({ title: pty.pty.title, updatedAt: pty.pty.titleUpdatedAt }, ptyOsc)
      const titleText = latest?.title?.trim() ?? null
      const waitText = buildTerminalWaitText(
        pty.pty.tailBuffer,
        pty.pty.tailPartialLine,
        pty.pty.preview
      )
      return {
        waitText,
        waitBlockedAt: pty.pty.waitBlockedAt,
        title: titleText,
        titleStatus: titleText ? detectAgentStatusFromTitle(titleText) : pty.pty.lastAgentStatus,
        titleStatusIsLive: titleText !== null,
        titleRetiredForDisplay:
          (latest === leafOsc || latest === ptyOsc) && this.deps.hasTitleDisplayClear(pty.pty.ptyId)
      }
    }

    const { leaf } = this.deps.getLiveLeaf(handle)
    if (getTerminalState(leaf) !== 'running') {
      throw new Error('terminal_exited')
    }
    if (!leaf.ptyId) {
      throw new Error('terminal_gone')
    }
    if (leaf.ptyId !== expectedPtyId) {
      throw new Error('terminal_not_writable')
    }
    const leafOsc = { title: leaf.lastOscTitle, updatedAt: leaf.lastOscTitleAt }
    const title = getLatestAgentCandidate(
      { title: leaf.paneTitle, updatedAt: leaf.paneTitleUpdatedAt },
      leafOsc,
      { title: this.deps.getTabTitle(leaf.tabId), updatedAt: 0 }
    )
    const titleText = title?.title?.trim() ?? null
    return {
      waitText: buildTerminalWaitText(leaf.tailBuffer, leaf.tailPartialLine, leaf.preview),
      waitBlockedAt: leaf.waitBlockedAt,
      title: titleText,
      titleStatus: titleText ? detectAgentStatusFromTitle(titleText) : leaf.lastAgentStatus,
      titleStatusIsLive: (title?.updatedAt ?? 0) > 0,
      titleRetiredForDisplay: title === leafOsc && this.deps.hasTitleDisplayClear(leaf.ptyId)
    }
  }

  private async terminalHasShellForegroundProcess(handle: string, ptyId: string): Promise<boolean> {
    const controller = this.deps.getController()
    if (!controller) {
      return false
    }
    let foregroundProcess: string | null
    try {
      foregroundProcess = await controller.getForegroundProcess(ptyId)
    } catch {
      this.assertTerminalAgentStatusPtyBinding(handle, ptyId)
      return false
    }
    this.assertTerminalAgentStatusPtyBinding(handle, ptyId)
    if (!foregroundProcess || !isShellProcess(foregroundProcess)) {
      return false
    }
    const confirmationController = this.deps.getController()
    if (!confirmationController?.confirmForegroundProcess) {
      return true
    }
    let confirmedProcess: string | null
    try {
      confirmedProcess = await confirmationController.confirmForegroundProcess(ptyId)
    } catch {
      this.assertTerminalAgentStatusPtyBinding(handle, ptyId)
      return true
    }
    this.assertTerminalAgentStatusPtyBinding(handle, ptyId)
    // Why: hook identity is generic; strong provider evidence only needs to
    // prove that some recognized agent still owns this exact PTY.
    return recognizeAgentProcess(confirmedProcess) === null
  }
}
