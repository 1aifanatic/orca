/** `orca serve` on this machine's orcad slot; see `serve-runtime-selection.ts` for when. */
import { dirname, join } from 'node:path'
import type { ServeOrcaAppArgs } from './launch'
import type { ServeRuntimeSelection } from './serve-runtime-selection'
import { waitForRecipeJson } from './serve-recipe-json'
import { superviseForegroundServe } from './serve-update-supervisor'

type SupervisorArgs = Parameters<typeof superviseForegroundServe>[0]

export function orcadTemplateCandidates(appRoot: string): string[] {
  return [
    ...(process.resourcesPath ? [join(process.resourcesPath, 'orcad-template')] : []),
    join(appRoot, 'out', 'orcad-template')
  ]
}

/** Electron serve binds every interface (`exposeNetworkByDefault`); orcad does it on request. */
export function serveWithOrcad(
  selection: Extract<ServeRuntimeSelection, { kind: 'orcad' }>,
  args: ServeOrcaAppArgs,
  userDataPath: string,
  spawnProcess: SupervisorArgs['spawnChild']
): Promise<number> {
  const childArgs = [selection.entry, ...orcadServeArgs(args)]
  const spawnOptions: SupervisorArgs['spawnOptions'] = {
    detached: args.recipeJson === true,
    cwd: dirname(selection.entry),
    stdio: args.recipeJson === true ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    env: {
      ...withoutElectronRunAsNode(process.env),
      // The desktop's profile: its instance lock makes the two refuse each other.
      ORCA_USER_DATA: userDataPath,
      ORCA_VERSION: selection.version
    }
  }
  const child = spawnProcess(selection.runtime, childArgs, spawnOptions)
  if (args.recipeJson) {
    return waitForRecipeJson(child)
  }
  return superviseForegroundServe({
    executable: selection.runtime,
    childArgs,
    spawnOptions,
    spawnChild: spawnProcess,
    child,
    handoffPath: null,
    expectedHandoff: null
  })
}

export function orcadServeArgs(args: ServeOrcaAppArgs): string[] {
  return [
    '--bind',
    '0.0.0.0',
    ...(args.json ? ['--json'] : []),
    ...(args.port ? ['--port', args.port] : []),
    ...(args.pairingAddress ? ['--pairing-address', args.pairingAddress] : []),
    ...(args.noPairing ? ['--no-pairing'] : []),
    ...(args.mobilePairing ? ['--mobile-pairing'] : []),
    ...(args.recipeJson && args.projectRoot
      ? ['--recipe-json', '--project-root', args.projectRoot]
      : [])
  ]
}

function withoutElectronRunAsNode(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env }
  delete next.ELECTRON_RUN_AS_NODE
  return next
}
