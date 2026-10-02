import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let hermesHome: string | null = null
let extraTempDirs: string[] = []
const previousHermesHome = process.env.HERMES_HOME
const fakeDbRows = vi.hoisted(() => ({
  sessions: [] as Record<string, unknown>[],
  messages: [] as Record<string, unknown>[]
}))
// Stands in for the worker reads; the SQL is covered by readers/hermes-session-runs.test.ts.
const fakeReads = vi.hoisted(() => ({
  refs: vi.fn(async (_dbPath: string, _jobId: string): Promise<Record<string, unknown>[]> => []),
  runs: vi.fn(async (_dbPath: string, _runIds: readonly string[]): Promise<unknown[]> => [])
}))

vi.mock('../foreign-sqlite-readers/foreign-sqlite-reader-spawn', () => ({
  readHermesSessionRunRefRows: fakeReads.refs,
  readHermesSessionRuns: fakeReads.runs
}))

function serveFakeRows(): void {
  fakeReads.refs.mockImplementation(async () =>
    fakeDbRows.sessions.map((session) => ({ id: session.id, started_at: session.started_at }))
  )
  fakeReads.runs.mockImplementation(async (_dbPath, runIds) =>
    runIds.flatMap((id) => {
      const session = fakeDbRows.sessions.find((row) => row.id === id)
      return session
        ? [{ id, session, messages: fakeDbRows.messages.filter((row) => row.session_id === id) }]
        : []
    })
  )
}

async function loadReader() {
  vi.resetModules()
  return import('./hermes-cron-output')
}

async function createHermesHome(): Promise<string> {
  hermesHome = await mkdtemp(join(tmpdir(), 'orca-hermes-output-'))
  process.env.HERMES_HOME = hermesHome
  return hermesHome
}

beforeEach(() => {
  fakeDbRows.sessions = []
  fakeDbRows.messages = []
  fakeReads.refs.mockReset()
  fakeReads.runs.mockReset()
  serveFakeRows()
})

afterEach(async () => {
  if (previousHermesHome === undefined) {
    delete process.env.HERMES_HOME
  } else {
    process.env.HERMES_HOME = previousHermesHome
  }
  if (hermesHome) {
    await rm(hermesHome, { recursive: true, force: true })
    hermesHome = null
  }
  await Promise.all(extraTempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  extraTempDirs = []
  vi.resetModules()
})

describe('readHermesCronOutputRunsPage', () => {
  it('attaches the state.db transcript to the matching Hermes output file run', async () => {
    const home = await createHermesHome()
    const outputDir = join(home, 'cron', 'output', 'job-1')
    const scriptLogPath = join(home, 'Automations', 'x-automation', 'logs', 'x-monitor.log')
    await mkdir(outputDir, { recursive: true })
    await mkdir(dirname(scriptLogPath), { recursive: true })
    await writeFile(scriptLogPath, 'raw script log line\nsecond raw script log line\n', 'utf-8')
    await writeFile(
      join(outputDir, '2026-05-15_09-02-00.md'),
      `# Cron Job: Monitor automation

**Job ID:** job-1

## Response

Success — ./run-x-monitor.sh completed with exit code 0.
Latest log path: ${scriptLogPath}
Run summary: monitor automation completed successfully.
`,
      'utf-8'
    )

    await writeFile(join(home, 'state.db'), '', 'utf-8')
    fakeDbRows.sessions = [
      {
        id: 'cron_job-1_20260515_090000',
        title: 'Monitor automation',
        started_at: Date.UTC(2026, 4, 15, 9, 0, 0) / 1000,
        ended_at: Date.UTC(2026, 4, 15, 9, 1, 58) / 1000,
        model: 'gpt-5',
        message_count: 2,
        input_tokens: 100,
        output_tokens: 50
      }
    ]
    fakeDbRows.messages = [
      {
        session_id: 'cron_job-1_20260515_090000',
        role: 'tool',
        content: 'full command output line',
        tool_name: 'terminal',
        timestamp: Date.UTC(2026, 4, 15, 9, 1, 0) / 1000
      }
    ]

    const { readHermesCronOutputRunsPage } = await loadReader()
    const page = await readHermesCronOutputRunsPage('job-1', { page: 1, pageSize: 25 })

    expect(page.total).toBe(1)
    expect(page.runs[0]).toMatchObject({
      id: 'job-1:2026-05-15_09-02-00.md',
      status: 'completed',
      output_path: join(outputDir, '2026-05-15_09-02-00.md')
    })
    expect((page.runs[0] as { output_content?: string }).output_content).toContain(
      'monitor automation completed successfully.'
    )
    expect((page.runs[0] as { output_content?: string }).output_content).toContain(
      '## Latest log file'
    )
    expect((page.runs[0] as { output_content?: string }).output_content).toContain(
      'raw script log line'
    )
    expect((page.runs[0] as { output_content?: string }).output_content).toContain(
      '## Full session log'
    )
    expect((page.runs[0] as { output_content?: string }).output_content).toContain(
      'full command output line'
    )
  })

  it('builds large response previews without broad regex captures', async () => {
    const home = await createHermesHome()
    const outputDir = join(home, 'cron', 'output', 'job-1')
    await mkdir(outputDir, { recursive: true })
    await writeFile(
      join(outputDir, '2026-05-15_09-02-00.md'),
      [
        '# Cron Job: Monitor automation',
        '',
        '## Response',
        '',
        '```',
        'hidden-token\n'.repeat(500),
        '```',
        '',
        'Visible response text '.repeat(500),
        ''
      ].join('\n'),
      'utf-8'
    )

    const { readHermesCronOutputRunsPage } = await loadReader()
    const execSpy = vi.spyOn(RegExp.prototype, 'exec')
    const replaceSpy = vi.spyOn(String.prototype, 'replace')
    const page = await readHermesCronOutputRunsPage('job-1', { page: 1, pageSize: 25 })
    const usedBroadCapture = execSpy.mock.contexts.some(
      (pattern) => pattern instanceof RegExp && pattern.source.includes('[\\s\\S]')
    )
    const usedWhitespaceReplace = replaceSpy.mock.calls.some(
      ([pattern]) => pattern instanceof RegExp && pattern.source === '\\s+'
    )

    expect(usedBroadCapture).toBe(false)
    expect(usedWhitespaceReplace).toBe(false)
    expect((page.runs[0] as { output_preview?: string }).output_preview).toContain(
      'Visible response text'
    )
    expect((page.runs[0] as { output_preview?: string }).output_preview).not.toContain(
      'hidden-token'
    )
  })

  it('does not hydrate referenced logs outside Hermes home', async () => {
    const home = await createHermesHome()
    const outputDir = join(home, 'cron', 'output', 'job-1')
    const outsideDir = await mkdtemp(join(tmpdir(), 'orca-hermes-outside-'))
    extraTempDirs.push(outsideDir)
    const outsideLogPath = join(outsideDir, 'secret.log')
    await mkdir(outputDir, { recursive: true })
    await writeFile(outsideLogPath, 'do not expose this\n', 'utf-8')
    await writeFile(
      join(outputDir, '2026-05-15_09-02-00.md'),
      `# Cron Job: Monitor automation

## Response

Latest log path: ${outsideLogPath}
Run summary: monitor automation completed successfully.
`,
      'utf-8'
    )

    const { readHermesCronOutputRunsPage } = await loadReader()
    const page = await readHermesCronOutputRunsPage('job-1', { page: 1, pageSize: 25 })

    expect((page.runs[0] as { output_content?: string }).output_content).not.toContain(
      '## Latest log file'
    )
    expect((page.runs[0] as { output_content?: string }).output_content).not.toContain(
      'do not expose this'
    )
  })

  it('hydrates referenced logs in valid dot-dot-prefixed Hermes subdirectories', async () => {
    const home = await createHermesHome()
    const outputDir = join(home, 'cron', 'output', 'job-1')
    const scriptLogPath = join(home, '..logs', 'x-monitor.log')
    await mkdir(outputDir, { recursive: true })
    await mkdir(dirname(scriptLogPath), { recursive: true })
    await writeFile(scriptLogPath, 'dot-dot-prefixed log line\n', 'utf-8')
    await writeFile(
      join(outputDir, '2026-05-15_09-02-00.md'),
      `# Cron Job: Monitor automation

## Response

Latest log path: ${scriptLogPath}
Run summary: monitor automation completed successfully.
`,
      'utf-8'
    )

    const { readHermesCronOutputRunsPage } = await loadReader()
    const page = await readHermesCronOutputRunsPage('job-1', { page: 1, pageSize: 25 })

    expect((page.runs[0] as { output_content?: string }).output_content).toContain(
      '## Latest log file'
    )
    expect((page.runs[0] as { output_content?: string }).output_content).toContain(
      'dot-dot-prefixed log line'
    )
  })

  it('uses a count-only path when page size is zero', async () => {
    const home = await createHermesHome()
    const outputDir = join(home, 'cron', 'output', 'job-1')
    await mkdir(outputDir, { recursive: true })
    await writeFile(
      join(outputDir, '2026-05-15_09-02-00.md'),
      'this content should not be read for count-only listing',
      'utf-8'
    )
    await writeFile(join(home, 'state.db'), '', 'utf-8')
    fakeDbRows.sessions = [
      {
        id: 'cron_job-1_20260515_090000',
        started_at: Date.UTC(2026, 4, 15, 9, 0, 0) / 1000
      }
    ]
    fakeDbRows.messages = [
      {
        session_id: 'cron_job-1_20260515_090000',
        role: 'tool',
        content: 'full command output line'
      }
    ]

    const { readHermesCronOutputRunsPage } = await loadReader()
    const page = await readHermesCronOutputRunsPage('job-1', { page: 1, pageSize: 0 })

    expect(page).toEqual({ total: 1, runs: [] })
    expect(fakeReads.runs).not.toHaveBeenCalled()
  })

  it('skips date sorting for counts while keeping paginated runs newest first', async () => {
    const home = await createHermesHome()
    await writeFile(join(home, 'state.db'), '')
    fakeDbRows.sessions = [
      { id: 'cron_job-1_older', started_at: 1000 },
      { id: 'cron_job-1_newer', started_at: 2000 }
    ]
    const { readHermesCronOutputRunsPage } = await loadReader()
    const parse = vi.spyOn(Date, 'parse')
    try {
      await expect(
        readHermesCronOutputRunsPage('job-1', { page: 1, pageSize: 0 })
      ).resolves.toEqual({
        total: 2,
        runs: []
      })
      expect(parse).not.toHaveBeenCalled()
    } finally {
      parse.mockRestore()
    }
    const page = await readHermesCronOutputRunsPage('job-1', { page: 1, pageSize: 1 })
    expect(page.total).toBe(2)
    expect(page.runs).toMatchObject([{ id: 'cron_job-1_newer' }])
  })

  it('caches count-only reads until the cache is cleared', async () => {
    const home = await createHermesHome()
    const outputDir = join(home, 'cron', 'output', 'job-1')
    await mkdir(outputDir, { recursive: true })
    await writeFile(join(outputDir, '2026-05-15_09-02-00.md'), 'first run', 'utf-8')

    const { clearHermesCronOutputRunCountCache, readHermesCronOutputRunsPage } = await loadReader()
    await expect(readHermesCronOutputRunsPage('job-1', { page: 1, pageSize: 0 })).resolves.toEqual({
      total: 1,
      runs: []
    })

    await writeFile(join(outputDir, '2026-05-15_09-03-00.md'), 'second run', 'utf-8')
    await expect(readHermesCronOutputRunsPage('job-1', { page: 1, pageSize: 0 })).resolves.toEqual({
      total: 1,
      runs: []
    })

    clearHermesCronOutputRunCountCache('job-1')
    await expect(readHermesCronOutputRunsPage('job-1', { page: 1, pageSize: 0 })).resolves.toEqual({
      total: 2,
      runs: []
    })
  })

  it('evicts oldest count cache entries when many job ids are observed', async () => {
    const home = await createHermesHome()
    const outputDir = join(home, 'cron', 'output', 'job-0')
    await mkdir(outputDir, { recursive: true })
    await writeFile(join(outputDir, '2026-05-15_09-02-00.md'), 'first run', 'utf-8')

    const { readHermesCronOutputRunsPage } = await loadReader()
    await expect(readHermesCronOutputRunsPage('job-0', { page: 1, pageSize: 0 })).resolves.toEqual({
      total: 1,
      runs: []
    })

    for (let i = 1; i <= 200; i += 1) {
      await readHermesCronOutputRunsPage(`job-${i}`, { page: 1, pageSize: 0 })
    }
    await writeFile(join(outputDir, '2026-05-15_09-03-00.md'), 'second run', 'utf-8')

    await expect(readHermesCronOutputRunsPage('job-0', { page: 1, pageSize: 0 })).resolves.toEqual({
      total: 2,
      runs: []
    })
  })

  it('reads a page of session runs in one worker request', async () => {
    const home = await createHermesHome()
    await writeFile(join(home, 'state.db'), '')
    fakeDbRows.sessions = [1, 2, 3].map((n) => ({
      id: `cron_job-1_run${n}`,
      title: `Run ${n}`,
      started_at: 1000 * n,
      ended_at: 1000 * n + 10
    }))
    const { readHermesCronOutputRunsPage } = await loadReader()
    const page = await readHermesCronOutputRunsPage('job-1', { page: 1, pageSize: 25 })

    expect(fakeReads.runs).toHaveBeenCalledTimes(1)
    expect(fakeReads.runs).toHaveBeenCalledWith(join(home, 'state.db'), [
      'cron_job-1_run3',
      'cron_job-1_run2',
      'cron_job-1_run1'
    ])
    expect(page.runs).toMatchObject([
      { id: 'cron_job-1_run3', status: 'completed', output_preview: 'Run 3' },
      { id: 'cron_job-1_run2', status: 'completed' },
      { id: 'cron_job-1_run1', status: 'completed' }
    ])
  })

  it('skips the worker when state.db is absent', async () => {
    await createHermesHome()
    fakeDbRows.sessions = [{ id: 'cron_job-1_run1', started_at: 1000 }]
    const { readHermesCronOutputRunsPage } = await loadReader()
    await expect(readHermesCronOutputRunsPage('job-1', { page: 1, pageSize: 25 })).resolves.toEqual(
      { total: 0, runs: [] }
    )
    expect(fakeReads.refs).not.toHaveBeenCalled()
    expect(fakeReads.runs).not.toHaveBeenCalled()
  })

  it('keeps output-file runs when the worker answers its failure values', async () => {
    const home = await createHermesHome()
    const outputDir = join(home, 'cron', 'output', 'job-1')
    await mkdir(outputDir, { recursive: true })
    await writeFile(join(outputDir, '2026-05-15_09-02-00.md'), '# Cron Job: x\n', 'utf-8')
    await writeFile(join(home, 'state.db'), '')
    fakeDbRows.sessions = [{ id: 'cron_job-1_20260515_090000', started_at: 1000 }]
    // [] from the run read is what the client resolves to on a timeout, crash or unreadable db.
    fakeReads.runs.mockImplementation(async () => [])
    const { readHermesCronOutputRunsPage } = await loadReader()
    const withRefs = await readHermesCronOutputRunsPage('job-1', { page: 1, pageSize: 25 })
    expect(withRefs.runs.length).toBeGreaterThan(0)
    expect(withRefs.runs.every((run) => run !== null)).toBe(true)

    fakeReads.refs.mockImplementation(async () => [])
    const { readHermesCronOutputRunsPage: readAgain } = await loadReader()
    await expect(readAgain('job-1', { page: 1, pageSize: 25 })).resolves.toMatchObject({
      total: 1,
      runs: [
        {
          id: 'job-1:2026-05-15_09-02-00.md',
          output_path: join(outputDir, '2026-05-15_09-02-00.md')
        }
      ]
    })
  })
})
