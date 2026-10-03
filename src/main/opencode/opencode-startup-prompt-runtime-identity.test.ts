import { describe, expect, it, vi } from 'vitest'
import {
  createTranscriptPane,
  TRANSCRIPT_PANE_PTY_ID
} from '../runtime/agent-transcript-pane-test-harness'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

async function fixture(launchAgent?: 'opencode' | 'opencode2' | 'zcode') {
  const { runtime } = await createTranscriptPane({
    paneTitle: 'Terminal',
    foregroundProcess: null,
    data: '',
    ...(launchAgent ? { launchAgent } : {})
  })
  runtime.terminalRunFacts.recordSpawnCommit({ id: TRANSCRIPT_PANE_PTY_ID, incarnationId: 'inc-1' })
  const read = (
    ptyId = TRANSCRIPT_PANE_PTY_ID,
    incarnation = 'inc-1',
    token = 'transcript-launch'
  ) => runtime.readOpenCodeStartupPromptOwner(ptyId, incarnation, token)
  return { runtime, read }
}

describe('runtime-owned startup prompt identity', () => {
  it('keeps launch admission pending before runtime identity is assigned', async () => {
    const f = await fixture()
    expect(f.read()).toBe('pending')
    expect(f.read('missing')).toBeNull()
    expect(f.read(TRANSCRIPT_PANE_PTY_ID, 'previous-incarnation')).toBeNull()
  })

  it.each(['opencode', 'opencode2'] as const)(
    'reads only the admitted %s launch',
    async (agent) => {
      const f = await fixture(agent)
      expect(f.read()).toEqual({ freshSpawn: true, firstUserInputAt: null })
      expect(f.read(TRANSCRIPT_PANE_PTY_ID, 'inc-1', 'another-launch')).toBeNull()
      expect(f.read(TRANSCRIPT_PANE_PTY_ID, 'previous-incarnation')).toBeNull()
      f.runtime.terminalRunFacts.recordInput(TRANSCRIPT_PANE_PTY_ID, 'driving', 'x', 123)
      expect(f.read()).toEqual({ freshSpawn: true, firstUserInputAt: 123 })
    }
  )

  it('denies another agent even with the exact incarnation and launch token', async () => {
    expect((await fixture('zcode')).read()).toBeNull()
  })
})
