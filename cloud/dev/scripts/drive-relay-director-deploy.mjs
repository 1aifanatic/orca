// Operator-local driver for a production relay director deploy. It only dispatches the existing
// audited workflows and reads their results back; every safety check stays in those workflows.
import { spawnSync } from 'node:child_process'
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { pathToFileURL } from 'node:url'
import {
  DIRECTOR_SERVICE,
  IMAGE_REPOSITORY,
  PROJECT,
  REGION,
  REPOSITORY,
  WORKFLOW_REF,
  WORKFLOWS,
  admissionInspectInputs,
  admissionInspectResult,
  blocksDeploy,
  configureInputs,
  directorDeployInputs,
  directorRevisions,
  logConfirmsPublishedDigest,
  monitorDryRunInputs,
  monitorVerdict,
  parseConfigureWave,
  publishInputs,
  rehomeControlFromLog,
  rehomeEnableInputs,
  rehomeInspectInputs,
  rehomePauseInputs,
  requireCommit,
  requireDigest,
  revisionDigest,
  sameSelector,
  validateDispatchInputs
} from './relay-director-deploy-plan.mjs'

const ACTIVE_RUN_STATUSES = ['queued', 'in_progress', 'waiting', 'requested', 'pending']
// The enable job verifies the monitor within 5 minutes of completion after ~2 minutes of setup.
export const MONITOR_MAX_AGE_AT_ENABLE_MS = 2 * 60_000
const DISCOVERY_ATTEMPTS = 24
const DISCOVERY_INTERVAL_MS = 5_000
// Dispatch and list timestamps come from different clocks.
const DISCOVERY_CLOCK_SKEW_MS = 2 * 60_000
const LOG_ATTEMPTS = 6
const LOG_INTERVAL_MS = 10_000
const WATCH_INTERVAL_SECONDS = '10'
const REHOME_HISTORY_RUNS = 5

export class DriverStop extends Error {}

export function parseDriverArguments(argv, home = homedir()) {
  const config = {
    dryRun: false,
    commit: undefined,
    configure: [],
    rehomeGeneration: undefined,
    resume: undefined,
    stateDirectory: join(home, '.orca', 'relay-director-deploy')
  }
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index]
    if (key === '--dry-run') {
      config.dryRun = true
      continue
    }
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`${key} needs a value`)
    index += 1
    if (key === '--commit') config.commit = requireCommit(value, '--commit')
    else if (key === '--configure') config.configure.push(parseConfigureWave(value))
    else if (key === '--rehome-generation') {
      if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error('--rehome-generation is invalid')
      config.rehomeGeneration = Number(value)
    } else if (key === '--resume') config.resume = resolve(value)
    else if (key === '--state-directory') config.stateDirectory = resolve(value)
    else throw new Error(`unsupported argument ${key}`)
  }
  if (config.resume) {
    if (config.commit || config.configure.length > 0 || config.dryRun) {
      throw new Error('--resume takes its commit and plan from the state file')
    }
  } else if (!config.commit) {
    throw new Error('missing --commit <40-character main commit to publish>')
  }
  return config
}

function timestamp(nowMs) {
  return new Date(nowMs).toISOString()
}

function runUrl(runId) {
  return `https://github.com/${REPOSITORY}/actions/runs/${runId}`
}

export function createDriver(config, deps) {
  let state
  let statePath
  let logPath
  let login
  const dispatchedNow = new Set()

  function log(message) {
    const line = `${timestamp(deps.now())} ${message}`
    deps.print(line)
    if (logPath) appendFileSync(logPath, `${line}\n`)
  }

  function save() {
    const temporary = `${statePath}.tmp`
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
    renameSync(temporary, statePath)
  }

  function command(program, args, input) {
    const result = deps.run(program, args, input)
    if (result.status !== 0) {
      // stderr from gh/gcloud carries no credentials; keep it short anyway.
      const detail = String(result.stderr ?? '')
        .trim()
        .split('\n')
        .slice(-3)
        .join(' | ')
      throw new Error(`${program} ${args.slice(0, 4).join(' ')} failed: ${detail}`)
    }
    return String(result.stdout ?? '')
  }

  const gh = (args, input) => command('gh', args, input)
  const ghJson = (args) => JSON.parse(gh(args))
  const gcloudJson = (args) =>
    JSON.parse(command('gcloud', [...args, '--project', PROJECT, '--format=json']))

  function readDirector() {
    const service = gcloudJson([
      'run',
      'services',
      'describe',
      DIRECTOR_SERVICE,
      '--region',
      REGION
    ])
    const { servingRevision, rollbackRevision } = directorRevisions(service)
    const digestOf = (revision, label) =>
      revisionDigest(
        gcloudJson(['run', 'revisions', 'describe', revision, '--region', REGION]),
        label
      )
    return {
      servingRevision,
      servingDigest: digestOf(servingRevision, `serving revision ${servingRevision}`),
      rollbackRevision,
      rollbackDigest: digestOf(rollbackRevision, `rollback revision ${rollbackRevision}`)
    }
  }

  function activeRuns() {
    const own = new Set(
      Object.values(state.steps)
        .map((step) => step.runId)
        .filter(Boolean)
    )
    const active = []
    for (const status of ACTIVE_RUN_STATUSES) {
      const page = ghJson([
        'api',
        '-X',
        'GET',
        `repos/${REPOSITORY}/actions/runs`,
        '-f',
        `status=${status}`,
        '-f',
        'per_page=100'
      ])
      for (const run of page.workflow_runs ?? []) {
        if (blocksDeploy(run.path) && !own.has(run.id))
          active.push(`${run.name} ${runUrl(run.id)} (${run.status})`)
      }
    }
    return active
  }

  function requireQuietLane() {
    const active = activeRuns()
    if (active.length > 0) {
      throw new DriverStop(
        `relay workflows are in flight; wait for them first:\n  ${active.join('\n  ')}`
      )
    }
  }

  function viewRun(runId) {
    return ghJson([
      'run',
      'view',
      String(runId),
      '-R',
      REPOSITORY,
      '--json',
      'databaseId,status,conclusion,attempt,headSha,headBranch,event,workflowName,url'
    ])
  }

  function listDispatches(workflow) {
    return ghJson([
      'run',
      'list',
      '-R',
      REPOSITORY,
      '--workflow',
      workflow.file,
      '--event',
      'workflow_dispatch',
      '--branch',
      WORKFLOW_REF,
      '--user',
      login,
      '--limit',
      '20',
      '--json',
      'databaseId,createdAt'
    ])
  }

  // `gh workflow run` prints the run URL when GitHub returns it; otherwise exactly one new
  // dispatch by this operator after the request must appear, or the driver refuses to guess.
  async function discoverRun(workflow, knownIds, dispatchedAtMs) {
    for (let attempt = 0; attempt < DISCOVERY_ATTEMPTS; attempt += 1) {
      const fresh = listDispatches(workflow).filter(
        (run) =>
          !knownIds.has(run.databaseId) &&
          Date.parse(run.createdAt) >= dispatchedAtMs - DISCOVERY_CLOCK_SKEW_MS
      )
      if (fresh.length === 1) return fresh[0].databaseId
      if (fresh.length > 1) {
        throw new DriverStop(
          `${fresh.length} new ${workflow.file} runs appeared; cannot tell which is ours: ${fresh.map((run) => runUrl(run.databaseId)).join(', ')}`
        )
      }
      await deps.sleep(DISCOVERY_INTERVAL_MS)
    }
    return undefined
  }

  function requireRunIdentity(workflow, runId) {
    const run = viewRun(runId)
    if (
      run.workflowName !== workflow.name ||
      run.event !== 'workflow_dispatch' ||
      run.headBranch !== WORKFLOW_REF
    ) {
      throw new DriverStop(
        `run ${runUrl(runId)} is not a ${workflow.file} dispatch on ${WORKFLOW_REF}`
      )
    }
    return run
  }

  async function dispatch(name, workflow, inputs) {
    validateDispatchInputs(inputs)
    const knownIds = new Set(listDispatches(workflow).map((run) => run.databaseId))
    const entry = {
      status: 'dispatching',
      workflow: workflow.file,
      inputs,
      dispatchedAt: timestamp(deps.now()),
      // Lets a resume tell this dispatch apart from the driver's own earlier runs of the file.
      knownRunIds: [...knownIds]
    }
    state.steps[name] = entry
    save()
    log(`dispatch ${name}: ${workflow.file} ${JSON.stringify(inputs)}`)
    const output = gh(
      ['workflow', 'run', workflow.file, '-R', REPOSITORY, '--ref', WORKFLOW_REF, '--json'],
      JSON.stringify(inputs)
    )
    const printed = output.match(/\/actions\/runs\/([0-9]+)/)
    const runId = printed
      ? Number(printed[1])
      : await discoverRun(workflow, knownIds, Date.parse(entry.dispatchedAt))
    if (!runId) {
      throw new DriverStop(
        `dispatched ${workflow.file} but found no run for it; check ${`https://github.com/${REPOSITORY}/actions/workflows/${workflow.file}`} before resuming`
      )
    }
    const run = requireRunIdentity(workflow, runId)
    Object.assign(entry, {
      status: 'dispatched',
      runId,
      attempt: run.attempt,
      url: runUrl(runId),
      headSha: run.headSha
    })
    dispatchedNow.add(name)
    save()
    log(`${name}: run ${entry.url}`)
  }

  async function adoptInterruptedDispatch(name, workflow) {
    const entry = state.steps[name]
    const known = new Set(entry.knownRunIds ?? [])
    const runId = await discoverRun(workflow, known, Date.parse(entry.dispatchedAt))
    if (!runId) {
      delete state.steps[name]
      save()
      log(`${name}: the interrupted dispatch created no run; it will be dispatched again`)
      return
    }
    const run = requireRunIdentity(workflow, runId)
    Object.assign(entry, {
      status: 'dispatched',
      runId,
      attempt: run.attempt,
      url: runUrl(runId),
      headSha: run.headSha
    })
    save()
    log(`${name}: adopted interrupted dispatch ${entry.url}`)
  }

  async function waitForRun(name) {
    const entry = state.steps[name]
    for (;;) {
      deps.stream('gh', [
        'run',
        'watch',
        String(entry.runId),
        '-R',
        REPOSITORY,
        '--exit-status',
        '--interval',
        WATCH_INTERVAL_SECONDS
      ])
      const run = viewRun(entry.runId)
      if (run.status === 'completed') {
        Object.assign(entry, {
          status: 'completed',
          conclusion: run.conclusion,
          attempt: run.attempt,
          completedAt: timestamp(deps.now())
        })
        save()
        log(`${name}: ${run.conclusion} ${entry.url}`)
        return
      }
      await deps.sleep(LOG_INTERVAL_MS)
    }
  }

  async function runLog(runId) {
    let lastError
    for (let attempt = 0; attempt < LOG_ATTEMPTS; attempt += 1) {
      try {
        const text = gh(['run', 'view', String(runId), '-R', REPOSITORY, '--log'])
        if (text.trim()) return text
      } catch (error) {
        lastError = error
      }
      await deps.sleep(LOG_INTERVAL_MS)
    }
    throw new Error(
      `log for ${runUrl(runId)} is unavailable${lastError ? `: ${lastError.message}` : ''}`
    )
  }

  function downloadArtifactJson(runId, artifact, file) {
    const directory = mkdtempSync(join(tmpdir(), 'relay-director-deploy-'))
    try {
      gh(['run', 'download', String(runId), '-R', REPOSITORY, '-n', artifact, '-D', directory])
      return JSON.parse(readFileSync(join(directory, file), 'utf8'))
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }

  /** Dispatches (or resumes) one workflow step and parses its result once it succeeds. */
  async function workflowStep(name, workflow, inputs, onSuccess) {
    const existing = state.steps[name]
    if (existing?.status === 'succeeded') return existing
    if (existing?.status === 'dispatching') await adoptInterruptedDispatch(name, workflow)
    const previous = state.steps[name]
    if (
      previous?.status === 'rejected' ||
      (previous?.status === 'completed' && previous.conclusion !== 'success')
    ) {
      delete state.steps[name]
    }
    if (!state.steps[name]) {
      requireQuietLane()
      await dispatch(name, workflow, inputs())
    }
    const entry = state.steps[name]
    if (entry.status === 'dispatched') await waitForRun(name)
    if (entry.conclusion !== 'success') {
      throw new DriverStop(`${name} run ${entry.url} concluded ${entry.conclusion}`)
    }
    let result
    try {
      result = await onSuccess(entry)
    } catch (error) {
      // The run went green but its result is unusable; a resume dispatches the step again.
      entry.status = 'rejected'
      save()
      throw error
    }
    Object.assign(entry, result, { status: 'succeeded' })
    save()
    return entry
  }

  // A read-only step reruns on every invocation: its answer is only good for now.
  async function freshReadStep(name, workflow, inputs, onSuccess) {
    if (state.steps[name]?.status !== 'dispatched') delete state.steps[name]
    return await workflowStep(name, workflow, inputs, onSuccess)
  }

  async function lastKnownRehomeGeneration() {
    const runs = ghJson([
      'run',
      'list',
      '-R',
      REPOSITORY,
      '--workflow',
      WORKFLOWS.rehome.file,
      '--status',
      'completed',
      '--limit',
      String(REHOME_HISTORY_RUNS),
      '--json',
      'databaseId'
    ])
    for (const run of runs) {
      try {
        const { control } = rehomeControlFromLog(await runLog(run.databaseId), null)
        log(`rehome generation candidate ${control.generation} from ${runUrl(run.databaseId)}`)
        return control.generation
      } catch {
        // Failed before printing a control; try the next older run.
      }
    }
    throw new DriverStop(
      'no recent rehome run printed the control generation; pass --rehome-generation'
    )
  }

  function stepSucceeded(name) {
    const entry = state.steps[name]
    return (
      entry?.status === 'succeeded' ||
      (entry?.status === 'completed' && entry.conclusion === 'success')
    )
  }

  async function preflight() {
    log('preflight: relay workflow lane, target commit, serving director')
    if (config.dryRun) {
      const active = activeRuns()
      if (active.length > 0)
        log(
          `WARNING relay workflows are in flight; a real run would stop:\n  ${active.join('\n  ')}`
        )
    } else {
      requireQuietLane()
    }
    if (!stepSucceeded('publish')) {
      const main = gh(['api', `repos/${REPOSITORY}/commits/${WORKFLOW_REF}`, '--jq', '.sha']).trim()
      if (main !== state.commit) {
        throw new DriverStop(
          `${WORKFLOW_REF} is at ${main}, not the reviewed ${state.commit}; review the difference and start again with --commit ${main}`
        )
      }
    }
    const director = readDirector()
    log(
      `serving ${director.servingRevision} ${director.servingDigest}; rollback ${director.rollbackRevision} ${director.rollbackDigest}`
    )
    state.rollbackPoint ??= { revision: director.servingRevision, digest: director.servingDigest }
    state.director = director
    save()
    // A director safety pause moves the generation without a run; inspect then fails closed.
    const generation = config.rehomeGeneration ?? (await lastKnownRehomeGeneration())
    if (config.dryRun) {
      state.candidateRehomeGeneration = generation
      return
    }
    const admission = await freshReadStep(
      'preflight-admission',
      WORKFLOWS.admission,
      () => admissionInspectInputs(director.servingDigest),
      async (entry) => ({
        selector: admissionInspectResult(
          downloadArtifactJson(
            entry.runId,
            `relay-asia-admission-result-${entry.runId}-${entry.attempt}`,
            'result.json'
          )
        )
      })
    )
    if (state.selector && !sameSelector(state.selector, admission.selector)) {
      throw new DriverStop(
        `the admission selector moved from generation ${state.selector.generation} to ${admission.selector.generation} since this deploy started; investigate before resuming`
      )
    }
    state.selector = admission.selector
    const inspected = await freshReadStep(
      'preflight-rehome',
      WORKFLOWS.rehome,
      () =>
        rehomeInspectInputs({ director, selector: state.selector, controlGeneration: generation }),
      async (entry) => {
        const result = rehomeControlFromLog(await runLog(entry.runId), 'inspect')
        if (!result.selector || !sameSelector(result.selector, state.selector)) {
          throw new DriverStop('rehome inspect read a different selector than admission inspect')
        }
        return { control: result.control }
      }
    ).catch((error) => {
      if (state.steps['preflight-rehome']?.conclusion !== 'failure') throw error
      throw new DriverStop(
        `rehome inspect at generation ${generation} failed: the generation or selector moved (a director safety pause bumps it). Read the run log, then pass --rehome-generation`
      )
    })
    reconcileRehome(inspected.control)
  }

  function reconcileRehome(control) {
    state.control ??= control
    state.rehomeWasEnabled ??= control.enabled
    state.rehome = { generation: control.generation, enabled: control.enabled }
    log(
      `rehome: generation ${control.generation}, ${control.enabled ? 'ENABLED' : 'disabled'}; selector generation ${state.selector.generation}`
    )
    if (stepSucceeded('enable')) return
    if (!state.rehomeWasEnabled) {
      if (control.enabled)
        throw new DriverStop(
          'rehome was disabled when this deploy started and is enabled now; investigate'
        )
      return
    }
    if (control.hostCooldownMs === undefined) {
      throw new DriverStop(
        'the director reports no per-host rehome cooldown, so enable would refuse; not pausing'
      )
    }
    if (control.enabled) {
      if (stepSucceeded('pause'))
        throw new DriverStop(
          'rehome was re-enabled outside this driver after the pause; investigate'
        )
      return
    }
    if (!stepSucceeded('pause')) {
      state.steps.pause = { status: 'succeeded', observed: true, generation: control.generation }
      log(`rehome is already paused at generation ${control.generation}; not pausing again`)
    }
    save()
  }

  function mutationsRemain() {
    return planNames().some(
      (name) => !stepSucceeded(name) && !name.startsWith('verify') && name !== 'monitor'
    )
  }

  function planNames() {
    return [
      ...(state.rehomeWasEnabled ? ['pause'] : []),
      'publish',
      'deploy',
      ...state.configure.map((wave) => `configure:${wave.cells.join(',')}`),
      'verify-identities',
      'monitor',
      ...(state.rehomeWasEnabled ? ['enable'] : [])
    ]
  }

  function printPlan() {
    const director = state.director
    const fromAdmission = ['<from admission inspect>']
    const selector = state.selector ?? {
      generation: fromAdmission[0],
      membership: {
        existingOnly: fromAdmission,
        migrationOnly: fromAdmission,
        general: fromAdmission
      }
    }
    const published = state.steps.publish?.digest ?? '<published digest>'
    const paused =
      state.rehome === undefined
        ? '<rehome generation after pause>'
        : state.rehome.enabled
          ? state.rehome.generation + 1
          : state.rehome.generation
    const control = state.control ?? {
      generation: '<from rehome inspect>',
      notBefore: '<inspected>',
      ratePerMinute: '<inspected>',
      preferenceMaxAgeMs: '<inspected>',
      hostCooldownMs: '<inspected>',
      drainGraceMs: '<inspected>'
    }
    const after = {
      servingDigest: '<serving digest read from gcloud>',
      rollbackDigest: '<selector-rollback digest read from gcloud>'
    }
    const planned = [
      ...(state.selector
        ? []
        : [
            [
              'preflight-admission',
              WORKFLOWS.admission,
              admissionInspectInputs(director.servingDigest)
            ]
          ]),
      ...(state.control
        ? []
        : [
            [
              'preflight-rehome',
              WORKFLOWS.rehome,
              rehomeInspectInputs({
                director,
                selector,
                controlGeneration: state.candidateRehomeGeneration
              })
            ]
          ]),
      ...(state.rehomeWasEnabled !== false
        ? [['pause', WORKFLOWS.rehome, rehomePauseInputs({ director, selector, control })]]
        : []),
      ['publish', WORKFLOWS.publish, publishInputs()],
      [
        'deploy',
        WORKFLOWS.director,
        directorDeployInputs({
          imageDigest: published,
          predecessorDigest: state.rollbackPoint.digest,
          rehomeGeneration: paused
        })
      ],
      ...state.configure.map((wave) => [
        `configure:${wave.cells.join(',')}`,
        WORKFLOWS.admission,
        configureInputs({
          ...wave,
          directorDigest: published,
          selectorGeneration: selector.generation
        })
      ]),
      [
        'verify-identities',
        WORKFLOWS.rehome,
        rehomeInspectInputs({ director: after, selector, controlGeneration: paused })
      ],
      ['monitor', WORKFLOWS.monitor, monitorDryRunInputs(selector)],
      ...(state.rehomeWasEnabled !== false
        ? [
            [
              'enable',
              WORKFLOWS.rehome,
              rehomeEnableInputs({
                director: after,
                selector,
                control: { ...control, hostCooldownMs: control.hostCooldownMs ?? '<inspected>' },
                controlGeneration: paused,
                notBefore: '<now, epoch ms>',
                monitor: { runId: '<monitor run>', attempt: '<monitor attempt>' }
              })
            ]
          ]
        : [])
    ]
    const conditional = state.rehomeWasEnabled === undefined ? ' (only if rehome is enabled)' : ''
    for (const [name, workflow, inputs] of planned) {
      const done = stepSucceeded(name)
        ? ' (done)'
        : ['pause', 'enable'].includes(name)
          ? conditional
          : ''
      log(
        `plan ${name}${done}: gh workflow run ${workflow.file} --ref ${WORKFLOW_REF} ${JSON.stringify(inputs)}`
      )
    }
  }

  async function confirm() {
    const phrase = `DEPLOY ${state.commit.slice(0, 12)}`
    const answer = (
      await deps.prompt(`Type "${phrase}" to start the production mutations above: `)
    ).trim()
    if (answer !== phrase) throw new DriverStop('confirmation did not match; nothing was changed')
    log('operator confirmed')
  }

  async function pause() {
    const before = state.rehome.generation
    const entry = await workflowStep(
      'pause',
      WORKFLOWS.rehome,
      () =>
        rehomePauseInputs({
          director: state.director,
          selector: state.selector,
          control: { ...state.control, generation: before }
        }),
      async (step) => {
        const { control } = rehomeControlFromLog(await runLog(step.runId), 'pause')
        if (control.enabled || control.generation !== before + 1) {
          throw new DriverStop(
            `pause reported generation ${control.generation} enabled=${control.enabled}, expected ${before + 1} disabled`
          )
        }
        return { generation: control.generation }
      }
    )
    state.rehome = { generation: entry.generation, enabled: false }
    save()
    log(`REHOME PAUSED at generation ${entry.generation}`)
  }

  async function publish() {
    const entry = await workflowStep('publish', WORKFLOWS.publish, publishInputs, async (step) => {
      if (step.headSha !== state.commit) {
        throw new DriverStop(
          `publish built ${step.headSha}, not the reviewed ${state.commit}; ${WORKFLOW_REF} moved during dispatch. Do not deploy it.`
        )
      }
      // The workflow computes its own digest this way; the push line in its log must agree.
      const digest = command('gcloud', [
        'artifacts',
        'docker',
        'images',
        'describe',
        `${IMAGE_REPOSITORY}:sha-${state.commit}`,
        '--project',
        PROJECT,
        '--format=value(image_summary.digest)'
      ]).trim()
      requireDigest(digest, 'registry digest of the published tag')
      if (!logConfirmsPublishedDigest(await runLog(step.runId), state.commit, digest)) {
        throw new DriverStop(
          `registry digest ${digest} is not the digest the publish run pushed; the tag moved`
        )
      }
      return { digest }
    })
    log(`published ${IMAGE_REPOSITORY}@${entry.digest}`)
  }

  function requireServing(digest, label) {
    const director = readDirector()
    if (director.servingDigest !== digest) {
      throw new DriverStop(
        `${label}: serving ${director.servingRevision} runs ${director.servingDigest}, not ${digest}`
      )
    }
    state.director = director
    save()
    log(
      `${label}: serving ${director.servingRevision} ${director.servingDigest}; rollback ${director.rollbackRevision} ${director.rollbackDigest}`
    )
    return director
  }

  async function deploy() {
    if (state.rehome.enabled)
      throw new DriverStop('rehome is enabled; the director workflow requires it disabled')
    const digest = state.steps.publish.digest
    await workflowStep(
      'deploy',
      WORKFLOWS.director,
      () =>
        directorDeployInputs({
          imageDigest: digest,
          predecessorDigest: state.rollbackPoint.digest,
          rehomeGeneration: state.rehome.generation
        }),
      async () => ({
        servingRevision: requireServing(digest, 'deploy').servingRevision
      })
    )
  }

  async function configure(wave) {
    const digest = state.steps.publish.digest
    const name = `configure:${wave.cells.join(',')}`
    await workflowStep(
      name,
      WORKFLOWS.admission,
      () =>
        configureInputs({
          ...wave,
          directorDigest: digest,
          selectorGeneration: state.selector.generation
        }),
      async () => ({
        servingRevision: requireServing(digest, name).servingRevision
      })
    )
  }

  // Inspect binds the exact serving and rollback digests, so a wrong digest fails here, read-only,
  // before 15 minutes of monitor evidence is spent on it.
  async function verifyIdentities() {
    const director = requireServing(state.steps.publish.digest, 'verify-identities')
    const generation = state.rehome.generation
    await freshReadStep(
      'verify-identities',
      WORKFLOWS.rehome,
      () =>
        rehomeInspectInputs({ director, selector: state.selector, controlGeneration: generation }),
      async (entry) => {
        const { control } = rehomeControlFromLog(await runLog(entry.runId), 'inspect')
        if (control.generation !== generation || control.enabled) {
          throw new DriverStop(
            `rehome is at generation ${control.generation} enabled=${control.enabled}, expected ${generation} disabled`
          )
        }
        return { director }
      }
    )
  }

  async function monitor() {
    const enabling = state.rehomeWasEnabled && !stepSucceeded('enable')
    // Evidence parsed by an earlier invocation is too old for the enable it exists for.
    if (enabling && state.steps.monitor?.status === 'succeeded') delete state.steps.monitor
    let entry = await monitorStep()
    if (
      enabling &&
      !dispatchedNow.has('monitor') &&
      deps.now() - Date.parse(entry.monitorCompletedAt) > MONITOR_MAX_AGE_AT_ENABLE_MS
    ) {
      log('monitor: the run adopted on resume is too old for enable; dispatching a fresh one')
      delete state.steps.monitor
      entry = await monitorStep()
    }
    log(`monitor GREEN, completed ${entry.monitorCompletedAt}`)
  }

  async function monitorStep() {
    return await workflowStep(
      'monitor',
      WORKFLOWS.monitor,
      () => monitorDryRunInputs(state.selector),
      async (step) => {
        const artifact = `relay-monitor-dry-run-${step.runId}-${step.attempt}`
        const verdict = monitorVerdict(
          downloadArtifactJson(step.runId, artifact, `relay-${step.runId}-dry-run.state.json`),
          { runId: step.runId, nowMs: deps.now() }
        )
        if (!verdict.green) {
          throw new DriverStop(
            `monitor ${step.url} is not green: ${verdict.reasons.join('; ')}${verdict.failures.length ? `\n  ${verdict.failures.join('\n  ')}` : ''}`
          )
        }
        return { monitorCompletedAt: verdict.completedAt }
      }
    )
  }

  async function enable() {
    const monitorEntry = state.steps.monitor
    const ageMs = deps.now() - Date.parse(monitorEntry.monitorCompletedAt)
    if (ageMs > MONITOR_MAX_AGE_AT_ENABLE_MS) {
      throw new DriverStop(
        `monitor evidence is ${Math.round(ageMs / 1000)} s old, past the ${MONITOR_MAX_AGE_AT_ENABLE_MS / 1000} s dispatch budget; resume to run a fresh monitor`
      )
    }
    const verified = state.steps['verify-identities'].director
    const director = readDirector()
    if (
      director.servingDigest !== verified.servingDigest ||
      director.rollbackDigest !== verified.rollbackDigest
    ) {
      throw new DriverStop('the director changed after its identities were verified; investigate')
    }
    const before = state.rehome.generation
    const entry = await workflowStep(
      'enable',
      WORKFLOWS.rehome,
      () =>
        rehomeEnableInputs({
          director,
          selector: state.selector,
          control: state.control,
          controlGeneration: before,
          notBefore: Math.floor(deps.now() / 1000) * 1000,
          monitor: { runId: monitorEntry.runId, attempt: monitorEntry.attempt }
        }),
      async (step) => {
        const { control } = rehomeControlFromLog(await runLog(step.runId), 'enable')
        if (!control.enabled || control.generation !== before + 1) {
          throw new DriverStop(
            `enable reported generation ${control.generation} enabled=${control.enabled}, expected ${before + 1} enabled`
          )
        }
        return { generation: control.generation }
      }
    )
    state.rehome = { generation: entry.generation, enabled: true }
    save()
    log(`REHOME RE-ENABLED at generation ${entry.generation}`)
  }

  function stopReport(error) {
    const lines = [`STOPPED: ${error.message}`, '', 'State now:']
    if (state.rehome) {
      const paused = state.rehomeWasEnabled && !state.rehome.enabled
      lines.push(
        `- rehome: generation ${state.rehome.generation}, ${state.rehome.enabled ? 'enabled' : paused ? 'PAUSED by this driver (stays paused until enable succeeds)' : 'disabled (as found)'}`
      )
    } else {
      lines.push('- rehome: not read yet; unchanged')
    }
    if (state.director)
      lines.push(
        `- director: serving ${state.director.servingRevision} ${state.director.servingDigest} (as last read)`
      )
    if (state.steps.publish?.digest) lines.push(`- published: ${state.steps.publish.digest}`)
    if (state.rollbackPoint) {
      lines.push(
        `- rollback point: ${state.rollbackPoint.revision} ${state.rollbackPoint.digest} (redeploy it through ${WORKFLOWS.director.file} while rehome is disabled)`
      )
    }
    for (const [name, entry] of Object.entries(state.steps)) {
      lines.push(
        `- ${name}: ${entry.status}${entry.conclusion ? ` (${entry.conclusion})` : ''}${entry.url ? ` ${entry.url}` : ''}`
      )
    }
    if (state.steps.enable?.status === 'completed' && state.steps.enable.conclusion !== 'success') {
      lines.push(
        '- the failed enable ran its fail-closed recovery; the next preflight reads the resulting generation'
      )
    }
    lines.push(
      '',
      `Resume (from cloud/): node dev/scripts/drive-relay-director-deploy.mjs --resume ${statePath}`
    )
    lines.push(
      'Resume re-reads every live state first; a step that failed is dispatched again with fresh inputs.'
    )
    return lines.join('\n')
  }

  function open() {
    if (config.resume) {
      statePath = config.resume
      state = JSON.parse(readFileSync(statePath, 'utf8'))
      if (state.version !== 1) throw new Error('unsupported state file')
    } else {
      const stamp = timestamp(deps.now()).replace(/[:.]/g, '-')
      const directory = join(
        config.stateDirectory,
        `${stamp}-${config.commit.slice(0, 12)}${config.dryRun ? '-dry-run' : ''}`
      )
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      statePath = join(directory, 'state.json')
      state = {
        version: 1,
        commit: config.commit,
        configure: config.configure,
        startedAt: timestamp(deps.now()),
        steps: {}
      }
      save()
    }
    logPath = join(dirname(statePath), 'driver.log')
    log(
      `${config.resume ? 'resume' : config.dryRun ? 'dry run' : 'start'}: commit ${state.commit}; state ${statePath}`
    )
  }

  async function run() {
    open()
    try {
      login = gh(['api', 'user', '--jq', '.login']).trim()
      // Settle whatever was in flight when a previous invocation stopped, before reading state.
      for (const [name, entry] of Object.entries(state.steps)) {
        const workflow = Object.values(WORKFLOWS).find(
          (candidate) => candidate.file === entry.workflow
        )
        if (entry.status === 'dispatching') await adoptInterruptedDispatch(name, workflow)
        if (state.steps[name]?.status === 'dispatched') await waitForRun(name)
      }
      await preflight()
      printPlan()
      if (config.dryRun) {
        log('dry run: nothing dispatched')
        return { statePath, dryRun: true }
      }
      if (mutationsRemain()) await confirm()
      if (state.rehomeWasEnabled && state.rehome.enabled && !stepSucceeded('enable')) await pause()
      await publish()
      await deploy()
      for (const wave of state.configure) await configure(wave)
      if (!stepSucceeded('enable')) {
        await verifyIdentities()
        await monitor()
        if (state.rehomeWasEnabled) await enable()
      }
      state.finishedAt = timestamp(deps.now())
      save()
      log(
        `DONE: serving ${state.director.servingRevision} ${state.steps.publish.digest}; rehome ${state.rehome.enabled ? 'enabled' : 'disabled'} at generation ${state.rehome.generation}; rollback point ${state.rollbackPoint.revision} ${state.rollbackPoint.digest}`
      )
      return { statePath, done: true }
    } catch (error) {
      const report = stopReport(error)
      for (const line of report.split('\n')) log(line)
      throw Object.assign(error instanceof DriverStop ? error : new DriverStop(error.message), {
        reported: true,
        statePath
      })
    }
  }

  return { run }
}

function defaultDependencies() {
  return {
    run: (program, args, input) =>
      spawnSync(program, args, {
        encoding: 'utf8',
        input,
        maxBuffer: 256 * 1024 * 1024,
        stdio: ['pipe', 'pipe', 'pipe']
      }),
    stream: (program, args) =>
      spawnSync(program, args, { stdio: ['ignore', 'inherit', 'inherit'] }).status,
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
    print: (line) => process.stdout.write(`${line}\n`),
    prompt: async (question) => {
      const reader = createInterface({ input: process.stdin, output: process.stdout })
      try {
        return await reader.question(question)
      } finally {
        reader.close()
      }
    }
  }
}

export async function main(argv = process.argv.slice(2), deps = defaultDependencies()) {
  return await createDriver(parseDriverArguments(argv), deps).run()
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    if (!error.reported)
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
