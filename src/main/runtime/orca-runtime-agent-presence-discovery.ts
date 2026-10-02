// @ts-nocheck -- mechanically split from OrcaRuntimeService; behavior is covered by AST equivalence and characterization tests.
import type { AgentProcessIdentity, AgentProcessVerdict } from '../../shared/agent-process-presence'
import { OrcaRuntimeWithControllerKnowsPtyIsLive } from './orca-runtime-controller-knows-pty-is-live'

export class OrcaRuntimeWithAgentPresenceDiscovery extends OrcaRuntimeWithControllerKnowsPtyIsLive {
  private readonly agentPresenceDiscovery = new Map<string, Promise<void>>()

  private hasAgentPresenceOwner(keys: Iterable<string>): boolean {
    return [...keys].some((key) => {
      const presence = this.getAgentOwnerFn?.(key)?.presence
      return Boolean(presence?.process && !presence.ended)
    })
  }

  protected scheduleAgentPresenceDiscovery(ptyId: string): void {
    const pty = this.ptysById.get(ptyId)
    if (
      !pty ||
      pty.isWsl ||
      pty.connectionId ||
      process.platform === 'win32' ||
      this.hasAgentPresenceOwner(this.collectAgentStatusPaneKeysForPty(ptyId))
    ) {
      return
    }
    const incarnation = pty.incarnationId
    this.agentPresenceCommands.start(
      ptyId,
      () => this.ptysById.get(ptyId) === pty && pty.incarnationId === incarnation
    )
  }

  async probeWindowsAgentOwner(
    paneKey: string,
    identity: AgentProcessIdentity
  ): Promise<AgentProcessVerdict> {
    for (const [id, pty] of this.ptysById) {
      if (
        !pty.isWsl &&
        !pty.connectionId &&
        this.collectAgentStatusPaneKeysForPty(id).has(paneKey)
      ) {
        return this.ptyController?.probeAgentPresence?.(id, identity) ?? 'unverifiable'
      }
    }
    return 'unverifiable'
  }

  observeAgentPresenceEvidence(paneKey: string, checkOwner = false): void {
    for (const [id] of this.ptysById) {
      if (this.collectAgentStatusPaneKeysForPty(id).has(paneKey)) {
        if (checkOwner) {
          this.recheckAgentPresenceEvidence(id, true)
        } else {
          void this.discoverAgentPresence(id)
        }
        return
      }
    }
  }

  protected recheckAgentPresenceEvidence(id: string, discover: boolean): void {
    const pty = this.ptysById.get(id)
    const incarnation = pty?.incarnationId
    const controller = this.ptyController
    void this.recheckHookAgentPresenceForPty(id).then(() => {
      if (
        discover &&
        this.ptysById.get(id) === pty &&
        pty?.incarnationId === incarnation &&
        this.ptyController === controller
      ) {
        void this.discoverAgentPresence(id)
      }
    })
  }

  protected discoverLaunchedAgentPresence(pty: { ptyId: string; launchAgent: unknown }): void {
    if (pty.launchAgent) {
      this.scheduleAgentPresenceDiscovery(pty.ptyId)
    }
  }

  protected discoverAgentPresence(
    ptyId: string,
    commandCurrent: () => boolean = () => true
  ): Promise<void> {
    const pty = this.ptysById.get(ptyId)
    const controller = this.ptyController
    if (!pty?.connected || pty.isWsl || pty.connectionId || !controller?.captureAgentPresence) {
      return Promise.resolve()
    }
    const incarnation = pty.incarnationId
    const discoveryKey = `${ptyId}\0${incarnation}`
    const pending = this.agentPresenceDiscovery.get(discoveryKey)
    if (pending) {
      return pending
    }
    const keys = [...this.collectAgentStatusPaneKeysForPty(ptyId)]
    const hasOwner = () => this.hasAgentPresenceOwner(keys)
    if (hasOwner()) {
      return Promise.resolve()
    }
    const current = () =>
      this.ptysById.get(ptyId) === pty &&
      pty.incarnationId === incarnation &&
      this.ptyController === controller
    const discovery = controller
      .captureAgentPresence(ptyId)
      .then((presence) => {
        if (!presence || !commandCurrent() || !current() || hasOwner()) {
          return
        }
        for (const paneKey of keys) {
          this.onForegroundAgentPresence?.(
            {
              paneKey,
              connectionId: null,
              worktreeId: pty.worktreeId,
              tabId: pty.tabId ?? undefined,
              terminalHandle: this.handleByPtyId.get(ptyId)
            },
            presence
          )
        }
      })
      .catch(() => undefined)
      .finally(() => this.agentPresenceDiscovery.delete(discoveryKey))
    this.agentPresenceDiscovery.set(discoveryKey, discovery)
    return discovery
  }
}
