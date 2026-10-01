import { parseTomlKeyPath, parseTomlTableHeaderPath } from './config-toml-key-path'
import {
  createTomlLineScanState,
  getTomlTableHeader,
  isTomlStructuralLine,
  updateTomlLineScanState
} from './config-toml-line-scan'

/** Canonical inline root assignments own the whole table, which TOML forbids extending. */
export function readMcpServerTomlOwnership(config: string): {
  names: ReadonlySet<string>
  ownsRoot: boolean
} {
  return readTomlRootTableOwnership(config, 'mcp_servers')
}

/** The child tables a config declares under `root`, in header, dotted or inline form. */
export function readTomlRootTableOwnership(
  config: string,
  root: string
): {
  names: ReadonlySet<string>
  ownsRoot: boolean
} {
  const names = new Set<string>()
  let ownsRoot = false
  let tablePath: string[] | null = []
  let state = createTomlLineScanState()
  for (const line of config.split('\n')) {
    if (isTomlStructuralLine(state)) {
      const header = getTomlTableHeader(line)
      if (header) {
        tablePath = parseTomlTableHeaderPath(header)?.segments ?? null
        if (tablePath?.[0] === root && tablePath[1] !== undefined) {
          names.add(tablePath[1])
        }
      } else {
        const key = parseTomlKeyPath(line)
        const path =
          tablePath && key && line[key.end] === '=' ? [...tablePath, ...key.segments] : []
        if (path[0] === root) {
          if (path[1] === undefined) {
            ownsRoot = true
          } else {
            names.add(path[1])
          }
        }
      }
    }
    state = updateTomlLineScanState(state, line)
  }
  return { names, ownsRoot }
}
