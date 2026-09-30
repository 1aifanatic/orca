// Test fixture: a packaged Node slot whose runtime is the real pinned Node, laid out as shipped.
import { existsSync } from 'node:fs'
import { copyFile, link, mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { NODE_RUNTIME_ASSETS, type ServerTarget } from '../../shared/node-runtime-pin'
import {
  ORCAD_NODE_RUNTIME_MARKER_FILENAME,
  ORCAD_SERVER_TARGET_FILENAME,
  orcadNodeRuntimeRelativePath
} from '../../shared/orcad-artifacts'
import { detectNativeHostAbi, nativeSlotName } from './native-host-abi'

export function hostServerTarget(): ServerTarget {
  const slot = nativeSlotName(detectNativeHostAbi())
  const target = Object.keys(NODE_RUNTIME_ASSETS).find((candidate) => candidate === slot)
  if (!target) {
    throw new Error(`No pinned Node runtime for host slot ${slot}`)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: found among NODE_RUNTIME_ASSETS keys, which are ServerTargets.
  return target as ServerTarget
}

/** The pinned Node the runner (run-node-server-tests.mjs) or `build:orcad` provided, if any. */
export function locatePinnedNodeForTests(): string | null {
  const target = hostServerTarget()
  const candidates = [
    process.env.ORCA_PINNED_NODE,
    resolve(
      'out/orcad',
      ...orcadNodeRuntimeRelativePath(target, NODE_RUNTIME_ASSETS[target].executableSha256)
    )
  ]
  return (
    candidates.find((candidate): candidate is string => !!candidate && existsSync(candidate)) ??
    null
  )
}

/** Writes `<root>/slot/{.server-target,.runtime-node}` and links the runtime into `<root>/runtimes/`. */
export async function writeNodeSlotFixture(
  root: string,
  pinnedNode: string
): Promise<{ slotDir: string; runtime: string }> {
  const target = hostServerTarget()
  const { executableSha256 } = NODE_RUNTIME_ASSETS[target]
  const slotDir = join(root, 'slot')
  await mkdir(slotDir, { recursive: true })
  await writeFile(join(slotDir, ORCAD_SERVER_TARGET_FILENAME), `${target}\n`)
  await writeFile(join(slotDir, ORCAD_NODE_RUNTIME_MARKER_FILENAME), `${executableSha256}\n`)
  const runtime = join(slotDir, ...orcadNodeRuntimeRelativePath(target, executableSha256))
  await mkdir(join(runtime, '..'), { recursive: true })
  // Why a hard link: the runtime is ~120 MB, and a copy per test would dominate the suite.
  await link(pinnedNode, runtime).catch(() => copyFile(pinnedNode, runtime))
  return { slotDir, runtime }
}
