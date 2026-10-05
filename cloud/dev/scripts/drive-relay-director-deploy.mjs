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
import { verifyDryRunAuthority } from './relay-monitor-evidence.mjs'
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
  parseConfigureWave,
  publishInputs,
  rehomeControlFromLog,
  rehomeEnableInputs,
  rehomeInspectInputs,
  rehomePauseInputs,
  requireCommit,
  requireDigest,
  revisionDigest,
  validateDispatchInputs
} from './relay-director-deploy-plan.mjs'

const ACTIVE_RUN_STATUSES = ['queued', 'in_progress', 'waiting', 'requested', 'pending']
// The enable job verifies the monitor within 5 minutes of completion after ~2.5 minutes of setup.
export const MONITOR_MAX_AGE_AT_ENABLE_MS = 150_000
// The manual procedure watched the new director for 5+ minutes before configuring cells.
export const SOAK_MS = 5 * 60_000
// Traffic moves about a minute before the deploy run completes (ops-log 05:00:33Z vs 05:01:34Z).
const TRAFFIC_SWITCH_LEAD_MS = 60_000
// Request logs land up to a minute late; reading at the window's end would undercount it.
const LOG_INGESTION_LAG_MS = 60_000
const DIRECTOR_5XX_FILTER = [
  'resource.type="cloud_run_revision"',
  `resource.labels.service_name="${DIRECTOR_SERVICE}"`,
  `logName="projects/${PROJECT}/logs/run.googleapis.com%2Frequests"`,
  'httpRequest.status>=500'
].join(' AND ')
const LOG_COUNT_LIMIT = 5_000
const DISCOVERY_INTERVAL_MS = 15_000
const DISCOVERY_CLOCK_SKEW_MS = 10_000
const LOG_ATTEMPTS = 6
const LOG_INTERVAL_MS = 10_000
const REHOME_HISTORY_RUNS = 5

// Per step, the control lines its own run prints and how far each moves the generation the dispatch
// expected, so a foreign run (say, one adopted after a crash) is never taken for this driver's pause.
const OWN_RUN_STEPS = {
  pause: { pause: [1] },
  enable: { enable: [1], 'recover-enable': [0, 2] }
}

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

const timestamp = (ms) => new Date(ms).toISOString()
// Argument lists whose values never contain spaces.
const words = (text) => text.split(' ')
const runUrl = (runId) => `https://github.com/${REPOSITORY}/actions/runs/${runId}`

export function createDriver(config, deps) {
  let state
  let statePath
  let logPath
  let login
  const typedPhrases = new Map()

  function log(message) {
    const line = `${timestamp(deps.now())} ${message}`
    deps.print(line)
    if (logPath) appendFileSync(logPath, `${line}\n`)
  }

  // A dry run keeps no state file, so it can never be resumed as a real deploy.
  function save() {
    if (config.dryRun) return
    writeFileSync(`${statePath}.tmp`, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
    renameSync(`${statePath}.tmp`, statePath)
  }

  function command(program, args, input) {
    const result = deps.run(program, args, input)
    if (result.status !== 0) {
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
    const service = gcloudJson(
      words(`run services describe ${DIRECTOR_SERVICE} --region ${REGION}`)
    )
    const { servingRevision, rollbackRevision } = directorRevisions(service)
    const digestOf = (revision) =>
      revisionDigest(
        gcloudJson(words(`run revisions describe ${revision} --region ${REGION}`)),
        `revision ${revision}`
      )
    return {
      servingRevision,
      servingDigest: digestOf(servingRevision),
      rollbackRevision,
      rollbackDigest: digestOf(rollbackRevision)
    }
  }

  function describeDirector(director) {
    return `serving ${director.servingRevision} ${director.servingDigest}; rollback ${director.rollbackRevision} ${director.rollbackDigest}`
  }

  // Paginated per status: the repository-wide first page can hide an in-flight relay run.
  function activeRuns() {
    const own = new Set(Object.values(state.steps).map((step) => step.runId))
    const active = []
    for (const status of ACTIVE_RUN_STATUSES) {
      const lines = gh(
        words(
          `api --paginate -X GET repos/${REPOSITORY}/actions/runs -f status=${status} -f per_page=100 --jq .workflow_runs[]|{id,path,name,status}`
        )
      )
      for (const run of lines.split('\n').filter(Boolean).map(JSON.parse)) {
        if (blocksDeploy(run.path) && !own.has(run.id)) {
          active.push(`${run.name} ${runUrl(run.id)} (${run.status})`)
        }
      }
    }
    return active
  }

  function requireQuietLane() {
    const active = activeRuns()
    if (active.length > 0) {
      throw new DriverStop(
        `relay workflows are in flight; wait for them:\n  ${active.join('\n  ')}`
      )
    }
  }

  function viewRun(runId) {
    return ghJson(
      words(
        `run view ${runId} -R ${REPOSITORY} --json status,conclusion,attempt,headSha,headBranch,event,workflowName`
      )
    )
  }

  function listDispatches(workflow) {
    return ghJson(
      words(
        `run list -R ${REPOSITORY} --workflow ${workflow.file} --event workflow_dispatch --branch ${WORKFLOW_REF} --user ${login} --limit 20 --json databaseId,createdAt`
      )
    )
  }

  function recordRun(name, workflow, runId) {
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
    Object.assign(state.steps[name], {
      status: 'dispatched',
      runId,
      attempt: run.attempt,
      url: runUrl(runId),
      headSha: run.headSha
    })
    save()
    log(`${name}: run ${runUrl(runId)}`)
  }

  // The run ID comes only from the URL `gh workflow run` prints, so another dispatch by the same
  // account can never be mistaken for this one.
  async function dispatch(name, workflow, inputs) {
    validateDispatchInputs(inputs)
    const knownRunIds = listDispatches(workflow).map((run) => run.databaseId)
    state.steps[name] = {
      status: 'dispatching',
      workflow: workflow.file,
      inputs,
      dispatchedAt: timestamp(deps.now()),
      knownRunIds
    }
    save()
    log(`dispatch ${name}: ${workflow.file} ${JSON.stringify(inputs)}`)
    const output = gh(
      ['workflow', 'run', workflow.file, '-R', REPOSITORY, '--ref', WORKFLOW_REF, '--json'],
      JSON.stringify(inputs)
    )
    const printed = output.match(/\/actions\/runs\/([0-9]+)/)
    if (!printed)
      throw new DriverStop(
        `gh printed no run URL for ${workflow.file}; upgrade gh. The dispatch may exist: resume looks for it`
      )
    recordRun(name, workflow, Number(printed[1]))
  }

  // Only after a crash between dispatch and the printed URL: a candidate is adopted only if it is the
  // single new run by this account on two polls 15 s apart.
  async function adoptInterruptedDispatch(name, workflow) {
    const entry = state.steps[name]
    const known = new Set(entry.knownRunIds)
    const candidates = () =>
      listDispatches(workflow)
        .filter(
          (run) =>
            !known.has(run.databaseId) &&
            Date.parse(run.createdAt) >= Date.parse(entry.dispatchedAt) - DISCOVERY_CLOCK_SKEW_MS
        )
        .map((run) => run.databaseId)
    const first = candidates()
    await deps.sleep(DISCOVERY_INTERVAL_MS)
    const second = candidates()
    if (first.length === 0 && second.length === 0) {
      delete state.steps[name]
      save()
      log(`${name}: the interrupted dispatch created no run; dispatching again`)
    } else if (first.length === 1 && second.length === 1 && first[0] === second[0]) {
      recordRun(name, workflow, first[0])
    } else {
      throw new DriverStop(
        `cannot tell which new ${workflow.file} run is the interrupted dispatch: ${[...new Set([...first, ...second])].map(runUrl).join(', ')}`
      )
    }
  }

  async function waitForRun(name) {
    const entry = state.steps[name]
    for (;;) {
      deps.stream(
        'gh',
        words(`run watch ${entry.runId} -R ${REPOSITORY} --exit-status --interval 10`)
      )
      const run = viewRun(entry.runId)
      if (run.status === 'completed') {
        Object.assign(entry, {
          status: 'completed',
          conclusion: run.conclusion,
          attempt: run.attempt
        })
        save()
        log(`${name}: ${run.conclusion} ${entry.url}`)
        return
      }
      await deps.sleep(LOG_INTERVAL_MS)
    }
  }

  async function runLog(runId) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        const text = gh(['run', 'view', String(runId), '-R', REPOSITORY, '--log'])
        if (text.trim()) return text
      } catch (error) {
        if (attempt >= LOG_ATTEMPTS)
          throw new Error(`log for ${runUrl(runId)} is unavailable: ${error.message}`)
      }
      if (attempt >= LOG_ATTEMPTS) throw new Error(`log for ${runUrl(runId)} is empty`)
      await deps.sleep(LOG_INTERVAL_MS)
    }
  }

  async function withArtifact(runId, artifact, read) {
    const directory = mkdtempSync(join(tmpdir(), 'relay-director-deploy-'))
    try {
      gh(['run', 'download', String(runId), '-R', REPOSITORY, '-n', artifact, '-D', directory])
      return await read(directory)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }

  async function typed(phrase) {
    if (typedPhrases.has(phrase)) return phrase
    const answer = (await deps.prompt(`Type ${phrase} to continue: `)).trim()
    if (answer !== phrase)
      throw new DriverStop(`expected ${phrase}; nothing further was dispatched`)
    typedPhrases.set(phrase, answer)
    log(`operator typed ${phrase}`)
    return answer
  }

  function stepSucceeded(name) {
    const entry = state.steps[name]
    return (
      entry?.status === 'succeeded' ||
      (entry?.status === 'completed' && entry.conclusion === 'success')
    )
  }

  /** Dispatches (or resumes) one workflow step and accepts its result. */
  async function workflowStep(step) {
    const { name } = step
    if (state.steps[name]?.status === 'dispatching')
      await adoptInterruptedDispatch(name, step.workflow)
    let entry = state.steps[name]
    if (
      entry?.status === 'rejected' ||
      (entry?.status === 'completed' && entry.conclusion !== 'success')
    ) {
      delete state.steps[name]
      entry = undefined
    }
    if (!entry) {
      requireQuietLane()
      for (const phrase of [step.phrase, step.arm].filter(Boolean)) await typed(phrase)
      await step.before?.()
      await dispatch(name, step.workflow, step.inputs(view()))
      entry = state.steps[name]
    }
    if (entry.status === 'dispatched') await waitForRun(name)
    await step.settle?.(entry)
    if (entry.conclusion !== 'success')
      throw new DriverStop(`${name} run ${entry.url} concluded ${entry.conclusion}`)
    try {
      Object.assign(entry, await step.result?.(entry))
    } catch (error) {
      // The run went green but its result is unusable; a resume dispatches the step again.
      entry.status = 'rejected'
      save()
      throw error
    }
    entry.status = 'succeeded'
    save()
  }

  // Values every input builder reads. A dry run shows what is not known yet as `<placeholder>`,
  // which validateDispatchInputs refuses, so a placeholder can never be dispatched.
  function view() {
    const unknown = (label) => `<${label}>`
    const fromAdmission = [unknown('from admission inspect')]
    const rehome = state.rehome
    return {
      director: state.director,
      selector: state.selector ?? {
        generation: fromAdmission[0],
        membership: {
          existingOnly: fromAdmission,
          migrationOnly: fromAdmission,
          general: fromAdmission
        }
      },
      control:
        state.control ??
        Object.fromEntries(
          [
            'notBefore',
            'ratePerMinute',
            'preferenceMaxAgeMs',
            'hostCooldownMs',
            'drainGraceMs'
          ].map((key) => [key, unknown('inspected')])
        ),
      generation: rehome?.generation ?? unknown('inspected rehome generation'),
      pausedGeneration: rehome
        ? rehome.enabled
          ? rehome.generation + 1
          : rehome.generation
        : unknown('rehome generation after pause'),
      published: state.steps.publish?.digest ?? unknown('published digest'),
      rollbackPointDigest: state.rollbackPoint?.digest,
      verified: state.verified ?? {
        servingDigest: unknown('serving digest from gcloud'),
        rollbackDigest: unknown('rollback digest from gcloud')
      },
      monitor: state.steps.monitor?.runId
        ? { runId: state.steps.monitor.runId, attempt: state.steps.monitor.attempt }
        : { runId: unknown('monitor run'), attempt: unknown('monitor attempt') },
      notBefore: config.dryRun ? unknown('now, epoch ms') : Math.floor(deps.now() / 1000) * 1000,
      confirmation: (phrase) =>
        typedPhrases.has(phrase) ? phrase : unknown(`operator types ${phrase}`)
    }
  }

  // Reads the control from a rehome run whatever its conclusion: pause applies first, and a failed
  // enable runs its fail-closed recovery, so a red run can still have changed the switch.
  async function settleRehome(entry, name) {
    const steps = OWN_RUN_STEPS[name]
    let control
    try {
      const result = rehomeControlFromLog(await runLog(entry.runId), Object.keys(steps))
      const step = result.control.generation - Number(entry.inputs['expected-control-generation'])
      if (!steps[result.mode].includes(step)) throw new Error('not this run')
      control = result.control
    } catch {
      state.rehome = { ...state.rehome, unconfirmedBy: entry.url }
      save()
      return
    }
    state.rehome = { generation: control.generation, enabled: control.enabled }
    if (!control.enabled)
      state.pausedByDriver = { generation: control.generation, runId: entry.runId }
    save()
    log(
      `rehome is now generation ${control.generation}, ${control.enabled ? 'ENABLED' : 'PAUSED'} (${entry.url})`
    )
  }

  function requireServing(digest, label) {
    const director = readDirector()
    state.director = director
    save()
    if (director.servingDigest !== digest)
      throw new DriverStop(`${label}: ${describeDirector(director)}, not ${digest}`)
    log(`${label}: ${describeDirector(director)}`)
    return director
  }

  function count5xx(fromMs, toMs) {
    const filter = `${DIRECTOR_5XX_FILTER} AND timestamp>="${timestamp(fromMs)}" AND timestamp<"${timestamp(toMs)}"`
    return command('gcloud', [
      'logging',
      'read',
      filter,
      ...words(`--project ${PROJECT} --limit ${LOG_COUNT_LIMIT} --format=value(timestamp)`)
    ])
      .split('\n')
      .filter(Boolean).length
  }

  // Director 5xx over the first SOAK_MS on the new image against the same span before the deploy.
  async function soak() {
    const deploy = state.steps.deploy
    const start = Math.max(
      Date.parse(deploy.completedAt) - TRAFFIC_SWITCH_LEAD_MS,
      Date.parse(deploy.dispatchedAt)
    )
    const end = start + SOAK_MS
    const readAt = end + LOG_INGESTION_LAG_MS
    if (deps.now() < readAt) {
      log(
        `soak: watching the new director until ${timestamp(end)}, reading at ${timestamp(readAt)}`
      )
      await deps.sleep(readAt - deps.now())
    }
    const before = count5xx(
      Date.parse(deploy.dispatchedAt) - SOAK_MS,
      Date.parse(deploy.dispatchedAt)
    )
    const after = count5xx(start, end)
    log(
      `soak: director 5xx ${after} in ${SOAK_MS / 60_000} min after the deploy, ${before} before it`
    )
    if (after >= LOG_COUNT_LIMIT || after > 2 * before + 25) {
      throw new DriverStop(
        `director 5xx rose from ${before} to ${after} after the deploy; investigate before configuring cells`
      )
    }
  }

  function plan() {
    const enabling = state.rehomeWasEnabled !== false
    const digest = () => state.steps.publish.digest
    return [
      ...(enabling
        ? [
            {
              name: 'pause',
              workflow: WORKFLOWS.rehome,
              phrase: 'PAUSE_REGIONAL_REHOMING',
              mutates: true,
              inputs: (v) =>
                rehomePauseInputs({
                  ...v,
                  control: { ...v.control, generation: v.generation },
                  confirmation: v.confirmation('PAUSE_REGIONAL_REHOMING')
                }),
              settle: (entry) => settleRehome(entry, 'pause'),
              result: () => {
                if (state.rehome.enabled || state.rehome.unconfirmedBy)
                  throw new DriverStop('the pause run did not report a paused control')
              }
            }
          ]
        : []),
      {
        name: 'publish',
        workflow: WORKFLOWS.publish,
        mutates: true,
        inputs: publishInputs,
        result: publishResult
      },
      {
        name: 'deploy',
        workflow: WORKFLOWS.director,
        mutates: true,
        before: () => {
          if (state.rehome.enabled)
            throw new DriverStop('rehome is enabled; the director workflow requires it disabled')
        },
        inputs: (v) =>
          directorDeployInputs({
            imageDigest: v.published,
            predecessorDigest: v.rollbackPointDigest,
            rehomeGeneration: v.pausedGeneration
          }),
        result: () => ({
          completedAt: timestamp(deps.now()),
          servingRevision: requireServing(digest(), 'deploy').servingRevision
        })
      },
      ...(state.configure.length > 0 ? [{ name: 'soak', local: soak }] : []),
      ...state.configure.map((wave) => ({
        name: `configure:${wave.cells.join(',')}`,
        workflow: WORKFLOWS.admission,
        phrase: 'CONFIGURE_ASIA_DIRECTOR',
        mutates: true,
        inputs: (v) =>
          configureInputs({
            ...wave,
            directorDigest: v.published,
            selectorGeneration: v.selector.generation,
            confirmation: v.confirmation('CONFIGURE_ASIA_DIRECTOR')
          }),
        result: () => ({
          servingRevision: requireServing(digest(), `configure ${wave.cells.join(',')}`)
            .servingRevision
        })
      })),
      // Inspect binds the exact serving and rollback digests, so a wrong one fails here, read-only,
      // before 15 minutes of monitor evidence is spent on it.
      {
        name: 'verify-identities',
        workflow: WORKFLOWS.rehome,
        fresh: true,
        before: () => {
          state.verified = requireServing(digest(), 'verify-identities')
        },
        inputs: (v) =>
          rehomeInspectInputs({
            director: v.verified,
            selector: v.selector,
            controlGeneration: v.pausedGeneration
          }),
        result: async (entry) => {
          const { control } = rehomeControlFromLog(await runLog(entry.runId), 'inspect')
          if (control.enabled || control.generation !== state.rehome.generation) {
            throw new DriverStop(
              `rehome is generation ${control.generation} enabled=${control.enabled}, expected ${state.rehome.generation} disabled`
            )
          }
        }
      },
      {
        name: 'monitor',
        workflow: WORKFLOWS.monitor,
        fresh: enabling,
        // The operator arms the enable before the 15-minute watch; it still dispatches only on green.
        arm: enabling ? 'ENABLE_REGIONAL_REHOMING' : undefined,
        inputs: (v) => monitorDryRunInputs(v.selector),
        result: monitorResult
      },
      ...(enabling
        ? [
            {
              name: 'enable',
              workflow: WORKFLOWS.rehome,
              phrase: 'ENABLE_REGIONAL_REHOMING',
              mutates: true,
              before: () => {
                const ageMs = deps.now() - Date.parse(state.steps.monitor.monitorCompletedAt)
                if (ageMs > MONITOR_MAX_AGE_AT_ENABLE_MS) {
                  throw new DriverStop(
                    `monitor evidence is ${Math.round(ageMs / 1000)} s old, past the ${MONITOR_MAX_AGE_AT_ENABLE_MS / 1000} s budget; resume to run a fresh monitor`
                  )
                }
                const director = readDirector()
                if (
                  director.servingDigest !== state.verified.servingDigest ||
                  director.rollbackDigest !== state.verified.rollbackDigest
                ) {
                  throw new DriverStop(
                    `the director changed after its digests were verified: ${describeDirector(director)}`
                  )
                }
                if (state.control.ratePerMinute !== 10)
                  log(
                    `enable starts at the job's fixed 10 hosts/min (was ${state.control.ratePerMinute})`
                  )
              },
              inputs: (v) =>
                rehomeEnableInputs({
                  ...v,
                  director: v.verified,
                  controlGeneration: v.generation,
                  confirmation: v.confirmation('ENABLE_REGIONAL_REHOMING')
                }),
              settle: (entry) => settleRehome(entry, 'enable'),
              result: () => {
                if (!state.rehome.enabled)
                  throw new DriverStop('the enable run did not report an enabled control')
                delete state.pausedByDriver
              }
            }
          ]
        : [])
    ]
  }

  async function publishResult(entry) {
    if (entry.headSha !== state.commit) {
      throw new DriverStop(
        `publish built ${entry.headSha}, not the reviewed ${state.commit}; ${WORKFLOW_REF} moved. Do not deploy it.`
      )
    }
    // The workflow computes its own digest this way; the push line in its log must agree.
    const tag = `${IMAGE_REPOSITORY}:sha-${state.commit}`
    const digest = command(
      'gcloud',
      words(
        `artifacts docker images describe ${tag} --project ${PROJECT} --format=value(image_summary.digest)`
      )
    ).trim()
    requireDigest(digest, 'registry digest of the published tag')
    if (!logConfirmsPublishedDigest(await runLog(entry.runId), state.commit, digest)) {
      throw new DriverStop(
        `registry digest ${digest} is not the digest the publish run pushed; the tag moved`
      )
    }
    log(`published ${IMAGE_REPOSITORY}@${digest}`)
    return { digest }
  }

  // The same audited check the enable job runs, on the same sealed files.
  async function monitorResult(entry) {
    const incidentId = `relay-${entry.runId}-dry-run`
    return await withArtifact(
      entry.runId,
      `relay-monitor-dry-run-${entry.runId}-${entry.attempt}`,
      async (directory) => {
        try {
          const { state: monitor } = await verifyDryRunAuthority(
            [
              '--directory',
              directory,
              '--incident-id',
              incidentId,
              '--run-id',
              String(entry.runId),
              '--run-attempt',
              String(entry.attempt),
              '--commit-sha',
              entry.headSha,
              '--mode',
              'dry-run',
              '--required-migration-policy',
              'strict'
            ],
            deps.now
          )
          log(`monitor GREEN, completed ${monitor.completedAt}`)
          return { monitorCompletedAt: monitor.completedAt }
        } catch (error) {
          let detail = ''
          try {
            const sealed = JSON.parse(
              readFileSync(join(directory, `${incidentId}.state.json`), 'utf8')
            )
            detail = [
              `frozenAt ${sealed.frozenAt}`,
              ...(sealed.failures ?? []).map((failure) =>
                [failure.source, failure.code, failure.signal, failure.observed, failure.threshold]
                  .filter((part) => part != null)
                  .join(' ')
              )
            ].join('\n  ')
          } catch {
            // The verdict error alone is the report.
          }
          throw new DriverStop(
            `monitor ${entry.url} is not usable: ${error.message}${detail ? `\n  ${detail}` : ''}`
          )
        }
      }
    )
  }

  async function lastKnownRehomeGeneration() {
    const runs = ghJson(
      words(
        `run list -R ${REPOSITORY} --workflow ${WORKFLOWS.rehome.file} --status completed --limit ${REHOME_HISTORY_RUNS} --json databaseId`
      )
    )
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

  // Read-only and rerun on every invocation: the answer is only good for now.
  async function freshRead(step) {
    if (state.steps[step.name]?.status !== 'dispatched') delete state.steps[step.name]
    await workflowStep(step)
    return state.steps[step.name]
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
    state.director = readDirector()
    state.rollbackPoint ??= {
      revision: state.director.servingRevision,
      digest: state.director.servingDigest
    }
    save()
    log(describeDirector(state.director))
    // A director safety pause moves the generation without a run; the inspect then fails closed.
    const generation = config.rehomeGeneration ?? (await lastKnownRehomeGeneration())
    const admission = {
      name: 'preflight-admission',
      workflow: WORKFLOWS.admission,
      inputs: () => admissionInspectInputs(state.director.servingDigest),
      result: async (entry) => ({
        selector: await withArtifact(
          entry.runId,
          `relay-asia-admission-result-${entry.runId}-${entry.attempt}`,
          (directory) =>
            admissionInspectResult(JSON.parse(readFileSync(join(directory, 'result.json'), 'utf8')))
        )
      })
    }
    const inspect = {
      name: 'preflight-rehome',
      workflow: WORKFLOWS.rehome,
      inputs: (v) =>
        rehomeInspectInputs({
          director: v.director,
          selector: v.selector,
          controlGeneration: generation
        }),
      result: async (entry) => ({
        control: rehomeControlFromLog(await runLog(entry.runId), 'inspect').control
      })
    }
    if (config.dryRun) return [admission, inspect]
    const { selector } = await freshRead(admission)
    if (state.selector && state.selector.generation !== selector.generation) {
      log(
        `selector moved from generation ${state.selector.generation} to ${selector.generation}; every later workflow binds the new one`
      )
    }
    state.selector = selector
    const { control } = await freshRead(inspect).catch((error) => {
      if (state.steps['preflight-rehome']?.conclusion !== 'failure') throw error
      throw new DriverStop(
        `rehome inspect at generation ${generation} failed: the generation moved (a director safety pause bumps it). Read the run log, then pass --rehome-generation`
      )
    })
    reconcileRehome(control)
    return []
  }

  function reconcileRehome(control) {
    if (
      state.rehomeWasEnabled === undefined &&
      control.enabled &&
      control.hostCooldownMs === undefined
    ) {
      throw new DriverStop(
        'the director reports no per-host rehome cooldown, so enable would refuse; not pausing'
      )
    }
    state.control ??= control
    state.rehomeWasEnabled ??= control.enabled
    state.rehome = { generation: control.generation, enabled: control.enabled }
    save()
    log(
      `rehome: generation ${control.generation}, ${control.enabled ? 'ENABLED' : 'disabled'}; selector generation ${state.selector.generation}`
    )
    if (!state.rehomeWasEnabled) {
      if (control.enabled)
        throw new DriverStop(
          'rehome was disabled when this deploy started and is enabled now; investigate'
        )
      log('WARNING rehome was disabled when this deploy started; it will be left disabled')
    } else if (stepSucceeded('enable')) {
      // Nothing to reconcile.
    } else if (control.enabled) {
      if (state.pausedByDriver)
        throw new DriverStop(
          'rehome was re-enabled outside this driver after its pause; investigate'
        )
    } else if (state.pausedByDriver?.generation !== control.generation) {
      // A director safety pause or another operator looks the same; this driver never lifts it.
      throw new DriverStop(
        `rehome is paused at generation ${control.generation}, which this driver did not pause (${state.pausedByDriver ? `its pause was generation ${state.pausedByDriver.generation}` : 'it has not paused'}). Find out who paused it; this driver will not re-enable it`
      )
    }
  }

  function stopReport(reason) {
    const lines = [`STOPPED: ${reason}`, '', 'State now:']
    const rehome = state.rehome
    if (rehome?.unconfirmedBy) {
      lines.push(
        `- *** REHOME STATE UNCONFIRMED: ${rehome.unconfirmedBy} reported no control. It MAY BE PAUSED. Run a rehome inspect before walking away. ***`
      )
    } else if (rehome && !rehome.enabled && state.pausedByDriver) {
      lines.push(
        `- *** REHOME IS PAUSED by this driver at generation ${rehome.generation} (${runUrl(state.pausedByDriver.runId)}). It stays paused until a resume finishes the enable. ***`
      )
    } else {
      lines.push(
        rehome
          ? `- rehome: generation ${rehome.generation}, ${rehome.enabled ? 'enabled' : 'disabled (as found)'}`
          : '- rehome: unchanged'
      )
    }
    try {
      state.director = readDirector()
      lines.push(`- director now: ${describeDirector(state.director)}`)
    } catch (error) {
      lines.push(`- director: could not re-read (${error.message})`)
    }
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
    if (!config.dryRun)
      lines.push(
        '',
        `Resume (from cloud/): node dev/scripts/drive-relay-director-deploy.mjs --resume ${statePath}`
      )
    return lines.join('\n')
  }

  function open() {
    if (config.resume) {
      statePath = config.resume
      state = JSON.parse(readFileSync(statePath, 'utf8'))
      if (state.version !== 2) throw new Error('not a resumable director deploy state file')
    } else {
      const stamp = timestamp(deps.now()).replace(/[:.]/g, '-')
      const directory = join(
        config.stateDirectory,
        `${stamp}-${config.commit.slice(0, 12)}${config.dryRun ? '-dry-run' : ''}`
      )
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      statePath = join(directory, 'state.json')
      state = { version: 2, commit: config.commit, configure: config.configure, steps: {} }
      save()
    }
    logPath = join(dirname(statePath), 'driver.log')
    log(
      `${config.resume ? 'resume' : config.dryRun ? 'dry run' : 'start'}: commit ${state.commit}${config.dryRun ? '' : `; state ${statePath}`}`
    )
  }

  async function run() {
    open()
    try {
      login = gh(['api', 'user', '--jq', '.login']).trim()
      // Settle whatever was in flight when a previous invocation stopped.
      for (const [name, entry] of Object.entries(state.steps)) {
        const workflow = Object.values(WORKFLOWS).find(
          (candidate) => candidate.file === entry.workflow
        )
        if (entry.status === 'dispatching') await adoptInterruptedDispatch(name, workflow)
        if (state.steps[name]?.status === 'dispatched') await waitForRun(name)
        if (
          ['pause', 'enable'].includes(name) &&
          state.steps[name]?.runId &&
          state.steps[name].status !== 'succeeded'
        ) {
          // Includes a green run adopted above, whose result was never read.
          await settleRehome(state.steps[name], name)
        }
      }
      const reads = await preflight()
      const steps = plan()
      for (const step of [...reads, ...steps]) {
        const note = stepSucceeded(step.name)
          ? ' (done)'
          : state.rehomeWasEnabled === undefined && ['pause', 'enable'].includes(step.name)
            ? ' (only if rehome is enabled)'
            : ''
        log(
          `plan ${step.name}${note}: ${step.local ? `wait ${SOAK_MS / 60_000} min, then compare director 5xx` : `${step.workflow.file} ${JSON.stringify(step.inputs(view()))}`}`
        )
      }
      if (config.dryRun) {
        log('dry run: nothing dispatched')
        return { dryRun: true }
      }
      if (steps.some((step) => step.mutates && !stepSucceeded(step.name)))
        await typed(`DEPLOY ${state.commit.slice(0, 12)}`)
      const enabled = stepSucceeded('enable')
      for (const step of steps) {
        if (step.fresh && !enabled && state.steps[step.name]?.status === 'succeeded')
          delete state.steps[step.name]
        // A green run whose result was never read (an interrupted watch) is still read here.
        if (state.steps[step.name]?.status === 'succeeded') continue
        if (step.name === 'pause' && !state.rehome.enabled) continue
        if (step.local) {
          await step.local()
          state.steps[step.name] = { status: 'succeeded' }
          save()
        } else {
          await workflowStep(step)
        }
      }
      log(
        `DONE: ${describeDirector(state.director)}; rehome ${state.rehome.enabled ? 'enabled' : 'disabled'} at generation ${state.rehome.generation}; rollback point ${state.rollbackPoint.revision} ${state.rollbackPoint.digest}`
      )
      return { statePath, done: true }
    } catch (error) {
      for (const line of stopReport(error.message).split('\n')) log(line)
      throw Object.assign(error instanceof DriverStop ? error : new DriverStop(error.message), {
        reported: true,
        statePath
      })
    }
  }

  // Ctrl-C or SIGTERM mid-watch still leaves the operator the state and the resume command.
  function interrupt(signal) {
    if (!state) return
    for (const line of stopReport(`interrupted by ${signal}`).split('\n')) log(line)
  }

  return { run, interrupt }
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
  const driver = createDriver(parseDriverArguments(argv), deps)
  for (const [signal, code] of [
    ['SIGINT', 130],
    ['SIGTERM', 143]
  ]) {
    process.once(signal, () => {
      driver.interrupt(signal)
      process.exit(code)
    })
  }
  return await driver.run()
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    if (!error.reported)
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
