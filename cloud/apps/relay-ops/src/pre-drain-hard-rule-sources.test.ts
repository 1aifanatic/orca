import { describe, expect, it } from 'vitest'
import { relayOpsEnvironment } from './environment-config.js'
import {
  CELL_PROCESS_EXIT_METRIC,
  createPreDrainHardRuleReader
} from './pre-drain-hard-rule-sources.js'

const environment = relayOpsEnvironment('production')
const now = Date.parse('2026-10-01T12:00:00.000Z')

function points(values: number[], kind: 'int64Value' | 'doubleValue' = 'int64Value') {
  return values.map((value, index) => ({
    interval: { endTime: new Date(now - index * 60_000).toISOString() },
    value: { [kind]: kind === 'int64Value' ? String(value) : value }
  }))
}

function fakeMonitoring(series: {
  exits?: number[][]
  director503?: number[][]
  concurrency?: number[][]
  descriptorStatus?: number
}) {
  const requests: URL[] = []
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input))
    requests.push(url)
    if (url.pathname.includes('/metricDescriptors/')) {
      return new Response('{}', { status: series.descriptorStatus ?? 200 })
    }
    const filter = url.searchParams.get('filter') ?? ''
    const pick = filter.includes(CELL_PROCESS_EXIT_METRIC)
      ? (series.exits ?? []).map((values) => points(values))
      : filter.includes('request_count')
        ? (series.director503 ?? []).map((values) => points(values))
        : (series.concurrency ?? []).map((values) => points(values, 'doubleValue'))
    return Response.json({ timeSeries: pick.map((entry) => ({ points: entry })) })
  }
  return { fetchImpl, requests }
}

function reader(fetchImpl: typeof fetch) {
  return createPreDrainHardRuleReader(environment, async () => 'token', {
    fetchImpl,
    now: () => now
  })
}

describe('pre-drain hard rule reader', () => {
  it('sums exits, takes the busiest 503 minute, and the highest concurrency p99', async () => {
    const { fetchImpl } = fakeMonitoring({
      exits: [[0, 1], [2]],
      director503: [[40, 620, 55]],
      concurrency: [[12.5, 66.8]]
    })
    await expect(reader(fetchImpl)()).resolves.toEqual({
      cellProcessExits: 3,
      director503PeakPerMinute: 620,
      directorConcurrencyP99: 66.8
    })
  })

  it('reads empty counters as zero but an empty concurrency series as unknown', async () => {
    const { fetchImpl } = fakeMonitoring({})
    await expect(reader(fetchImpl)()).resolves.toEqual({
      cellProcessExits: 0,
      director503PeakPerMinute: 0,
      directorConcurrencyP99: null
    })
  })

  it('aligns each read per minute over its own lookback on the director service', async () => {
    const { fetchImpl, requests } = fakeMonitoring({ concurrency: [[1]] })
    await reader(fetchImpl)()
    const reads = requests.filter((url) => url.pathname.endsWith('/timeSeries'))
    expect(reads).toHaveLength(3)
    const byMetric = (needle: string): URL => {
      const url = reads.find((entry) => entry.searchParams.get('filter')?.includes(needle))
      if (!url) throw new Error(`no read for ${needle}`)
      return url
    }
    const exits = byMetric(CELL_PROCESS_EXIT_METRIC)
    expect(exits.searchParams.get('interval.startTime')).toBe('2026-10-01T11:50:00.000Z')
    expect(exits.searchParams.get('aggregation.perSeriesAligner')).toBe('ALIGN_SUM')
    const director503 = byMetric('run.googleapis.com/request_count')
    expect(director503.searchParams.get('filter')).toContain('metric.label."response_code"="503"')
    expect(director503.searchParams.get('filter')).toContain(
      `resource.label."service_name"="${environment.directorService}"`
    )
    expect(director503.searchParams.get('interval.startTime')).toBe('2026-10-01T11:50:00.000Z')
    expect(director503.searchParams.get('aggregation.perSeriesAligner')).toBe('ALIGN_DELTA')
    expect(director503.searchParams.get('aggregation.crossSeriesReducer')).toBe('REDUCE_SUM')
    const concurrency = byMetric('max_request_concurrencies')
    expect(concurrency.searchParams.get('interval.startTime')).toBe('2026-10-01T11:56:00.000Z')
    expect(concurrency.searchParams.get('aggregation.perSeriesAligner'))
      .toBe('ALIGN_PERCENTILE_99')
    for (const url of reads) {
      expect(url.searchParams.get('aggregation.alignmentPeriod')).toBe('60s')
      expect(url.searchParams.get('interval.endTime')).toBe('2026-10-01T12:00:00.000Z')
    }
  })

  // Why: a deleted or renamed log metric reads as an empty series, which is zero exits forever.
  it('refuses to count exits from a metric that does not exist', async () => {
    const { fetchImpl } = fakeMonitoring({ descriptorStatus: 404 })
    await expect(reader(fetchImpl)()).rejects.toThrow('Google telemetry returned 404')
  })

  it('checks the exit metric once, and again only after a failed check', async () => {
    let descriptorStatus = 500
    const { fetchImpl: base, requests } = fakeMonitoring({ concurrency: [[1]] })
    const fetchImpl: typeof fetch = async (input, init) => {
      if (String(input).includes('/metricDescriptors/')) {
        requests.push(new URL(String(input)))
        return new Response('{}', { status: descriptorStatus })
      }
      return await base(input, init)
    }
    const read = reader(fetchImpl)
    await expect(read()).rejects.toThrow('returned 500')
    descriptorStatus = 200
    await read()
    await read()
    expect(requests.filter((url) => url.pathname.includes('/metricDescriptors/')))
      .toHaveLength(2)
  })
})
