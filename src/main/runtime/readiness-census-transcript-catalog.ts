// Every recorded agent screen the readiness census replays, with the grid and process it ran under.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TuiAgent } from '../../shared/tui-agent'
import { GROK_STARTUP_PTY_TRACE } from '../../shared/__fixtures__/grok-startup-pty-trace'
import { GROK_INLINE_STARTUP_PTY_TRACE } from '../../shared/__fixtures__/grok-inline-startup-pty-trace'
import type { GrokStartupTraceChunk } from '../../shared/__fixtures__/grok-startup-pty-trace'
import {
  readRuntimeFixture,
  splitTranscriptIntoChunks
} from './agent-transcript-replay-test-harness'

export type CensusTranscript = {
  name: string
  /** Null for a non-agent recording, which only the agent-unknown pane replays. */
  agent: TuiAgent | null
  foregroundProcess: string
  cols: number
  rows: number
  /** Recorded PTY chunk boundaries when the capture kept them, else the replay harness's. */
  chunks: () => readonly string[]
  /** Which panes replay it; a long recording splits them across workers. Default: both. */
  panes?: 'agent' | 'unknown'
}

type FixtureMeta = { cols: number; rows: number }

const RUNTIME_FIXTURES = join(__dirname, '__fixtures__')
const DAEMON_FIXTURES = join(__dirname, '..', 'daemon', '__fixtures__', 'pty-transcripts')

function readMeta(dir: string, name: string): FixtureMeta {
  const meta: unknown = JSON.parse(readFileSync(join(dir, `${name}.meta.json`), 'utf8'))
  if (
    typeof meta !== 'object' ||
    meta === null ||
    !('cols' in meta) ||
    !('rows' in meta) ||
    typeof meta.cols !== 'number' ||
    typeof meta.rows !== 'number'
  ) {
    throw new Error(`${name}: meta.json has no grid`)
  }
  return { cols: meta.cols, rows: meta.rows }
}

/** `<name>.timing.json` holds each recorded chunk as [ms since spawn, UTF-16 length]. */
function recordedChunks(name: string, data: string): readonly string[] {
  let timing: unknown
  try {
    timing = JSON.parse(readFileSync(join(RUNTIME_FIXTURES, `${name}.timing.json`), 'utf8'))
  } catch {
    return splitTranscriptIntoChunks(data)
  }
  const lengths =
    typeof timing === 'object' && timing !== null && 'chunks' in timing ? timing.chunks : undefined
  if (!Array.isArray(lengths)) {
    throw new Error(`${name}: timing.json has no chunks`)
  }
  const chunks: string[] = []
  let offset = 0
  for (const entry of lengths) {
    const length: unknown = Array.isArray(entry) ? entry[1] : undefined
    if (typeof length !== 'number') {
      throw new Error(`${name}: malformed timing chunk`)
    }
    chunks.push(data.slice(offset, offset + length))
    offset += length
  }
  if (offset !== data.length) {
    throw new Error(`${name}: timing covers ${offset} of ${data.length} chars`)
  }
  return chunks
}

function runtimeTranscript(
  name: string,
  agent: TuiAgent,
  foregroundProcess: string
): CensusTranscript {
  const { cols, rows } = readMeta(RUNTIME_FIXTURES, name)
  return {
    name,
    agent,
    foregroundProcess,
    cols,
    rows,
    chunks: () => recordedChunks(name, readRuntimeFixture(name))
  }
}

function daemonTranscript(
  name: string,
  agent: TuiAgent | null,
  foregroundProcess: string
): CensusTranscript {
  const { cols, rows } = readMeta(DAEMON_FIXTURES, name)
  return {
    name: `daemon/${name}`,
    agent,
    foregroundProcess,
    cols,
    rows,
    chunks: () =>
      splitTranscriptIntoChunks(readFileSync(join(DAEMON_FIXTURES, `${name}.txt`), 'utf8'))
  }
}

// Why filler of the recorded length: the trace elides marker-free animation frames to a byte count.
function grokTranscript(name: string, trace: readonly GrokStartupTraceChunk[]): CensusTranscript {
  return {
    name: `grok/${name}`,
    agent: 'grok',
    foregroundProcess: 'grok',
    // Both traces record 120x30 (see their headers).
    cols: 120,
    rows: 30,
    chunks: () => trace.map((chunk) => chunk.data ?? 'x'.repeat(chunk.bytes ?? 0))
  }
}

function fixtureNames(prefix: string): string[] {
  return FIXTURE_NAMES.filter((name) => name.startsWith(prefix))
}

// Why a literal list, not a directory scan: a new recording must be added (and its baseline
// generated) deliberately; the coverage test below fails on a fixture nobody listed.
export const FIXTURE_NAMES = [
  'antigravity-1-2-14-busy-streaming',
  'antigravity-1-2-14-busy-thinking',
  'antigravity-1-2-14-command-palette',
  'antigravity-1-2-14-draft',
  'antigravity-1-2-14-model-picker',
  'antigravity-1-2-14-picker-dismissed',
  'antigravity-1-2-14-ready',
  'antigravity-1-2-14-ready-80x24',
  'antigravity-1-2-14-ready-accept-edits',
  'antigravity-1-2-14-ready-plan',
  'antigravity-1-2-14-trust-dialog',
  'antigravity-1-2-14-turn-ended',
  'antigravity-busy-mid-turn',
  'antigravity-busy-turn-ended',
  'antigravity-dialog-command-palette',
  'antigravity-dialog-dismissed',
  'antigravity-dialog-model-picker',
  'antigravity-dialog-trust-workspace',
  'antigravity-ready-account-info-hidden',
  'antigravity-ready-api-key-gemini-model',
  'claude-dialog-trust-workspace',
  'claude-dialog-trust-workspace-answered',
  'claude-dialog-trust-workspace-narrow',
  'cline-3-0-65-win32-startup',
  'cline-3-0-66-busy-streaming',
  'cline-3-0-66-draft',
  'cline-3-0-66-permission',
  'cline-3-0-66-promo',
  'cline-3-0-66-ready',
  'cline-3-0-66-ready-80x24',
  'cline-3-0-66-ready-plan',
  'cline-3-0-66-slash-menu',
  'cline-3-0-66-turn-ended',
  'codex-0-150-1-turn',
  'codex-0-155-1-timed-turn',
  'codex-0-157-1-timed-sleep-turn',
  'codex-0-157-1-update-dialog',
  'codex-0-158-0-approval',
  'codex-0-158-0-timed-turn',
  'codex-0-158-0-trustprompt',
  'codex-0157-config-override-embedded-warning',
  'codex-0157-effort-override-embedded-warning',
  'codex-0157-fresh-home-daemon-install',
  'codex-0157-hooks-review-dialog',
  'codex-0157-model-retired-dialog',
  'codex-0157-no-daemon-effort-override',
  'codex-0157-plain-ready',
  'codex-0157-update-available-dialog',
  'codex-0158-fresh-home-greeting',
  'codex-0158-hooks-review-dialog',
  'codex-0158-model-announcement-dialog',
  'codex-0158-model-retired-dialog',
  'codex-0158-update-available-dialog',
  'cursor-agent-approval-prompt',
  'cursor-agent-idle-after-approval',
  'cursor-agent-long-tool-call',
  'dsh-tui-ready-no-key',
  'freebuff-lifecycle',
  'freebuff-login',
  'freebuff-ready',
  'freebuff-trust',
  'hermes-tui-ready',
  'muse-empty-folder-ready',
  'omp-native-title-win32',
  'prime-agent-0-9-5-ready',
  'prime-agent-0-9-5-turn',
  'prime-agent-0-9-8-busy-streaming',
  'prime-agent-0-9-8-draft',
  'prime-agent-0-9-8-ready',
  'prime-agent-0-9-8-ready-80x24',
  'prime-agent-0-9-8-ready-after-question',
  'prime-agent-0-9-8-slash-menu',
  'prime-agent-0-9-8-tool-turn',
  'prime-agent-0-9-8-trace-question',
  'prime-agent-0-9-8-turn-ended',
  'qoder-no-account',
  'qoder-ready',
  'qoder-trust-dialog',
  'zcode-composer-ready',
  'zcode-missing-tui'
] as const

// Why 80x24: the Cursor files are clipboard copies of screens with no meta.json; this is the
// grid the runtime's emulator defaults to (agent-transcript-pane-test-harness.ts).
function cursorTranscript(name: string): CensusTranscript {
  return {
    name,
    agent: 'cursor',
    foregroundProcess: 'cursor-agent',
    cols: 80,
    rows: 24,
    chunks: () => splitTranscriptIntoChunks(readRuntimeFixture(name))
  }
}

export type CensusFamily =
  | 'antigravity'
  | 'cline'
  | 'codex'
  | 'prime-agent'
  | 'claude-cursor-qoder'
  | 'prime-agent-question-agent'
  | 'prime-agent-question-unknown'
  | 'long-startups'
  | 'others'

export function censusTranscripts(family: CensusFamily): CensusTranscript[] {
  switch (family) {
    case 'antigravity':
      return fixtureNames('antigravity-').map((name) =>
        runtimeTranscript(name, 'antigravity', 'agy')
      )
    case 'cline':
      return fixtureNames('cline-').map((name) => runtimeTranscript(name, 'cline', 'cline'))
    case 'codex':
      return fixtureNames('codex-').map((name) => runtimeTranscript(name, 'codex', 'codex'))
    case 'prime-agent':
      // Why apart: ready-after-question alone is ~600 KB, so it gets its own worker.
      return fixtureNames('prime-agent-')
        .filter((name) => name !== 'prime-agent-0-9-8-ready-after-question')
        .map((name) => runtimeTranscript(name, 'prime-agent', 'prime-agent'))
    case 'claude-cursor-qoder':
      return [
        ...fixtureNames('claude-').map((name) => runtimeTranscript(name, 'claude', 'claude')),
        ...fixtureNames('cursor-agent-').map(cursorTranscript),
        ...fixtureNames('qoder-').map((name) => runtimeTranscript(name, 'qoder', 'qodercli'))
      ]
    case 'prime-agent-question-agent':
    case 'prime-agent-question-unknown': {
      // Why one pane group per worker: this ~600 KB recording is ~9k frames.
      const panes = family === 'prime-agent-question-agent' ? 'agent' : 'unknown'
      const transcript = runtimeTranscript(
        'prime-agent-0-9-8-ready-after-question',
        'prime-agent',
        'prime-agent'
      )
      return [{ ...transcript, name: `${transcript.name}@${panes}`, panes }]
    }
    case 'long-startups':
      return [
        runtimeTranscript('zcode-composer-ready', 'zcode', 'zcode'),
        runtimeTranscript('freebuff-lifecycle', 'freebuff', 'freebuff')
      ]
    case 'others':
      return [
        runtimeTranscript('dsh-tui-ready-no-key', 'dsh', 'dsh-tui'),
        ...fixtureNames('freebuff-')
          .filter((name) => name !== 'freebuff-lifecycle')
          .map((name) => runtimeTranscript(name, 'freebuff', 'freebuff')),
        runtimeTranscript('hermes-tui-ready', 'hermes', 'hermes'),
        runtimeTranscript('muse-empty-folder-ready', 'muse', 'muse'),
        runtimeTranscript('omp-native-title-win32', 'omp', 'omp'),
        runtimeTranscript('zcode-missing-tui', 'zcode', 'zcode'),
        daemonTranscript('opencode', 'opencode', 'opencode'),
        daemonTranscript('opencode-run', 'opencode', 'opencode'),
        // Non-agent screens: controls for the agent-unknown pane.
        daemonTranscript('less', null, 'less'),
        daemonTranscript('nano', null, 'nano'),
        daemonTranscript('vim', null, 'vim'),
        grokTranscript('startup', GROK_STARTUP_PTY_TRACE),
        grokTranscript('inline-startup', GROK_INLINE_STARTUP_PTY_TRACE)
      ]
  }
}

export const CENSUS_FAMILIES: readonly CensusFamily[] = [
  'antigravity',
  'cline',
  'codex',
  'prime-agent',
  'claude-cursor-qoder',
  'prime-agent-question-agent',
  'prime-agent-question-unknown',
  'long-startups',
  'others'
]
