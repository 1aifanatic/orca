// Pure pieces of the director deploy driver: the exact inputs each existing workflow receives,
// and the parsers that read a run's result back. No process, network, or clock access here.

import {
  RELAY_GITHUB_REPOSITORY,
  RELAY_WORKFLOW_FILE_PREFIX,
  relayWorkflowFile
} from './relay-repository.mjs'

export const REPOSITORY = RELAY_GITHUB_REPOSITORY
export const WORKFLOW_REF = 'main'
export const PROJECT = 'onorca-cloud'
export const REGION = 'us-central1'
export const DIRECTOR_SERVICE = 'orca-cloud-relay'
export const ROLLBACK_TAG = 'selector-rollback'
export const IMAGE_REPOSITORY = 'us-central1-docker.pkg.dev/onorca-cloud/orca-cloud/relay'
// Any reviewed registration wave is accepted by admission inspect; the launch wave never changes.
const ADMISSION_INSPECT_CELLS = 'production-gce-c27,production-gce-c28,production-gce-c29'

export const WORKFLOWS = {
  publish: {
    file: relayWorkflowFile('publish-relay-production.yml'),
    name: 'Publish Relay Production Image'
  },
  director: {
    file: relayWorkflowFile('deploy-relay-production-director.yml'),
    name: 'Deploy Relay Production Director'
  },
  rehome: {
    file: relayWorkflowFile('operate-relay-production-rehome.yml'),
    name: 'Operate Relay Production Rehome'
  },
  admission: {
    file: relayWorkflowFile('operate-relay-asia-admission.yml'),
    name: 'Operate Relay Asia Admission'
  },
  monitor: {
    file: relayWorkflowFile('monitor-relay-production.yml'),
    name: 'Monitor Relay Production'
  }
}

// Read-only or unrelated to the production rollout lane, so they never block a deploy.
const NON_BLOCKING_WORKFLOWS = new Set(
  ['verify.yml', 'monitor-relay-clock-skew.yml'].map(relayWorkflowFile)
)

const DIGEST = /^sha256:[a-f0-9]{64}$/
const COMMIT = /^[a-f0-9]{40}$/
const PRODUCTION_CELL = /^production-gce-c[1-9][0-9]?$/
const MEMBERSHIP_KEYS = ['existingOnly', 'migrationOnly', 'general']

export function requireDigest(value, label) {
  if (typeof value !== 'string' || !DIGEST.test(value))
    throw new Error(`${label} is not an immutable sha256 digest`)
  return value
}

export function requireCommit(value, label) {
  if (typeof value !== 'string' || !COMMIT.test(value))
    throw new Error(`${label} is not a full commit SHA`)
  return value
}

function requireGeneration(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is invalid`)
  return value
}

export function blocksDeploy(path) {
  const file = String(path ?? '')
    .split('/')
    .at(-1)
  return (
    file.startsWith(RELAY_WORKFLOW_FILE_PREFIX) &&
    file.endsWith('.yml') &&
    !NON_BLOCKING_WORKFLOWS.has(file)
  )
}

export function membershipInput(cells) {
  return cells.length === 0 ? 'none' : [...cells].sort().join(',')
}

export function parseSelector(value, label) {
  const selector = {
    generation: requireGeneration(value?.generation, `${label} generation`),
    membership: {}
  }
  for (const key of MEMBERSHIP_KEYS) {
    const cells = value?.membership?.[key]
    if (!Array.isArray(cells) || cells.some((cell) => !PRODUCTION_CELL.test(cell))) {
      throw new Error(`${label} ${key} membership is invalid`)
    }
    selector.membership[key] = [...cells].sort()
  }
  const all = MEMBERSHIP_KEYS.flatMap((key) => selector.membership[key])
  if (new Set(all).size !== all.length) throw new Error(`${label} membership has duplicates`)
  return selector
}

export function sameSelector(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

function selectorInputs(selector) {
  return {
    'expected-selector-generation': String(selector.generation),
    'expected-existing-only-cells': membershipInput(selector.membership.existingOnly),
    'expected-migration-only-cells': membershipInput(selector.membership.migrationOnly),
    'expected-general-cells': membershipInput(selector.membership.general)
  }
}

export function parseControl(value, label) {
  const control = value ?? {}
  const integers = [
    'generation',
    'notBefore',
    'ratePerMinute',
    'preferenceMaxAgeMs',
    'drainGraceMs'
  ]
  if (
    typeof control.enabled !== 'boolean' ||
    integers.some((key) => !Number.isSafeInteger(control[key]))
  ) {
    throw new Error(`${label} is not a complete regional rehome control`)
  }
  if (control.hostCooldownMs !== undefined && !Number.isSafeInteger(control.hostCooldownMs)) {
    throw new Error(`${label} host cooldown is invalid`)
  }
  return {
    generation: control.generation,
    enabled: control.enabled,
    notBefore: control.notBefore,
    ratePerMinute: control.ratePerMinute,
    preferenceMaxAgeMs: control.preferenceMaxAgeMs,
    hostCooldownMs: control.hostCooldownMs,
    drainGraceMs: control.drainGraceMs
  }
}

const INTEGER_INPUT = /^(0|[1-9][0-9]*)$/

/**
 * The last check before `gh workflow run`. Builders also render dry-run placeholders such as
 * `<published digest>`; this guarantees none of them, or a malformed digest, is ever dispatched.
 */
export function validateDispatchInputs(inputs) {
  for (const [key, value] of Object.entries(inputs)) {
    if (typeof value !== 'string' || value.startsWith('<'))
      throw new Error(`input ${key} is not resolved`)
    if (key.endsWith('digest') && !DIGEST.test(value))
      throw new Error(`input ${key} is not a sha256 digest`)
    if (
      (key.includes('generation') ||
        ['not-before', 'monitor-run-id', 'monitor-run-attempt'].includes(key)) &&
      !INTEGER_INPUT.test(value)
    ) {
      throw new Error(`input ${key} is not an integer`)
    }
  }
  return inputs
}

export function admissionInspectInputs(servingDigest) {
  return {
    environment: 'production',
    mode: 'inspect',
    'cell-ids': ADMISSION_INSPECT_CELLS,
    'image-digest': servingDigest
  }
}

function rehomeInputs(mode, { director, selector, controlGeneration }) {
  return {
    mode,
    'director-image-digest': director.servingDigest,
    'rollback-image-digest': director.rollbackDigest,
    ...selectorInputs(selector),
    'expected-control-generation': String(controlGeneration)
  }
}

export function rehomeInspectInputs(context) {
  return rehomeInputs('inspect', context)
}

// Pause keeps every durable field as inspected; only `enabled` and the generation change.
export function rehomePauseInputs({ director, selector, control }) {
  return {
    ...rehomeInputs('pause', { director, selector, controlGeneration: control.generation }),
    'not-before': String(control.notBefore),
    'rate-per-minute': String(control.ratePerMinute),
    'preference-max-age-ms': String(control.preferenceMaxAgeMs),
    'host-cooldown-ms': String(control.hostCooldownMs ?? 604_800_000),
    'drain-grace-ms': String(control.drainGraceMs),
    confirmation: 'PAUSE_REGIONAL_REHOMING'
  }
}

export function rehomeEnableInputs({
  director,
  selector,
  control,
  controlGeneration,
  notBefore,
  monitor
}) {
  if (control.hostCooldownMs === undefined) {
    throw new Error(
      'the inspected control has no host cooldown; enable needs a director that reports it'
    )
  }
  return {
    ...rehomeInputs('enable', { director, selector, controlGeneration }),
    'not-before': String(notBefore),
    // The enable job accepts exactly 10 per minute.
    'rate-per-minute': '10',
    'preference-max-age-ms': String(control.preferenceMaxAgeMs),
    'host-cooldown-ms': String(control.hostCooldownMs),
    'drain-grace-ms': String(control.drainGraceMs),
    'monitor-run-id': String(monitor.runId),
    'monitor-run-attempt': String(monitor.attempt),
    confirmation: 'ENABLE_REGIONAL_REHOMING'
  }
}

export function publishInputs() {
  return { mode: 'publish' }
}

export function directorDeployInputs({ imageDigest, predecessorDigest, rehomeGeneration }) {
  return {
    'image-digest': imageDigest,
    'regional-placement-mode': 'preserve',
    'region-correction-cohort-percent': 'preserve',
    'prune-incompatible-revisions': 'false',
    'expected-rehome-generation': String(rehomeGeneration),
    'bootstrap-runtime-identity': 'false',
    // Required by the form even without the bootstrap; it is only format-checked then.
    'predecessor-image-digest': predecessorDigest
  }
}

export function configureInputs({ cells, cellImageDigest, directorDigest, selectorGeneration }) {
  return {
    environment: 'production',
    mode: 'configure',
    'cell-ids': cells.join(','),
    'selector-generation': String(selectorGeneration),
    'image-digest': cellImageDigest,
    'director-image-digest': directorDigest,
    confirmation: 'CONFIGURE_ASIA_DIRECTOR'
  }
}

export function monitorDryRunInputs(selector) {
  return {
    mode: 'dry-run',
    ...selectorInputs(selector),
    'migration-policy': 'strict',
    'recovery-source-cell-id': 'none',
    'capacity-cell-id': 'none'
  }
}

export function parseConfigureWave(value) {
  const separator = String(value).lastIndexOf('=')
  const cells = String(value)
    .slice(0, separator)
    .split(',')
    .map((cell) => cell.trim())
    .filter(Boolean)
  const cellImageDigest = String(value).slice(separator + 1)
  if (
    separator < 1 ||
    cells.length === 0 ||
    new Set(cells).size !== cells.length ||
    cells.some((cell) => !PRODUCTION_CELL.test(cell))
  ) {
    throw new Error('--configure must be <cell>[,<cell>...]=sha256:<cell image digest>')
  }
  return { cells, cellImageDigest: requireDigest(cellImageDigest, '--configure cell image digest') }
}

/** The single 100% revision and the selector-rollback revision of `gcloud run services describe`. */
export function directorRevisions(service) {
  const traffic = Array.isArray(service?.status?.traffic) ? service.status.traffic : []
  const serving = traffic.filter((entry) => (entry.percent ?? 0) > 0)
  const rollback = traffic.filter((entry) => entry.tag === ROLLBACK_TAG)
  if (serving.length !== 1 || serving[0].percent !== 100 || !serving[0].revisionName) {
    throw new Error('director does not serve one revision at 100%')
  }
  if (rollback.length !== 1 || !rollback[0].revisionName) {
    throw new Error(`director has no single ${ROLLBACK_TAG} revision`)
  }
  return { servingRevision: serving[0].revisionName, rollbackRevision: rollback[0].revisionName }
}

export function revisionDigest(revision, label) {
  const image = revision?.spec?.containers?.[0]?.image
  const [repository, digest] = String(image ?? '').split('@')
  if (repository !== IMAGE_REPOSITORY)
    throw new Error(`${label} does not run the production relay image`)
  return requireDigest(digest, `${label} image`)
}

/** The relay push line, `sha-<commit>: digest: sha256:… size: …`, must name the registry digest. */
export function logConfirmsPublishedDigest(log, commit, digest) {
  return String(log)
    .split('\n')
    .some((line) => line.includes(`sha-${commit}: digest: ${digest} size:`))
}

/** The last `relay_regional_rehome_control` JSON line the rehome job printed in `mode` (null: any). */
export function rehomeControlFromLog(log, mode) {
  let found
  for (const line of String(log).split('\n')) {
    const start = line.indexOf('{"event":"relay_regional_rehome_control"')
    if (start < 0) continue
    try {
      const parsed = JSON.parse(line.slice(start).trim())
      if (mode === null || parsed.mode === mode) found = parsed
    } catch {
      // A truncated or echoed line is not the result.
    }
  }
  if (!found)
    throw new Error(`the rehome run printed no ${mode ?? 'regional rehome'} control result`)
  return {
    control: parseControl(found.control, `rehome ${mode} control`),
    ...(found.selector
      ? { selector: parseSelector(found.selector, `rehome ${mode} selector`) }
      : {})
  }
}

export function admissionInspectResult(result) {
  if (result?.mode !== 'inspect') throw new Error('admission result is not an inspect')
  return parseSelector(result, 'admission selector')
}

/**
 * Reads the monitor's own verdict from its sealed state, the only place a freeze reason lives.
 * `ageMs` is measured against the caller's clock; the enable job allows 5 minutes in total.
 */
export function monitorVerdict(state, { runId, nowMs }) {
  const failures = Array.isArray(state?.failures) ? state.failures : null
  const completedAt = Date.parse(state?.completedAt ?? '')
  const reasons = []
  if (state?.schemaVersion !== 4) reasons.push('unknown state schema')
  if (state?.incidentId !== `relay-${runId}-dry-run`) reasons.push('state belongs to another run')
  if (state?.preDrainDryRun !== true || state?.migrationPolicy !== 'strict')
    reasons.push('not a strict dry-run')
  if (state?.frozenAt !== null) reasons.push(`frozen at ${state?.frozenAt}`)
  if (!failures || failures.length > 0) reasons.push('failures recorded')
  if (!(state?.sampleCount >= 16)) reasons.push(`only ${state?.sampleCount ?? 0} samples`)
  if (!Number.isFinite(completedAt)) reasons.push('not completed')
  return {
    green: reasons.length === 0,
    reasons,
    failures: (failures ?? []).map((failure) =>
      [failure.source, failure.code, failure.signal, failure.observed, failure.threshold]
        .filter((part) => part !== undefined && part !== null)
        .join(' ')
    ),
    completedAt: Number.isFinite(completedAt) ? new Date(completedAt).toISOString() : null,
    ageMs: Number.isFinite(completedAt) ? nowMs - completedAt : null
  }
}
