/**
 * The ladder's invariant, per host class: the connect is never worse than the pre-ladder default
 * (the host-Node relay, `legacy`), and never compiles on a host where Orca's own runtime works.
 * Drives the real step function the deploy loop uses; each rung's answer is scripted per host.
 */
import { describe, expect, it } from 'vitest'
import type { RemoteOperatingSystem } from './ssh-remote-platform'
import {
  relayRuntimeLadder,
  relayRuntimeStepAfterRefusal,
  type RelayRuntimeStep,
  type RelayRuntimeStepReason
} from './ssh-relay-runtime-ladder'

/** What a rung's attempt ends in: it launches, refuses for a reason, or never gets an answer. */
type RungAnswer = 'launch' | 'unanswered' | RelayRuntimeStepReason
/** What the host-Node relay does: launch, prove no Node, fail its npm build, or go unanswered. */
type HostNodeAnswer = 'launch' | 'no_node' | 'build_fails' | 'unanswered'

type HostClass = {
  id: string
  os: RemoteOperatingSystem
  rungs: Partial<Record<'A' | 'B' | 'C', RungAnswer>>
  hostNode: HostNodeAnswer
}

type Outcome =
  | { kind: 'relay'; rung: RelayRuntimeStep }
  | { kind: 'plain_ssh' }
  | { kind: 'failed'; retryable: boolean }

const RANK: Record<Outcome['kind'], number> = { relay: 2, plain_ssh: 1, failed: 0 }

function hostNodeOutcome(answer: HostNodeAnswer): Outcome | 'no_node' {
  switch (answer) {
    case 'launch':
      return { kind: 'relay', rung: 'legacy' }
    case 'no_node':
      return 'no_node'
    case 'build_fails':
      return { kind: 'failed', retryable: false }
    case 'unanswered':
      return { kind: 'failed', retryable: true }
  }
}

/** Before the ladder: every connect ran the host-Node relay, and "no Node" failed the connect. */
function baseOutcome(host: HostClass): Outcome {
  const outcome = hostNodeOutcome(host.hostNode)
  return outcome === 'no_node' ? { kind: 'failed', retryable: false } : outcome
}

/** The deploy loop: refusals step on; anything unanswered fails retryably on that rung. */
function ladderOutcome(host: HostClass): Outcome {
  const ladder = relayRuntimeLadder('pinned-node')
  let step: RelayRuntimeStep = ladder[0]!
  for (let guard = 0; guard < 10; guard++) {
    if (step === 'D') {
      return { kind: 'plain_ssh' }
    }
    let answer: RungAnswer
    if (step === 'legacy') {
      const outcome = hostNodeOutcome(host.hostNode)
      if (outcome !== 'no_node') {
        return outcome
      }
      answer = 'host_node_missing'
    } else {
      answer =
        host.rungs[step] ??
        (host.os === 'win32' && step === 'C' ? 'windows_host_unsupported' : 'runtime_unavailable')
    }
    if (answer === 'launch') {
      return { kind: 'relay', rung: step }
    }
    if (answer === 'unanswered') {
      return { kind: 'failed', retryable: true }
    }
    step = relayRuntimeStepAfterRefusal(ladder, step, answer, false, { hostOs: host.os })
  }
  throw new Error(`ladder did not settle for ${host.id}`)
}

const HOSTS: readonly HostClass[] = [
  { id: 'posix-with-compiler', os: 'linux', rungs: { A: 'launch' }, hostNode: 'launch' },
  { id: 'posix-node-no-compiler', os: 'linux', rungs: { A: 'launch' }, hostNode: 'build_fails' },
  { id: 'posix-no-node', os: 'linux', rungs: { A: 'launch' }, hostNode: 'no_node' },
  {
    id: 'offline-client-host-node',
    os: 'linux',
    rungs: { A: 'artifacts_unavailable', C: 'launch' },
    hostNode: 'launch'
  },
  {
    id: 'offline-client-no-host-node',
    os: 'linux',
    rungs: { A: 'artifacts_unavailable', C: 'host_node_missing' },
    hostNode: 'no_node'
  },
  {
    id: 'missing-template-host-node',
    os: 'linux',
    rungs: { A: 'artifacts_unavailable', C: 'artifacts_unavailable' },
    hostNode: 'launch'
  },
  {
    id: 'missing-template-no-host-node',
    os: 'linux',
    rungs: { A: 'artifacts_unavailable', C: 'artifacts_unavailable' },
    hostNode: 'no_node'
  },
  {
    id: 'glibc-2.17',
    os: 'linux',
    rungs: { A: 'libc_floor', B: 'launch' },
    hostNode: 'build_fails'
  },
  { id: 'musl', os: 'linux', rungs: { A: 'launch' }, hostNode: 'launch' },
  {
    id: 'musl-no-libstdcxx',
    os: 'linux',
    rungs: { A: 'missing_lib', C: 'host_node_missing' },
    hostNode: 'no_node'
  },
  {
    id: 'unidentified-libc',
    os: 'linux',
    rungs: { A: 'target_unresolved', B: 'target_unresolved', C: 'target_unresolved' },
    hostNode: 'launch'
  },
  {
    // C's N-API floor can refuse a Node 18 the host-npm relay still builds against.
    id: 'host-node-below-addon-napi',
    os: 'linux',
    rungs: { A: 'missing_lib', C: 'host_node_missing' },
    hostNode: 'launch'
  },
  { id: 'nixos', os: 'linux', rungs: { A: 'wrong_libc', C: 'launch' }, hostNode: 'launch' },
  {
    // The host-npm relay loads its addons from the same noexec tree, so it never ran here.
    id: 'noexec-home',
    os: 'linux',
    rungs: { A: 'noexec' },
    hostNode: 'build_fails'
  },
  { id: 'windows-with-node', os: 'win32', rungs: { A: 'launch' }, hostNode: 'launch' },
  { id: 'windows-without-node', os: 'win32', rungs: { A: 'launch' }, hostNode: 'no_node' },
  {
    id: 'windows-av-blocked-with-node',
    os: 'win32',
    rungs: { A: 'security_software' },
    hostNode: 'launch'
  },
  {
    id: 'windows-av-blocked-without-node',
    os: 'win32',
    rungs: { A: 'security_software' },
    hostNode: 'no_node'
  },
  {
    id: 'windows-applocker-with-node',
    os: 'win32',
    rungs: { A: 'noexec' },
    hostNode: 'launch'
  },
  {
    id: 'windows-offline-client-with-node',
    os: 'win32',
    rungs: { A: 'artifacts_unavailable' },
    hostNode: 'launch'
  },
  {
    // MaxSessions refuses the fallback's probe channel: never proof of "no Node".
    id: 'channel-open-failure',
    os: 'win32',
    rungs: { A: 'security_software' },
    hostNode: 'unanswered'
  },
  {
    id: 'channel-open-failure-at-a',
    os: 'linux',
    rungs: { A: 'unanswered' },
    hostNode: 'unanswered'
  }
]

describe('relay runtime ladder vs the pre-ladder host-Node default', () => {
  it.each(HOSTS)('$id is never worse than before the ladder', (host) => {
    const base = baseOutcome(host)
    const ladder = ladderOutcome(host)
    expect(RANK[ladder.kind]).toBeGreaterThanOrEqual(RANK[base.kind])
    if (ladder.kind === 'failed' && host.hostNode === 'unanswered') {
      // An unanswered probe stays retryable rather than read as a verdict.
      expect(ladder.retryable).toBe(true)
    }
  })

  it.each(HOSTS.filter((host) => Object.values(host.rungs).includes('launch')))(
    '$id never compiles on the host where an Orca runtime rung runs',
    (host) => {
      expect(ladderOutcome(host)).toMatchObject({ kind: 'relay' })
      expect(ladderOutcome(host)).not.toMatchObject({ rung: 'legacy' })
    }
  )

  it('lands on plain SSH only with proof the host-Node relay could not have run either', () => {
    const plain = HOSTS.filter((host) => ladderOutcome(host).kind === 'plain_ssh').map(
      (host) => host.id
    )
    expect(plain).toEqual([
      'offline-client-no-host-node',
      'missing-template-no-host-node',
      'musl-no-libstdcxx',
      'noexec-home',
      'windows-av-blocked-without-node'
    ])
  })
})
