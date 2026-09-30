import type { AgentProcessPresence } from '../../shared/agent-process-presence'
import {
  paneEvidenceAgent,
  paneEvidenceCounts,
  selectLiveOwnerAgent,
  withoutEndedOwnerTitle
} from '../../shared/ended-agent-owner-evidence'
import {
  isAgentForegroundWrapperProcess,
  isExpectedAgentProcess,
  recognizeAgentProcess
} from '../../shared/agent-process-recognition'
import { isOpenCodeNativeTitle, isShellProcess } from '../../shared/agent-detection'
import type { TuiAgent } from '../../shared/tui-agent'
import { isKnownReadyPromptPreview } from './terminal-wait-detection'
import { buildTerminalWaitText } from './terminal-wait-tail-state'
import type { RuntimeLeafRecord, RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import {
  agentTitleProvesAgentPresence,
  classifyAgentTitle,
  classifyLatestAgentTitle,
  getLatestAgentCandidateTitle,
  getLatestLeafTitle,
  ptyTitleProvesAgentPresence
} from './runtime-worktree-status-projection'

const WRAPPER_RETRY_INTERVAL_MS = 150
const WRAPPER_RETRY_TIMEOUT_MS = 6_500

type RuntimeTerminalAgentPresenceDependencies = {
  getAgentPresence?(handle: string): AgentProcessPresence | undefined
  /** A structured agent session of this runtime; it has no pane, so no PTY probe can see it. */
  isLiveStructuredAgent?(handle: string): boolean
  getLivePty(handle: string): RuntimePtyWorktreeRecord | null
  getLiveLeaf(handle: string): RuntimeLeafRecord
  getPrimaryLeaf(ptyId: string): RuntimeLeafRecord | null
  getTrackedPty(ptyId: string): RuntimePtyWorktreeRecord | null
  getTabTitle(tabId: string): string | null
  getForegroundProcess(ptyId: string): Promise<string | null> | null
}

export type RuntimeTerminalAgentPresenceOptions = {
  retryForegroundWrappers?: boolean
  /** Foreground identity the caller already confirmed; skips the provider's cached read. */
  foregroundProcess?: string | null
}

/** Once the identified owner exited, its own launch intent no longer describes the pane. */
function withoutEndedOwnerLaunch<T extends { launchAgent: TuiAgent | null }>(
  pty: T,
  presence: AgentProcessPresence | undefined
): T {
  const launchAgent = paneEvidenceAgent(presence, pty.launchAgent)
  return launchAgent === pty.launchAgent ? pty : { ...pty, launchAgent }
}

export class RuntimeTerminalAgentPresence {
  constructor(private readonly deps: RuntimeTerminalAgentPresenceDependencies) {}

  async isRunning(
    handle: string,
    options: RuntimeTerminalAgentPresenceOptions = {}
  ): Promise<boolean> {
    // Before every PTY probe below, because none of them can answer for a session that has no
    // pane: `getLiveLeaf` threw, the catch turned that into `false`, and a coordinator running
    // `dispatch --inject` concluded its structured worker was a bare shell — `no_agent_detected`.
    // A structured session IS the agent; there is no foreground process to recognise.
    if (this.deps.isLiveStructuredAgent?.(handle)) {
      return true
    }
    const presence = this.deps.getAgentPresence?.(handle)
    try {
      const pty = this.deps.getLivePty(handle)
      if (pty) {
        return await this.isPtyRunning(pty, this.deps.getPrimaryLeaf(pty.ptyId), options, presence)
      }
      const leaf = this.deps.getLiveLeaf(handle)
      const tracked = leaf.ptyId ? this.deps.getTrackedPty(leaf.ptyId) : null
      const trackedPty = tracked && withoutEndedOwnerLaunch(tracked, presence)
      const paneTitle = withoutEndedOwnerTitle(getLatestLeafTitle(leaf, null), presence)
      const paneClassification = classifyAgentTitle(paneTitle)
      if (
        trackedPty
          ? ptyTitleProvesAgentPresence(trackedPty, paneTitle, paneClassification)
          : agentTitleProvesAgentPresence(paneTitle, paneClassification)
      ) {
        return true
      }
      const tabTitle = withoutEndedOwnerTitle(this.deps.getTabTitle(leaf.tabId), presence)
      const tabClassification = paneTitle === null ? classifyAgentTitle(tabTitle) : 'neutral'
      if (
        trackedPty
          ? ptyTitleProvesAgentPresence(trackedPty, tabTitle, tabClassification)
          : agentTitleProvesAgentPresence(tabTitle, tabClassification)
      ) {
        return true
      }
      const markerTitle = paneTitle ?? tabTitle
      const waitText = buildTerminalWaitText(leaf.tailBuffer, leaf.tailPartialLine, leaf.preview)
      if (!isOpenCodeNativeTitle(markerTitle) && isKnownReadyPromptPreview(waitText)) {
        return true
      }
      if (leaf.lastAgentStatus !== null && paneTitle === null && tabTitle === null) {
        return true
      }
      if (!leaf.ptyId) {
        return false
      }
      const suppressClaude =
        paneClassification === 'management' || tabClassification === 'management'
      return await this.isForegroundAgent(leaf.ptyId, presence, suppressClaude, options)
    } catch {
      return false
    }
  }

  private async isPtyRunning(
    livePty: RuntimePtyWorktreeRecord,
    leaf: RuntimeLeafRecord | null,
    options: RuntimeTerminalAgentPresenceOptions,
    presence: AgentProcessPresence | undefined
  ): Promise<boolean> {
    const pty = withoutEndedOwnerLaunch(livePty, presence)
    const leafTitle = withoutEndedOwnerTitle(
      leaf
        ? getLatestAgentCandidateTitle(
            { title: leaf.paneTitle, updatedAt: leaf.paneTitleUpdatedAt },
            { title: leaf.lastOscTitle, updatedAt: leaf.lastOscTitleAt }
          )
        : null,
      presence
    )
    const leafClassification = classifyAgentTitle(leafTitle)
    if (ptyTitleProvesAgentPresence(pty, leafTitle, leafClassification)) {
      return true
    }
    const ptyTitle = withoutEndedOwnerTitle(
      getLatestAgentCandidateTitle(
        { title: pty.title, updatedAt: pty.titleUpdatedAt },
        { title: pty.lastOscTitle, updatedAt: pty.lastOscTitleAt }
      ),
      presence
    )
    const ptyClassification = classifyAgentTitle(ptyTitle)
    if (leafTitle === null && ptyTitleProvesAgentPresence(pty, ptyTitle, ptyClassification)) {
      return true
    }
    const managementClassification = classifyLatestAgentTitle({
      title: pty.managementTitle,
      updatedAt: pty.managementTitleAt
    })
    const markerTitle = leafTitle ?? ptyTitle
    if (isOpenCodeNativeTitle(markerTitle) && pty.launchAgent === 'opencode') {
      return true
    }
    const waitText = buildTerminalWaitText(pty.tailBuffer, pty.tailPartialLine, pty.preview)
    if (!isOpenCodeNativeTitle(markerTitle) && isKnownReadyPromptPreview(waitText)) {
      return true
    }
    if (
      pty.lastAgentStatus !== null &&
      leafTitle === null &&
      ptyTitle === null &&
      managementClassification !== 'management'
    ) {
      return true
    }
    const suppressClaude =
      leafTitle !== null
        ? leafClassification === 'management'
        : managementClassification === 'management'
    return await this.isForegroundAgent(pty.ptyId, presence, suppressClaude, options)
  }

  /** Presence proves the agent exists; the foreground read still decides who holds the keyboard. */
  private async isForegroundAgent(
    ptyId: string,
    presence: AgentProcessPresence | undefined,
    suppressClaude: boolean,
    options: RuntimeTerminalAgentPresenceOptions
  ): Promise<boolean> {
    const foreground = await this.readForegroundProcess(ptyId, options).catch(() => null)
    const owner = selectLiveOwnerAgent(presence)
    // Why: a live owner answers only when the read cannot (unavailable, or a name like wsl.exe);
    // a shell in front, as after Ctrl-Z, still owns the keyboard. Never over a management screen.
    if (owner && !(foreground && isShellProcess(foreground))) {
      return !(suppressClaude && owner === 'claude')
    }
    if (!foreground) {
      return false
    }
    if (suppressClaude && isExpectedAgentProcess(foreground, 'claude')) {
      return false
    }
    return await this.isRecognizedForegroundAgentProcess(
      ptyId,
      foreground,
      suppressClaude,
      options.retryForegroundWrappers !== false,
      presence
    )
  }

  private async readForegroundProcess(
    ptyId: string,
    options: RuntimeTerminalAgentPresenceOptions
  ): Promise<string | null> {
    if (options.foregroundProcess !== undefined) {
      return options.foregroundProcess
    }
    return await this.deps.getForegroundProcess(ptyId)
  }

  private async isRecognizedForegroundAgentProcess(
    ptyId: string,
    foregroundProcess: string,
    suppressClaude: boolean,
    retryForegroundWrappers: boolean,
    presence: AgentProcessPresence | undefined
  ): Promise<boolean> {
    const recognized = recognizeAgentProcess(foregroundProcess)
    if (recognized) {
      return (
        paneEvidenceCounts(presence, recognized.agent) &&
        !(suppressClaude && isExpectedAgentProcess(recognized.processName, 'claude'))
      )
    }
    if (!isAgentForegroundWrapperProcess(foregroundProcess)) {
      return false
    }
    if (!retryForegroundWrappers) {
      return false
    }
    const startedAt = Date.now()
    while (Date.now() - startedAt < WRAPPER_RETRY_TIMEOUT_MS) {
      await new Promise((resolve) => setTimeout(resolve, WRAPPER_RETRY_INTERVAL_MS))
      const refreshed = await this.deps.getForegroundProcess(ptyId)
      const refreshedRecognition = recognizeAgentProcess(refreshed)
      if (refreshedRecognition) {
        return (
          paneEvidenceCounts(presence, refreshedRecognition.agent) &&
          !(suppressClaude && isExpectedAgentProcess(refreshedRecognition.processName, 'claude'))
        )
      }
      if (!refreshed || !isAgentForegroundWrapperProcess(refreshed)) {
        return false
      }
    }
    return false
  }
}
