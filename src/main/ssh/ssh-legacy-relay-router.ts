/**
 * Which earlier-build relay, if any, serves a PTY the current relay answered "not found" for.
 *
 * Opens a route to each older endpoint the deploy's census found only when a pane asks for a PTY the
 * current relay disowned, keeps the route while it serves a pane, and hangs it up once it serves
 * none. An unreachable or non-bridgeable relay leaves the pane held, never respawned.
 */
import type { SshPtyProvider } from '../providers/ssh-pty-provider'
import type { SshPtyLegacyRelayRouting } from '../providers/ssh-pty-legacy-relay-delegation'
import type { SshLegacyRelayRoute } from './ssh-legacy-relay-route'

export type SshLegacyRelayRouterOptions = {
  targetId: string
  endpoints: () => Promise<string[]>
  openRoute: (sockPath: string) => Promise<SshLegacyRelayRoute | null>
}

type RouteEntry = {
  pending: Promise<SshLegacyRelayRoute | null>
  /** Set once opened; synchronous lookups read only routes that finished opening. */
  route?: SshLegacyRelayRoute | null
}

export class SshLegacyRelayRouter implements SshPtyLegacyRelayRouting {
  private readonly routes = new Map<string, RouteEntry>()
  private readonly disposeListeners = new Set<() => void>()
  private disposed = false

  constructor(private readonly options: SshLegacyRelayRouterOptions) {}

  /** The route's provider for a pane being attached, already marked as served. */
  async attach(
    appPtyId: string
  ): Promise<{ provider: SshPtyProvider; release: () => void } | null> {
    for (const sockPath of await this.options.endpoints()) {
      const route = await this.route(sockPath)
      if (this.disposed) {
        return null
      }
      if (route?.holds(appPtyId)) {
        route.beginServing(appPtyId)
        return { provider: route.provider, release: () => this.release(route, appPtyId) }
      }
      if (route && !route.servesAny) {
        route.close('legacy-relay-holds-no-requested-terminal')
      }
    }
    return null
  }

  /**
   * Every PTY the older relays still run, for the migration terminal gate. Null when one of them
   * could not be asked: an unreachable or non-bridgeable relay is unverifiable, never empty.
   */
  async listHeld(): Promise<string[] | null> {
    const held: string[] = []
    for (const sockPath of await this.options.endpoints()) {
      const route = await this.route(sockPath)
      if (!route || this.disposed) {
        return null
      }
      held.push(...route.heldPtyIds())
      if (!route.servesAny) {
        route.close('legacy-relay-listed-for-terminal-gate')
      }
    }
    return held
  }

  /** Releases a pane whose attach through the route did not complete. */
  private release(route: SshLegacyRelayRoute, appPtyId: string): void {
    route.stopServing(appPtyId)
    if (!route.servesAny) {
      route.close('legacy-relay-attach-abandoned')
    }
  }

  providerFor(appPtyId: string): SshPtyProvider | undefined {
    for (const { route } of this.routes.values()) {
      if (route?.serves(appPtyId)) {
        return route.provider
      }
    }
    return undefined
  }

  /** Every pane a route serves, for listings that must not read a served PTY as gone. */
  servedProviders(): SshPtyProvider[] {
    const providers: SshPtyProvider[] = []
    for (const { route } of this.routes.values()) {
      if (route?.servesAny) {
        providers.push(route.provider)
      }
    }
    return providers
  }

  onDispose(listener: () => void): void {
    this.disposeListeners.add(listener)
  }

  dispose(): void {
    this.disposed = true
    this.disposeListeners.forEach((listener) => listener())
    for (const { route } of this.routes.values()) {
      route?.close('legacy-relay-router-disposed')
    }
    this.routes.clear()
  }

  private route(sockPath: string): Promise<SshLegacyRelayRoute | null> {
    const existing = this.routes.get(sockPath)
    if (existing) {
      return existing.pending
    }
    const entry: RouteEntry = { pending: Promise.resolve(null) }
    entry.pending = this.options.openRoute(sockPath).then(
      (route) => {
        entry.route = route
        route?.onClose(() => {
          if (this.routes.get(sockPath) === entry) {
            this.routes.delete(sockPath)
          }
        })
        if (this.disposed) {
          route?.close('legacy-relay-router-disposed')
        }
        return route
      },
      (error: unknown) => {
        console.warn(
          `[ssh-relay] Previous relay at ${sockPath} could not be reached for ${this.options.targetId}; its terminals stay held: ${
            error instanceof Error ? error.message : String(error)
          }`
        )
        if (this.routes.get(sockPath) === entry) {
          this.routes.delete(sockPath)
        }
        return null
      }
    )
    this.routes.set(sockPath, entry)
    return entry.pending
  }
}
