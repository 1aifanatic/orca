/**
 * Launch readiness against real agent screens, replayed byte for byte from captured transcripts
 * (`__fixtures__/*.txt`, recorded with `config/scripts/capture-agent-pty-transcript.mjs`).
 *
 * Each transcript is preceded by OSC 133;C, the command-start mark Orca's shell integration emits
 * just before the agent runs. The recorder spawns the agent directly, so the mark is not in the
 * capture itself.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TuiAgent } from '../../shared/tui-agent'
import { watchAgentComposerReady } from './agent-composer-ready-watch'
import { createTranscriptPane, TRANSCRIPT_PANE_PTY_ID } from './agent-transcript-pane-test-harness'

const COMMAND_START = '\x1b]133;C\x07'
const POLL_INTERVAL_MS = 2_000
const QUIESCENCE_MS = 3_000
const WAIT_MS = 20_000

function readCapture(name: string): { data: string; size: { cols: number; rows: number } } {
  const base = join(__dirname, '__fixtures__', name)
  const meta: { cols: number; rows: number } = JSON.parse(readFileSync(`${base}.meta.json`, 'utf8'))
  return { data: readFileSync(`${base}.txt`, 'utf8'), size: { cols: meta.cols, rows: meta.rows } }
}

type WaitOutcome = { satisfied: boolean; blockedReason: unknown } | 'timeout'

/** Paints `bytes` into a fresh pane, then runs both waits over the same fake clock. */
async function replay(
  agent: TuiAgent,
  name: string,
  title: string,
  bytes?: string,
  grid?: { cols: number; rows: number }
) {
  const { data, size } = readCapture(name)
  const { runtime, handle } = await createTranscriptPane({
    paneTitle: title,
    foregroundProcess: agent,
    launchAgent: agent,
    size: grid ?? size,
    data: ''
  })
  // Why after creation: the pane's own set-up awaits real timers.
  vi.useFakeTimers()
  runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, bytes ?? `${COMMAND_START}${data}`, Date.now())
  const settle = (wait: Promise<unknown>): Promise<WaitOutcome> =>
    wait.then(
      (result) => {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: both waits resolve a RuntimeTerminalWait; only these two fields are compared.
        const read = result as { satisfied?: boolean; blockedReason?: unknown }
        return { satisfied: read.satisfied === true, blockedReason: read.blockedReason ?? null }
      },
      () => 'timeout' as const
    )
  const launch = settle(
    runtime.waitForTerminal(handle, {
      condition: 'tui-idle',
      timeoutMs: WAIT_MS,
      acceptComposerReady: true
    })
  )
  const plain = settle(
    runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: WAIT_MS })
  )
  await vi.advanceTimersByTimeAsync(WAIT_MS + POLL_INTERVAL_MS)
  return { launch: await launch, plain: await plain }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('launch readiness on a declared composer-quiet agent (goose)', () => {
  // goose sets no title tui-idle recognises and paints no ready screen it knows, so tui-idle alone
  // never settles; it enables bracketed paste once its composer is up.
  it('settles on the captured goose composer, where a plain tui-idle wait times out', async () => {
    const { launch, plain } = await replay('goose', 'goose-composer-ready', 'goose')
    expect(launch).toEqual({ satisfied: true, blockedReason: null })
    expect(plain).toBe('timeout')
  })

  it('settles within one quiet window and two polls of the last paint', async () => {
    const { data, size } = readCapture('goose-composer-ready')
    const { runtime, handle } = await createTranscriptPane({
      paneTitle: 'goose',
      foregroundProcess: 'goose',
      launchAgent: 'goose',
      size,
      data: ''
    })
    vi.useFakeTimers()
    runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, `${COMMAND_START}${data}`, Date.now())
    const settled = vi.fn()
    void runtime
      .waitForTerminal(handle, {
        condition: 'tui-idle',
        timeoutMs: WAIT_MS,
        acceptComposerReady: true
      })
      .then(settled, () => {})

    await vi.advanceTimersByTimeAsync(QUIESCENCE_MS - 500)
    expect(settled).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2)
    expect(settled).toHaveBeenCalledWith(expect.objectContaining({ satisfied: true }))
  })

  it("never counts the shell's own bracketed paste as the agent's composer", async () => {
    // The shell arms 2004 for its own prompt; with no command-start mark the agent never owned the
    // PTY, so the launch wait must not settle into a shell that would run the pasted prompt.
    const shellPrompt = '\x1b]133;A\x07~/repo $ \x1b[?2004h'
    const { launch } = await replay('goose', 'goose-composer-ready', 'goose', shellPrompt)
    expect(launch).toBe('timeout')
  })

  it('stays exactly tui-idle under a shell that marks no commands (fish, cmd)', async () => {
    // No 133;C means no proof the agent owns the PTY, even with a real goose composer on screen.
    const { data } = readCapture('goose-composer-ready')
    const { launch } = await replay(
      'goose',
      'goose-composer-ready',
      'goose',
      `~/repo $ goose\r\n${data}`
    )
    expect(launch).toBe('timeout')
  })
})

describe('launch readiness on undeclared agents', () => {
  // No launchReadiness declaration, so a launch wait is exactly a plain one. aider's capture ran with
  // --yes-always; in manual mode its `.gitignore` (Y)es/(N)o question arms bracketed paste as well.
  it.each([
    ['aider', 'aider-composer-ready', 'aider'],
    ['claude', 'claude-composer-ready', '✳ Claude Code']
  ] as const)('gives the %s capture the plain verdict', async (agent, name, title) => {
    const { launch, plain } = await replay(agent, name, title)
    expect(launch).toEqual(plain)
  })

  it('leaves aider at "not ready" even with its composer on screen', async () => {
    const { launch } = await replay('aider', 'aider-composer-ready', 'aider')
    expect(launch).toBe('timeout')
  })
})

describe('launch readiness on a declared composer-marker agent (opencode)', () => {
  // The marker, read only while the agent owns the PTY, is what the watch reports ready on.
  it('reads the captured opencode composer marker, and nothing before it', () => {
    const { data } = readCapture('opencode-composer-ready')
    const markerAt = data.indexOf('\x1b[?25h', data.indexOf('\x1b[?2004h'))
    let emit: (chunk: string) => void = () => {}
    const composer = watchAgentComposerReady('opencode', {
      subscribeToData: (listener) => {
        emit = listener
        return () => {}
      },
      readRecentOutput: () => undefined
    })
    emit(`${COMMAND_START}${data.slice(0, markerAt)}`)
    expect(composer?.signal()).toBe('pending')
    emit(data.slice(markerAt))
    expect(composer?.signal()).toBe('ready')
  })
})

describe("launch readiness on Codex, which the live screen's header rule owns", () => {
  // Codex declares nothing: its header, read from the tail or the live screen, is tier-1 evidence
  // that already settles every capture. Its `›` composer paints while the header still says
  // `loading`, so a second Codex rule could only disagree with the header rule.
  const CODEX_CAPTURES = [
    'codex-0157-plain-ready',
    'codex-0157-effort-override-embedded-warning',
    'codex-0157-config-override-embedded-warning',
    'codex-0157-no-daemon-effort-override'
  ]

  it.each(CODEX_CAPTURES)('settles a launch wait on %s exactly as a plain wait', async (name) => {
    const { launch, plain } = await replay('codex', name, 'Terminal')
    expect(launch).toEqual({ satisfied: true, blockedReason: null })
    expect(launch).toEqual(plain)
  })

  it('keeps the plain answer where a mismatched grid garbles the header', async () => {
    // The composer glyph is on screen, but the header rule cannot confirm readiness at 80x24.
    const { launch, plain } = await replay(
      'codex',
      'codex-0157-effort-override-embedded-warning',
      'Terminal',
      undefined,
      { cols: 80, rows: 24 }
    )
    expect(plain).toBe('timeout')
    expect(launch).toBe('timeout')
  })
})

describe('launch readiness on a name-only title that arrives before the composer', () => {
  // OpenCode paints its `OpenCode` title (byte 6814) before it mounts its composer (the first
  // show-cursor after 2004, byte 9559). A plain wait settles on that title; a launch must not.
  it('waits for the composer marker, then settles', async () => {
    const { data, size } = readCapture('opencode-composer-ready')
    const marker = data.indexOf('\x1b[?25h')
    const { runtime, handle } = await createTranscriptPane({
      paneTitle: 'OpenCode',
      foregroundProcess: 'opencode',
      launchAgent: 'opencode',
      size,
      data: ''
    })
    vi.useFakeTimers()
    runtime.onPtyData(
      TRANSCRIPT_PANE_PTY_ID,
      `${COMMAND_START}${data.slice(0, marker)}`,
      Date.now()
    )
    const settled = vi.fn()
    void runtime
      .waitForTerminal(handle, {
        condition: 'tui-idle',
        timeoutMs: WAIT_MS,
        acceptComposerReady: true
      })
      .then(settled, () => {})

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 4)
    expect(settled).not.toHaveBeenCalled()

    runtime.onPtyData(TRANSCRIPT_PANE_PTY_ID, data.slice(marker), Date.now())
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS)
    expect(settled).toHaveBeenCalledWith(expect.objectContaining({ satisfied: true }))
  })
})

describe("Claude's trust dialog under a launch-readiness wait", () => {
  // Claude sets no title before this dialog and gets no composer watcher; the rendered-screen check
  // on the poll is what reports the dialog.
  it.each(['claude-dialog-trust-workspace', 'claude-dialog-trust-workspace-narrow'])(
    'reports %s as blocked, never as ready',
    async (name) => {
      const { launch } = await replay('claude', name, 'Terminal')
      expect(launch).toEqual({ satisfied: false, blockedReason: 'agent-trust-workspace' })
    }
  )
})
