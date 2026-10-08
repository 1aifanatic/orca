/**
 * The ladder's invariant: for every host, the connect is never worse than the pre-ladder default
 * (the host-Node relay, `legacy`), never compiles where Orca's own runtime runs, and lands on
 * plain SSH only when that default itself answered with a failure. Drives the real step function
 * the deploy loop uses over the cross-product of what each rung and the default can answer.
 */
import { describe, expect, it } from 'vitest'
import type { RemoteOperatingSystem } from './ssh-remote-platform'
import {
  relayRuntimeLadder,
  relayRuntimeStepAfterRefusal,
  type RelayRuntimeStep,
  type RelayRuntimeStepReason
} from './ssh-relay-runtime-ladder'

/** A rung either launches or answers with a refusal; transport loss is modelled separately. */
type RungAnswer = 'launch' | RelayRuntimeStepReason
/**
 * The host-Node relay: it launches, its strict probe answers "no Node", its npm install answers
 * with a failure, or its relay launch fails after starting (which propagates, as before).
 */
type HostNodeAnswer = 'launch' | 'no_node' | 'install_fails' | 'launch_fails'

type HostCase = {
  id: string
  os: RemoteOperatingSystem
  a: RungAnswer
  b: RungAnswer
  c: RungAnswer
  hostNode: HostNodeAnswer
  /** Every exec channel is refused or lost (MaxSessions, a dropped link): nothing answers. */
  transportDown?: boolean
}

type Outcome =
  | { kind: 'relay'; rung: RelayRuntimeStep }
  | { kind: 'plain_ssh' }
  | { kind: 'failed'; retryable: boolean }

const RANK: Record<Outcome['kind'], number> = { relay: 2, plain_ssh: 1, failed: 0 }

/** Before the ladder: every connect ran the host-Node relay, and any failure failed the connect. */
function baseOutcome(host: HostCase): Outcome {
  if (host.transportDown) {
    return { kind: 'failed', retryable: true }
  }
  return host.hostNode === 'launch'
    ? { kind: 'relay', rung: 'legacy' }
    : { kind: 'failed', retryable: false }
}

/** The deploy loop: answered refusals step on; a launch failure or lost transport propagates. */
function ladderOutcome(host: HostCase): Outcome {
  if (host.transportDown) {
    return { kind: 'failed', retryable: true }
  }
  const ladder = relayRuntimeLadder('pinned-node')
  let step: RelayRuntimeStep = ladder[0]!
  for (let guard = 0; guard < 10; guard++) {
    let answer: RungAnswer
    switch (step) {
      case 'D':
        return { kind: 'plain_ssh' }
      case 'legacy':
        if (host.hostNode === 'launch') {
          return { kind: 'relay', rung: 'legacy' }
        }
        if (host.hostNode === 'launch_fails') {
          return { kind: 'failed', retryable: false }
        }
        answer = host.hostNode === 'no_node' ? 'host_node_missing' : 'install_failed'
        break
      case 'A':
        answer = host.a
        break
      case 'B':
        answer = host.os === 'win32' ? 'runtime_unavailable' : host.b
        break
      case 'C':
        answer = host.os === 'win32' ? 'windows_host_unsupported' : host.c
        break
    }
    if (answer === 'launch') {
      return { kind: 'relay', rung: step }
    }
    step = relayRuntimeStepAfterRefusal(ladder, step, answer, false)
  }
  throw new Error(`ladder did not settle for ${host.id}`)
}

const A_ANSWERS: readonly RungAnswer[] = [
  'launch',
  'noexec',
  'missing_lib',
  'libc_floor',
  'illegal_instruction',
  'wrong_libc',
  'security_software',
  'target_unresolved',
  'artifacts_unavailable',
  'install_failed'
]
const B_ANSWERS: readonly RungAnswer[] = ['launch', 'runtime_unavailable', 'install_failed']
const C_ANSWERS: readonly RungAnswer[] = [
  'launch',
  'host_node_missing',
  'noexec',
  'libc_floor',
  'artifacts_unavailable',
  'target_unresolved',
  'install_failed'
]
const HOST_NODE_ANSWERS: readonly HostNodeAnswer[] = [
  'launch',
  'no_node',
  'install_fails',
  'launch_fails'
]
const OSES: readonly RemoteOperatingSystem[] = ['linux', 'win32']

const CROSS_PRODUCT: HostCase[] = OSES.flatMap((os) =>
  A_ANSWERS.flatMap((a) =>
    B_ANSWERS.flatMap((b) =>
      C_ANSWERS.flatMap((c) =>
        HOST_NODE_ANSWERS.map((hostNode) => ({
          id: `${os} A:${a} B:${b} C:${c} host:${hostNode}`,
          os,
          a,
          b,
          c,
          hostNode
        }))
      )
    )
  )
)

/** Named host classes from review, kept readable alongside the cross-product. */
const NAMED: readonly HostCase[] = [
  {
    id: 'A install fails on ENOSPC, host Node works',
    os: 'linux',
    a: 'install_failed',
    b: 'runtime_unavailable',
    c: 'host_node_missing',
    hostNode: 'launch'
  },
  {
    // AppArmor denies uploaded binaries (exit 126) but allows /usr/bin/node.
    id: 'executable-only denial, host Node works',
    os: 'linux',
    a: 'noexec',
    b: 'runtime_unavailable',
    c: 'noexec',
    hostNode: 'launch'
  },
  {
    id: 'noexec home, host Node relay launches',
    os: 'linux',
    a: 'noexec',
    b: 'runtime_unavailable',
    c: 'noexec',
    hostNode: 'launch'
  },
  {
    id: 'noexec home, host Node relay cannot load its addons',
    os: 'linux',
    a: 'noexec',
    b: 'runtime_unavailable',
    c: 'noexec',
    hostNode: 'install_fails'
  },
  {
    // The warm check runs the cached runtime, so this is a refusal before launch, not a hung relay.
    id: 'cached runtime lost a library between connects',
    os: 'linux',
    a: 'missing_lib',
    b: 'runtime_unavailable',
    c: 'host_node_missing',
    hostNode: 'launch'
  },
  {
    id: 'cached runtime now denied by exec policy',
    os: 'linux',
    a: 'noexec',
    b: 'runtime_unavailable',
    c: 'noexec',
    hostNode: 'launch'
  },
  {
    // System-ssh upload: the remote tar's exit 2 is typed evidence, so it steps down.
    id: 'system-ssh upload hits ENOSPC',
    os: 'linux',
    a: 'install_failed',
    b: 'runtime_unavailable',
    c: 'install_failed',
    hostNode: 'launch'
  },
  {
    id: 'Windows system sftp refuses the runtime upload',
    os: 'win32',
    a: 'install_failed',
    b: 'runtime_unavailable',
    c: 'windows_host_unsupported',
    hostNode: 'launch'
  },
  {
    id: 'unidentified libc',
    os: 'linux',
    a: 'target_unresolved',
    b: 'target_unresolved',
    c: 'target_unresolved',
    hostNode: 'launch'
  },
  {
    id: 'Windows blocked by antivirus, no Node',
    os: 'win32',
    a: 'security_software',
    b: 'runtime_unavailable',
    c: 'windows_host_unsupported',
    hostNode: 'no_node'
  },
  {
    id: 'channel-open failure (MaxSessions) on every exec',
    os: 'win32',
    a: 'launch',
    b: 'runtime_unavailable',
    c: 'windows_host_unsupported',
    hostNode: 'launch',
    transportDown: true
  }
]

function violations(host: HostCase): string[] {
  const base = baseOutcome(host)
  const ladder = ladderOutcome(host)
  const found: string[] = []
  if (RANK[ladder.kind] < RANK[base.kind]) {
    found.push(`${host.id}: ${ladder.kind} is worse than base ${base.kind}`)
  }
  if (
    !host.transportDown &&
    host.a === 'launch' &&
    ladder.kind === 'relay' &&
    ladder.rung !== 'A'
  ) {
    found.push(`${host.id}: compiled on the host though rung A runs`)
  }
  // D only when the host-Node default itself answered with a failure.
  if (ladder.kind === 'plain_ssh' && !['no_node', 'install_fails'].includes(host.hostNode)) {
    found.push(`${host.id}: plain SSH without the default failing`)
  }
  if (host.transportDown && !(ladder.kind === 'failed' && ladder.retryable)) {
    found.push(`${host.id}: a lost transport became a verdict`)
  }
  return found
}

describe('relay runtime ladder vs the pre-ladder host-Node default', () => {
  it(`is never worse across all ${CROSS_PRODUCT.length} host combinations`, () => {
    expect(CROSS_PRODUCT.flatMap(violations)).toEqual([])
  })

  it.each(NAMED)('$id is never worse', (host) => {
    expect(violations(host)).toEqual([])
  })

  it('gives a host whose default works that default, or better, after any ladder refusal', () => {
    const fallbacks = CROSS_PRODUCT.filter(
      (host) => host.a !== 'launch' && host.hostNode === 'launch'
    ).map(ladderOutcome)
    expect(fallbacks.every((outcome) => outcome.kind === 'relay')).toBe(true)
  })
})
