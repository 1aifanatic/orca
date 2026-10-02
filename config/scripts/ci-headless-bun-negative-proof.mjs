import assert from 'node:assert/strict'

export function ownedIdentityMatches(expected, current, actualToken, expectedToken) {
  return Boolean(
    expected &&
    current &&
    Number.isSafeInteger(expected.pid) &&
    expected.pid > 1 &&
    typeof expected.started === 'string' &&
    /^[0-9]+$/.test(expected.started) &&
    typeof expectedToken === 'string' &&
    expectedToken.length > 0 &&
    expected.pid === current.pid &&
    expected.started === current.started &&
    !['Z', 'X'].includes(current.state) &&
    actualToken === expectedToken
  )
}

function hostedVerdict(evidence, hosted, conclusion) {
  assert.equal(evidence.identity.arch, 'x64')
  assert.equal(evidence.identity.platform, 'linux')
  assert.equal(hosted.runner, 'ubuntu-22.04')
  assert.equal(hosted.runId, evidence.identity.runId)
  assert.equal(hosted.headSha, evidence.identity.sourceSha)
  assert.deepEqual(evidence.errors, [])
  assert.equal(hosted.runConclusion, conclusion)
  assert.equal(hosted.jobConclusion, conclusion)
  assert.deepEqual(hosted.consumers, {
    sentinel: 'skipped',
    artifact: 'skipped',
    node18: 'skipped'
  })
}

export function qualifyFailure(evidence, hosted) {
  assert(['bun-failure', 'node-failure'].includes(evidence.control))
  hostedVerdict(evidence, hosted, 'failure')
  assert.equal(hosted.nativeWait, evidence.control === 'bun-failure' ? 'failure' : 'success')
  assert.equal(evidence.inputsRestored, true)
  assert.equal(evidence.forbiddenConsumer, false)
  assert.equal(evidence.cleanup.verifiedExited, true)
  assert.equal(evidence.cleanup.cleanBefore, true)
  assert.deepEqual(evidence.cleanup.leaked, [])
  assert.equal(evidence.fault.relativePath, 'src/main/orcad/main.ts')
  assert.equal(evidence.fault.phase, evidence.control === 'bun-failure' ? 'bun' : 'node')
  assert.match(evidence.fault.originalSha, /^[a-f0-9]{64}$/)
  assert.match(evidence.fault.faultSha, /^[a-f0-9]{64}$/)
  assert.notEqual(evidence.fault.faultSha, evidence.fault.originalSha)
  assert.equal(evidence.fault.restoredSha, evidence.fault.originalSha)
  assert(Number.isSafeInteger(evidence.failure.status) && evidence.failure.status > 0)
  assert.equal(evidence.parts[evidence.fault.phase].status, evidence.failure.status)
  assert.equal(evidence.parts[evidence.fault.phase === 'bun' ? 'node' : 'bun'].status, 0)
  assert.equal(evidence.failure.compilerDiagnostic, true)
  assert.equal(evidence.failure.faultShaAtFailure, evidence.fault.faultSha)
  assert.equal(evidence.failure.opposite.phase, evidence.fault.phase === 'bun' ? 'node' : 'bun')
  assert.equal(evidence.failure.opposite.liveAtFrontier, true)
  assert.equal(evidence.failure.opposite.token, evidence.token)
  assert(
    ownedIdentityMatches(
      evidence.failure.opposite.identity,
      evidence.failure.opposite.freshIdentity,
      evidence.failure.opposite.token,
      evidence.token
    )
  )
  assert.equal(
    evidence.failure.opposite.identity.started,
    evidence.failure.opposite.freshIdentity.started
  )
  assert.equal(evidence.failure.opposite.identity.pid, evidence.failure.opposite.freshIdentity.pid)
  assert(evidence.failure.opposite.command.length > 1)
  return {
    qualified: true,
    control: evidence.control,
    scope: 'Linux x64 native failure and gated consumers'
  }
}

export function qualifyCancellation(evidence, hosted) {
  assert.equal(evidence.control, 'cancel')
  hostedVerdict(evidence, hosted, 'cancelled')
  assert.equal(evidence.forbiddenConsumer, false)
  assert.equal(evidence.inputsRestored, true)
  assert(['SIGINT', 'SIGTERM'].includes(evidence.termination.signal))
  assert.equal(evidence.termination.token, evidence.token)
  assert.equal(evidence.readiness.token, evidence.token)
  assert.equal(evidence.readiness.detached.liveAtReadiness, true)
  assert.equal(evidence.readiness.node.liveAtReadiness, true)
  assert.equal(evidence.readiness.bun.liveAtReadiness, true)
  for (const phase of ['node', 'bun', 'detached']) {
    const proof = evidence.readiness[phase]
    assert(ownedIdentityMatches(proof.identity, proof.freshIdentity, proof.token, evidence.token))
    const reported = evidence.reporterReadiness[phase]
    assert.equal(reported.liveAtReadiness, true)
    assert(
      ownedIdentityMatches(
        reported.identity,
        reported.freshIdentity,
        reported.token,
        evidence.token
      )
    )
  }
  assert.equal(evidence.observerStopped.cancelled, true)
  assert.equal(evidence.cancelCleanup.verifiedExited, true)
  assert.equal(evidence.freshCleanup.verifiedExited, true)
  assert.equal(evidence.freshCleanup.cleanBefore, true)
  assert.deepEqual(evidence.freshCleanup.leaked, [])
  assert(evidence.freshExits.length > 0)
  assert(evidence.freshExits.every((record) => record.verdict === 'exited'))
  const detached = evidence.readiness.detached.identity
  assert(
    evidence.freshExits.some(
      (record) =>
        record.identity.pid === detached.pid && record.identity.started === detached.started
    )
  )
  assert.equal(typeof evidence.buildersLiveAtTermination.node, 'boolean')
  assert.equal(typeof evidence.buildersLiveAtTermination.bun, 'boolean')
  for (const phase of ['node', 'bun']) {
    const proof = evidence.buildersAtTermination[phase]
    assert.equal(evidence.buildersLiveAtTermination[phase], Boolean(proof))
    if (proof) {
      assert.equal(proof.phase, phase)
      assert(ownedIdentityMatches(proof.identity, proof.freshIdentity, proof.token, evidence.token))
      assert(Array.isArray(proof.command) && proof.command.length > 1)
    }
  }
  assert(
    ['success', 'failure', 'cancelled', 'skipped'].includes(hosted.nativeWait),
    'Missing cancellation native wait disposition'
  )
  assert.equal(hosted.readinessReporter, 'success')
  const relay = evidence.signalRelay.identity
  const excluded = evidence.signalRelayExclusion
  assert.equal(excluded.identity.pid, relay.pid)
  assert.equal(excluded.identity.started, relay.started)
  assert.equal(excluded.liveAtExclusion, true)
  assert(
    ownedIdentityMatches(excluded.identity, excluded.freshIdentity, excluded.token, evidence.token)
  )
  assert(
    evidence.freshExits.some(
      (record) =>
        record.identity.pid === relay.pid &&
        record.identity.started === relay.started &&
        record.verdict === 'exited'
    )
  )
  return {
    qualified: true,
    control: 'cancel',
    scope: 'Linux x64 normal GH cancellation and owned detached child',
    adoptionReady: evidence.buildersLiveAtTermination.bun,
    partialLiveBuildCoverage: !evidence.buildersLiveAtTermination.bun,
    liveBunPreparationCancellationProven: evidence.buildersLiveAtTermination.bun,
    anyLivePreparationCancellationProven:
      evidence.buildersLiveAtTermination.node || evidence.buildersLiveAtTermination.bun
  }
}
