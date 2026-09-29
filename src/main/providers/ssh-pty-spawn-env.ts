import { posix, win32 } from 'node:path'
import { seedPowerlevel10kWizardEnv } from '../pty/powerlevel10k-wizard-env'
import type { RemoteCliBridgeEnv } from './ssh-pty-provider-contract'

export function buildSshPtySpawnEnv(args: {
  env: Record<string, string> | undefined
  envToDelete?: readonly string[]
  remoteCliBridgeEnv?: RemoteCliBridgeEnv
}): Record<string, string> {
  const merged = { ...args.env }
  // Why outside the bridge: the remote shell's Codex launch policy needs no Orca CLI; only hook prep does.
  merged.ORCA_CODEX_LAUNCH_POLICY = '1'
  if (args.remoteCliBridgeEnv) {
    const pathDelimiter = args.remoteCliBridgeEnv.pathDelimiter ?? ':'
    const pathKey = merged.PATH !== undefined ? 'PATH' : merged.Path !== undefined ? 'Path' : null
    if (pathKey) {
      const pathValue = merged[pathKey] ?? ''
      merged[pathKey] = pathValue.split(pathDelimiter).includes(args.remoteCliBridgeEnv.binDir)
        ? pathValue
        : pathValue
          ? `${args.remoteCliBridgeEnv.binDir}${pathDelimiter}${pathValue}`
          : args.remoteCliBridgeEnv.binDir
    }
    const remotePath = pathDelimiter === ';' ? win32 : posix
    merged.ORCA_CODEX_LAUNCH_PREFLIGHT = remotePath.join(
      args.remoteCliBridgeEnv.binDir,
      pathDelimiter === ';' ? 'orca.exe' : 'orca'
    )
    merged.ORCA_REMOTE_CLI_BIN_DIR = args.remoteCliBridgeEnv.binDir
    merged.ORCA_RELAY_DIR = args.remoteCliBridgeEnv.relayDir
    merged.ORCA_RELAY_NODE_PATH = args.remoteCliBridgeEnv.nodePath
    merged.ORCA_RELAY_SOCKET_PATH = args.remoteCliBridgeEnv.sockPath
    if (args.remoteCliBridgeEnv.credentialFile) {
      merged.ORCA_RELAY_CREDENTIAL_FILE = args.remoteCliBridgeEnv.credentialFile
    }
  }
  // Why: match local/daemon precedence—managed defaults cannot restore explicitly removed values.
  for (const key of args.envToDelete ?? []) {
    delete merged[key]
  }
  seedPowerlevel10kWizardEnv(merged, { envToDelete: args.envToDelete })
  return merged
}
