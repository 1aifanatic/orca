/**
 * Routes an agent hook's pane key to the pane that shows its terminal now.
 *
 * A PTY's environment is fixed at spawn, so every hook its agent runs posts the `ORCA_PANE_KEY`
 * the host exported then. The PTY can outlive that pane: a terminal that survives an app restart
 * may be adopted into a tab with a new id. The execution host records the exported key with the
 * process (`envPaneKey`), so a posted key resolves to the terminal that carries it and from there
 * to the pane that terminal occupies now. The record dies with the process, so nothing here needs
 * a TTL, and nothing is persisted beside the store.
 */
import { parsePaneKey } from '../../shared/stable-pane-id'

export type EnvPaneKeyTerminal = {
  ptyId: string
  /** The terminal's current surface as recorded by the runtime. */
  paneKey: string | null
  envPaneKey?: string | null
}

export type EnvPaneKeyRoutingSource<T extends EnvPaneKeyTerminal> = {
  terminals: Iterable<T>
  isLive: (terminal: T) => boolean
  /** Every pane the terminal is mounted in now; empty when no graph names it. */
  currentPaneKeys: (terminal: T) => readonly string[]
}

/**
 * The pane a hook posting `paneKey` belongs to now, or undefined when the key already names a
 * live pane, no live terminal carries it, or more than one does. Refusing to guess keeps an
 * ambiguous post exactly where it lands today.
 */
export function resolveTerminalPaneForEnvPaneKey<T extends EnvPaneKeyTerminal>(
  paneKey: string,
  source: EnvPaneKeyRoutingSource<T>
): string | undefined {
  if (!parsePaneKey(paneKey)) {
    return undefined
  }
  let carrier: T | undefined
  for (const terminal of source.terminals) {
    if (terminal.paneKey !== paneKey && terminal.envPaneKey !== paneKey) {
      continue
    }
    if (!source.isLive(terminal)) {
      continue
    }
    // A live terminal shows this pane, so the key is not stale.
    if (terminal.paneKey === paneKey) {
      return undefined
    }
    if (carrier) {
      return undefined
    }
    carrier = terminal
  }
  if (!carrier) {
    return undefined
  }
  const mounted = new Set(source.currentPaneKeys(carrier))
  if (mounted.size === 0 && carrier.paneKey) {
    mounted.add(carrier.paneKey)
  }
  if (mounted.has(paneKey) || mounted.size !== 1) {
    return undefined
  }
  const [current] = mounted
  return current && parsePaneKey(current) ? current : undefined
}

/** Exported keys whose terminal now shows a different pane: the keys whose rows the store must move. */
export function collectMovedEnvPaneKeys<T extends EnvPaneKeyTerminal>(
  source: EnvPaneKeyRoutingSource<T>
): string[] {
  const moved: string[] = []
  for (const terminal of source.terminals) {
    const envPaneKey = terminal.envPaneKey
    if (
      envPaneKey &&
      envPaneKey !== terminal.paneKey &&
      resolveTerminalPaneForEnvPaneKey(envPaneKey, source) !== undefined
    ) {
      moved.push(envPaneKey)
    }
  }
  return moved
}
