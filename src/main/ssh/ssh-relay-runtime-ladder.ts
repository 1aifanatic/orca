/**
 * The design D6 fallback ladder for the relay runtime, as data plus a pure step function:
 *
 *   A  Orca's pinned Node + slot prebuilds
 *   B  a compat pinned Node + compat addons (chosen only when a compat runtime exists)
 *   C  the host's Node >= 18 + Orca's N-API prebuilds, no npm
 *   D  nothing runs: plain SSH terminals and SFTP, recording the classified reason
 *
 * The host's Node + npm install (`legacy`) sits outside the ladder, reached by opting in, or in
 * place of D where the ladder could not judge the host (see `relayRuntimeStepAfterRefusal`).
 *
 * The ladder steps down only on a classified refusal (a `PinnedRelayFallbackError`); an
 * unverifiable probe or self-test throws and the next connect retries the same rung.
 */
import {
  COMPAT_SERVER_TARGET_BASES,
  isCompatServerTarget,
  pinnedNodeRuntimeAsset,
  type CompatServerTarget,
  type NodeRuntimeTarget,
  type ServerTarget
} from '../../shared/node-runtime-pin'
import type { SshRemoteRuntime, SshRemoteRuntimeRung } from '../../shared/ssh-types'
import type { GlibcVersion } from './orcad-deployment-target'
import type { RemoteOperatingSystem } from './ssh-remote-platform'
import {
  isGlibcBelow,
  isPinnedRuntimeRefusal,
  PINNED_NODE_GLIBC_FLOOR,
  type RelayRuntimeFallbackReason
} from './ssh-relay-pinned-node'

export type RelayRuntimeStep = SshRemoteRuntimeRung

export type CompatRelayRuntime = {
  id: string
  /** The pinned compat runtime and orcad slot it runs (NODE_RUNTIME_COMPAT_ASSETS). */
  runtimeTarget: CompatServerTarget
  /** The host target this runtime serves, e.g. linux-x64-glibc for a glibc 2.17 build. */
  hostTarget: ServerTarget
  /** Null for a musl or darwin target, which has no glibc to compare. */
  glibcFloor: GlibcVersion | null
}

/** Rung B is chosen from this list alone. */
export const COMPAT_RELAY_RUNTIMES: readonly CompatRelayRuntime[] = [
  {
    id: 'glibc217',
    runtimeTarget: 'linux-x64-glibc217',
    hostTarget: COMPAT_SERVER_TARGET_BASES['linux-x64-glibc217'],
    glibcFloor: { major: 2, minor: 17 }
  }
]

export function relayRuntimeLadder(runtime: SshRemoteRuntime): readonly RelayRuntimeStep[] {
  // Why no legacy rung: a host npm install needs a compiler or network the ladder exists to avoid.
  return runtime === 'pinned-node' ? ['A', 'B', 'C', 'D'] : ['legacy']
}

export function compatRelayRuntimeFor(
  facts: { target: ServerTarget; glibc: GlibcVersion | null },
  catalog: readonly CompatRelayRuntime[] = COMPAT_RELAY_RUNTIMES
): CompatRelayRuntime | null {
  return (
    catalog.find(
      (runtime) =>
        runtime.hostTarget === facts.target &&
        (runtime.glibcFloor === null ||
          (facts.glibc !== null && !isGlibcBelow(facts.glibc, runtime.glibcFloor)))
    ) ?? null
  )
}

/**
 * Rung B runs only where A cannot: glibc below A's floor, or A refused for a missing or too-old
 * library, which the compat build's static libstdc++ and older glibc floor can answer.
 */
export function rungBCompatRuntimeFor(
  facts: { target: ServerTarget; glibc: GlibcVersion | null },
  rungARefusal: RelayRuntimeFallbackReason | null,
  catalog: readonly CompatRelayRuntime[] = COMPAT_RELAY_RUNTIMES
): CompatRelayRuntime | null {
  const belowPinnedFloor =
    facts.glibc !== null && isGlibcBelow(facts.glibc, PINNED_NODE_GLIBC_FLOOR)
  if (!belowPinnedFloor && rungARefusal !== 'libc_floor' && rungARefusal !== 'missing_lib') {
    return null
  }
  return compatRelayRuntimeFor(facts, catalog)
}

/**
 * The pinned runtime Orca can run on a host by glibc alone: the default one, a compat one below
 * its floor, or null when neither can. Companions (the vault reader) use it to skip an upload
 * whose self-test could only fail.
 */
export function pinnedRuntimeTargetForHost(
  facts: { target: ServerTarget; glibc: GlibcVersion | null },
  catalog: readonly CompatRelayRuntime[] = COMPAT_RELAY_RUNTIMES
): NodeRuntimeTarget | null {
  if (facts.glibc === null || !isGlibcBelow(facts.glibc, PINNED_NODE_GLIBC_FLOOR)) {
    return facts.target
  }
  return compatRelayRuntimeFor(facts, catalog)?.runtimeTarget ?? null
}

/**
 * executableSha256 of every runtime a relay on `target` keeps pinned in the host store: the
 * default runtime and its compat ones, so a rung A connect never collects the rung B runtime.
 */
export function relayRuntimeStorePins(
  target: NodeRuntimeTarget,
  catalog: readonly CompatRelayRuntime[] = COMPAT_RELAY_RUNTIMES
): string[] {
  const hostTarget = isCompatServerTarget(target) ? COMPAT_SERVER_TARGET_BASES[target] : target
  const targets = [
    hostTarget,
    ...catalog
      .filter((runtime) => runtime.hostTarget === hostTarget)
      .map((runtime) => runtime.runtimeTarget)
  ]
  return [...new Set(targets.map((pin) => pinnedNodeRuntimeAsset(pin).executableSha256))]
}

/** Why a rung could not run; the refusal classes plus reasons found before anything ran. */
export type RelayRuntimeStepReason = RelayRuntimeFallbackReason

/**
 * noexec defeats every rung, because each loads addons from the same `~/.orca-remote` tree.
 * A remembered refusal only skips its own rung: the mount may have changed since it was proved.
 */
export function nextRelayRuntimeStep(
  ladder: readonly RelayRuntimeStep[],
  current: RelayRuntimeStep,
  reason: RelayRuntimeStepReason,
  remembered = false
): RelayRuntimeStep {
  if (reason === 'noexec' && !remembered) {
    return 'D'
  }
  const index = ladder.indexOf(current)
  return ladder[index + 1] ?? 'D'
}

/** What a ladder pass knows beyond the refusal it is stepping past. */
export type RelayRuntimeStepContext = {
  hostOs: RemoteOperatingSystem | null
  /** A rung was refused because this client lacked Orca's artifacts, which says nothing of the host. */
  clientArtifactGap: boolean
}

/**
 * `nextRelayRuntimeStep`, except where D would strand a host the ladder never judged: Windows,
 * where B and C don't exist yet, and a client missing Orca's artifacts. Both keep the host-Node
 * route they had before the ladder, marked unsupported. A proved noexec or missing host Node
 * still lands on D, as does a host-Node fallback that finds no Node.
 */
export function relayRuntimeStepAfterRefusal(
  ladder: readonly RelayRuntimeStep[],
  current: RelayRuntimeStep,
  reason: RelayRuntimeStepReason,
  remembered: boolean,
  context: RelayRuntimeStepContext
): RelayRuntimeStep {
  if (context.hostOs === 'win32') {
    return 'legacy'
  }
  const next = nextRelayRuntimeStep(ladder, current, reason, remembered)
  // Why not after host_node_missing: rung C already proved the host has no Node to fall back to.
  if (
    next === 'D' &&
    context.clientArtifactGap &&
    reason !== 'noexec' &&
    reason !== 'host_node_missing'
  ) {
    return 'legacy'
  }
  return next
}

/** The machine-readable part of a rung D failure; the message is what the user reads. */
export const REMOTE_RUNTIME_UNAVAILABLE_REASONS = ['home_noexec', 'no_runtime'] as const
export type RemoteRuntimeUnavailableReason = (typeof REMOTE_RUNTIME_UNAVAILABLE_REASONS)[number]

/** A noexec seen anywhere in the pass, remembered or proved, rules out advising a host Node. */
export function remoteRuntimeUnavailableReason(
  lastReason: RelayRuntimeStepReason | null,
  noexecSeen = false,
  hostOs: RemoteOperatingSystem | null = null
): RemoteRuntimeUnavailableReason {
  // Why not on Windows: its 'noexec' is an application-control block, not a mount the user can fix.
  if (hostOs === 'win32') {
    return 'no_runtime'
  }
  return lastReason === 'noexec' || noexecSeen ? 'home_noexec' : 'no_runtime'
}

const REMOTE_RUNTIME_UNAVAILABLE_MESSAGES: Record<RemoteRuntimeUnavailableReason, string> = {
  home_noexec:
    "Orca can't run its remote runtime on this host: the home directory is mounted noexec, so " +
    'nothing under ~/.orca-remote may execute. Remote terminals and file browsing are ' +
    'unavailable until an administrator allows exec there.',
  no_runtime:
    "Orca can't run its remote runtime on this host: its bundled Node.js was refused and no " +
    'Node.js 18 or newer was found on the host. Install Node.js 18+ on the host, then reconnect.'
}

// Why its own wording: a host Node would load addons from the same noexec tree, so installing one cannot help.
const REMEMBERED_NOEXEC_MESSAGE =
  "Orca can't run its remote runtime on this host: an earlier connect found the home directory " +
  'mounted noexec, so nothing under ~/.orca-remote may execute. Remote terminals and file ' +
  'browsing are unavailable until exec is allowed there; Orca re-checks on the next connect.'

// Why its own wording: the host's Node ran but refused the prebuilt addons, so only the unsupported npm path is left.
const HOST_NODE_REFUSED_MESSAGE =
  "Orca can't run its remote runtime on this host: its bundled Node.js was refused and the " +
  "host's Node.js can't load Orca's prebuilt addons. Host Node, which builds them with npm on " +
  "the host, is an unsupported configuration; to opt in anyway, set this host's Runtime to Host " +
  'Node in its SSH settings, then reconnect.'

// Why no Host Node advice: the refusal was Orca's own (a download or a host it can't classify), not the host's Node.
const NO_SUPPORTED_RUNTIME_MESSAGE =
  "Orca can't run its remote runtime on this host: its bundled Node.js was refused and no other " +
  'supported runtime could start. Reconnect to retry.'

// Why Host Node here: Windows has no rung below A yet, so the host-Node route is the only other one.
const WINDOWS_HOST_MESSAGE =
  "Orca can't run its remote runtime on this Windows host: its bundled Node.js was refused, which " +
  'can mean security software or an application control policy blocks it. Host Node, which ' +
  "builds terminal support with npm on the host, is an unsupported configuration; to opt in, set this host's " +
  'Runtime to Host Node in its SSH settings, then reconnect.'

const WINDOWS_NO_HOST_NODE_MESSAGE =
  "Orca can't run its remote runtime on this Windows host: its bundled Node.js could not run, " +
  'and no Node.js 18 or newer with npm was found on the host to run on instead. Allow ' +
  "Orca's Node.js through security software or application control, or install Node.js 18+ " +
  'on the host, then reconnect.'

// Why its own wording: the bundled Node never reached the host, so nothing about the host refused it.
const CLIENT_ARTIFACTS_NO_HOST_NODE_MESSAGE =
  "Orca can't run its remote runtime on this host: this copy of Orca could not prepare its bundled " +
  'Node.js, and no Node.js 18 or newer was found on the host to run on instead. Install Node.js ' +
  '18+ and npm on the host, or reconnect once Orca can fetch its runtime.'

export function remoteRuntimeUnavailableMessage(
  reason: RemoteRuntimeUnavailableReason,
  refusal: RelayRuntimeStepReason | null,
  noexecRemembered = false,
  /** Rung C's refusal: the last rung before D. */
  hostNodeRefusal: RelayRuntimeStepReason | null = null,
  hostOs: RemoteOperatingSystem | null = null
): string {
  if (refusal === 'artifacts_unavailable' && hostNodeRefusal === 'host_node_missing') {
    return `${CLIENT_ARTIFACTS_NO_HOST_NODE_MESSAGE} (Orca's Node: ${refusal})`
  }
  if (hostOs === 'win32') {
    const base =
      hostNodeRefusal === 'host_node_missing' ? WINDOWS_NO_HOST_NODE_MESSAGE : WINDOWS_HOST_MESSAGE
    return `${base} (Orca's Node: ${refusal ?? 'none'})`
  }
  if (reason === 'home_noexec') {
    return noexecRemembered
      ? REMEMBERED_NOEXEC_MESSAGE
      : REMOTE_RUNTIME_UNAVAILABLE_MESSAGES.home_noexec
  }
  if (hostNodeRefusal && hostNodeRefusal !== 'host_node_missing') {
    // Only a refusal the host's Node itself answered could change under an npm build on the host.
    const base = isPinnedRuntimeRefusal(hostNodeRefusal)
      ? HOST_NODE_REFUSED_MESSAGE
      : NO_SUPPORTED_RUNTIME_MESSAGE
    return `${base} (Orca's Node: ${refusal ?? 'none'}; host Node: ${hostNodeRefusal})`
  }
  const base = REMOTE_RUNTIME_UNAVAILABLE_MESSAGES[reason]
  return refusal ? `${base} (Orca's Node: ${refusal})` : base
}
