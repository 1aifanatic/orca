import { describe, expect, it, vi } from 'vitest'
import { createTranscriptPane } from './agent-transcript-pane-test-harness'
import {
  finalTranscriptFrame,
  readTranscriptFixture,
  replayTranscript
} from './agent-transcript-replay-test-harness'
import { detectTerminalWaitBlockedReason, isKnownReadyPromptBody } from './terminal-wait-detection'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

// codex-cli 0.158.0 recordings at 120x40 on a fresh CODEX_HOME (see each .meta.json).
const GREETING = 'codex-0158-fresh-home-greeting'
const MODEL_ANNOUNCEMENT = 'codex-0158-model-announcement-dialog'
// Codex's default status row opens with `<model> <effort> ·`; only the live chat paints it.
const LIVE_STATUS_ROW_RE = /\b(?:default|minimal|low|medium|high|xhigh) · /

function showsLiveStatusRow(screenLines: string[]): boolean {
  return screenLines.some((line) => LIVE_STATUS_ROW_RE.test(line.toLowerCase()))
}

describe('Codex 0.158 readiness from captured bytes', () => {
  it('reads the unlabelled greeting header as ready only once the live chat has taken over', async () => {
    let provisionalFrames = 0
    for await (const frame of replayTranscript(readTranscriptFixture(GREETING), 120, 40)) {
      if (showsLiveStatusRow(frame.screenLines)) {
        break
      }
      provisionalFrames += 1
      expect(isKnownReadyPromptBody(frame.waitText, 'codex', () => frame.screenLines)).toBe(false)
    }
    // Presence precondition: the provisional greeting screen was actually exercised.
    expect(provisionalFrames).toBeGreaterThan(10)
    const last = await finalTranscriptFrame(GREETING, 120, 40)
    expect(last.screenLines.join('\n')).not.toMatch(/model:|directory:/)
    expect(isKnownReadyPromptBody(last.waitText, 'codex', () => last.screenLines)).toBe(true)
  })

  it('does not read a greeting header whose directory is still loading as ready', () => {
    const screenLines = [
      '  >_ OpenAI Codex (v0.158.0)',
      '     loading',
      '  Shall we see where this goes?',
      '› Ask Codex to do anything',
      '  GPT-6-Sol default · ~/repo/app'
    ]
    expect(isKnownReadyPromptBody('', 'codex', () => screenLines)).toBe(false)
  })

  it('reports the model announcement as a blocked prompt, never as ready', async () => {
    const { screenLines, waitText } = await finalTranscriptFrame(MODEL_ANNOUNCEMENT, 120, 40)
    expect(screenLines.join('\n')).toContain('Try new model')
    expect(isKnownReadyPromptBody(waitText, 'codex', () => screenLines)).toBe(false)
    expect(detectTerminalWaitBlockedReason(waitText)).toBe('codex-model-migration-prompt')
  })

  describe('through the runtime', () => {
    async function codexPane(name: string) {
      return createTranscriptPane({
        paneTitle: 'Terminal',
        foregroundProcess: 'codex',
        launchAgent: 'codex',
        data: readTranscriptFixture(name),
        size: { cols: 120, rows: 40 }
      })
    }

    it('settles a tui-idle wait on the greeting layout', async () => {
      const { runtime, handle } = await codexPane(GREETING)
      // Why 5s: the poll re-reads the grid every 2s once the queued emulator write lands.
      await expect(
        runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 5_000 })
      ).resolves.toMatchObject({ condition: 'tui-idle', satisfied: true })
    }, 15_000)

    it('stops a tui-idle wait at the model announcement instead of typing into it', async () => {
      const { runtime, handle } = await codexPane(MODEL_ANNOUNCEMENT)
      await expect(
        runtime.waitForTerminal(handle, { condition: 'tui-idle', timeoutMs: 2_500 })
      ).resolves.toMatchObject({ satisfied: false, blockedReason: 'codex-model-migration-prompt' })
    }, 15_000)
  })
})
