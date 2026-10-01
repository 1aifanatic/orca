import type { RelayOpsEnvironment } from './environment-config.js'
import { googleJson, MonitoringResponseSchema, pointValue } from './incident-monitor-sources.js'
import { PRE_DRAIN_HARD_RULES, type PreDrainHardRuleReadings } from './pre-drain-sample.js'

// The Docker `container die` count per relay cell, from infra/terraform/relay-observability.tf.
export const CELL_PROCESS_EXIT_METRIC = 'logging.googleapis.com/user/orca_relay_cell_process_exit'

type AlignedRead = {
  filter: string
  lookbackMs: number
  aligner: 'ALIGN_SUM' | 'ALIGN_DELTA' | 'ALIGN_PERCENTILE_99'
  reducer: 'REDUCE_SUM' | 'REDUCE_MAX'
}

// Server-side per-minute alignment, so a burst is counted rather than sampled and no read can be
// truncated the way a log read is.
async function readPerMinute(
  environment: RelayOpsEnvironment,
  token: string,
  fetchImpl: typeof fetch,
  nowMs: number,
  read: AlignedRead
): Promise<number[]> {
  const url = new URL(
    `https://monitoring.googleapis.com/v3/projects/${environment.project}/timeSeries`
  )
  url.searchParams.set('filter', read.filter)
  url.searchParams.set('interval.startTime', new Date(nowMs - read.lookbackMs).toISOString())
  url.searchParams.set('interval.endTime', new Date(nowMs).toISOString())
  url.searchParams.set('aggregation.alignmentPeriod', '60s')
  url.searchParams.set('aggregation.perSeriesAligner', read.aligner)
  url.searchParams.set('aggregation.crossSeriesReducer', read.reducer)
  url.searchParams.set('pageSize', '1000')
  const parsed = MonitoringResponseSchema.parse(await googleJson(fetchImpl, token, url))
  if (parsed.nextPageToken) throw new Error('Google metric pagination is incomplete')
  return parsed.timeSeries.flatMap((series) => series.points.map(pointValue))
}

function directorFilter(environment: RelayOpsEnvironment, metricType: string): string {
  return [
    `metric.type="${metricType}"`,
    'resource.type="cloud_run_revision"',
    `resource.label."service_name"="${environment.directorService}"`
  ].join(' AND ')
}

export function createPreDrainHardRuleReader(
  environment: RelayOpsEnvironment,
  accessToken: () => Promise<string>,
  options: { fetchImpl?: typeof fetch; now?: () => number } = {}
): () => Promise<PreDrainHardRuleReadings> {
  const fetchImpl = options.fetchImpl ?? fetch
  const now = options.now ?? Date.now
  // An exit count of zero is only evidence if the metric exists; a renamed or deleted log metric
  // reads as an empty, calm series forever. Checked once, before the first reading is trusted.
  let descriptorChecked: Promise<void> | null = null
  const requireExitMetric = (token: string): Promise<void> => {
    descriptorChecked ??= googleJson(
      fetchImpl,
      token,
      `https://monitoring.googleapis.com/v3/projects/${environment.project}` +
        `/metricDescriptors/${CELL_PROCESS_EXIT_METRIC}`
    ).then(() => undefined, (error: unknown) => {
      descriptorChecked = null
      throw error
    })
    return descriptorChecked
  }
  return async () => {
    const token = await accessToken()
    await requireExitMetric(token)
    const nowMs = now()
    const [exits, director503, concurrency] = await Promise.all([
      readPerMinute(environment, token, fetchImpl, nowMs, {
        filter: `metric.type="${CELL_PROCESS_EXIT_METRIC}" AND resource.type="gce_instance"`,
        lookbackMs: PRE_DRAIN_HARD_RULES.cellProcessExitLookbackMs,
        aligner: 'ALIGN_SUM',
        reducer: 'REDUCE_SUM'
      }),
      readPerMinute(environment, token, fetchImpl, nowMs, {
        filter: `${directorFilter(environment, 'run.googleapis.com/request_count')}` +
          ' AND metric.label."response_code"="503"',
        lookbackMs: PRE_DRAIN_HARD_RULES.director503LookbackMs,
        aligner: 'ALIGN_DELTA',
        reducer: 'REDUCE_SUM'
      }),
      readPerMinute(environment, token, fetchImpl, nowMs, {
        filter: `${directorFilter(
          environment,
          'run.googleapis.com/container/max_request_concurrencies'
        )} AND metric.label."state"="active"`,
        lookbackMs: PRE_DRAIN_HARD_RULES.directorConcurrencyLookbackMs,
        aligner: 'ALIGN_PERCENTILE_99',
        reducer: 'REDUCE_MAX'
      })
    ])
    return {
      // Exits and 503s are counters, so a minute with no point had none.
      cellProcessExits: exits.reduce((total, value) => total + value, 0),
      director503PeakPerMinute: Math.max(0, ...director503),
      directorConcurrencyP99: concurrency.length === 0 ? null : Math.max(...concurrency)
    }
  }
}
