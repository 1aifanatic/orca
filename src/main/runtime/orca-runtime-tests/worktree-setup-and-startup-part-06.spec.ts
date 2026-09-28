import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  OrcaRuntimeService,
  computeWorktreePathMock,
  ensurePathWithinWorkspaceMock,
  listWorktrees
} from '../orca-runtime-test-mocks.spec'
import type { WorktreeMeta } from '../orca-runtime-test-mocks.spec'
import { TEST_REPO_ID, makeWorktreeMeta, store } from '../orca-runtime-test-fixtures.spec'

// Startup draft and follow-up for goose, which declares `composer-quiet` launch readiness: with the
// shell's command-start mark the launch-readiness wait decides; without it, the base delivery does.
const COMMAND_START = '\x1b]133;C\x07'
const PROMPT_START = '\x1b]133;A\x07'
const TWO_LINE_PROMPT = 'QA follow-up line one\nQA follow-up line two'
const BRACKETED_PASTE_ON = '\x1b[?2004h'

async function createGooseWorktree(
  name: string,
  startup: { startupDraft: string } | { startupPrompt: string }
) {
  const metaById: Record<string, WorktreeMeta> = {}
  const runtime = new OrcaRuntimeService(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the shared test store plus these meta overrides, as every worktree-startup spec builds it.
    {
      ...store,
      getSettings: () => ({ ...store.getSettings(), agentCmdOverrides: {} }),
      getAllWorktreeMeta: () => metaById,
      getWorktreeMeta: (worktreeId: string) => metaById[worktreeId],
      setWorktreeMeta: (worktreeId: string, meta: Partial<WorktreeMeta>) => {
        metaById[worktreeId] = { ...(metaById[worktreeId] ?? makeWorktreeMeta()), ...meta }
        return metaById[worktreeId]
      }
    } as never
  )
  const ptyId = `pty-${name}`
  const write = vi.fn().mockReturnValue(true)
  // Why a shell first: the agent owns the foreground only after the shell ran its command.
  let foreground = 'zsh'
  runtime.setPtyController({
    spawn: vi.fn().mockResolvedValue({ id: ptyId }),
    write,
    kill: () => true,
    getForegroundProcess: async () => foreground
  })
  computeWorktreePathMock.mockReturnValue(`/tmp/workspaces/${name}`)
  ensurePathWithinWorkspaceMock.mockReturnValue(`/tmp/workspaces/${name}`)
  vi.mocked(listWorktrees).mockResolvedValue([
    {
      path: `/tmp/workspaces/${name}`,
      head: 'def',
      branch: name,
      isBare: false,
      isMainWorktree: false
    }
  ])
  await runtime.createManagedWorktree({
    repoSelector: TEST_REPO_ID,
    name,
    ...('startupDraft' in startup
      ? { startupDraft: startup.startupDraft, createdWithAgent: 'goose' as const }
      : { startupAgent: 'goose' as const, startupPrompt: startup.startupPrompt })
  })
  const startGoose = (output: string): void => {
    foreground = 'goose'
    runtime.onPtyData(ptyId, output, Date.now())
  }
  const paint = (output: string): void => {
    runtime.onPtyData(ptyId, output, Date.now())
  }
  // The OS reports the agent in the foreground before its command-start mark reaches Orca.
  const execGooseAheadOfItsOutput = (): void => {
    foreground = 'goose'
  }
  const wrote = (text: string) =>
    write.mock.calls.filter(([id, data]) => id === ptyId && String(data).includes(text))
  return { startGoose, paint, execGooseAheadOfItsOutput, write, wrote, ptyId }
}

describe('OrcaRuntimeService worktree startup delivery for a declared agent', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('pastes a startup draft once tui-idle confirms the composer, when the pane marks commands', async () => {
    const pane = await createGooseWorktree('runtime-goose-draft-marked', {
      startupDraft: 'draft text'
    })
    pane.startGoose(`${COMMAND_START}${BRACKETED_PASTE_ON}`)
    // goose keeps painting until 6.4 s: the base 1.5 s quiet timer fires at 7.9 s, inside 8 s.
    for (let paintedAt = 800; paintedAt <= 6_400; paintedAt += 800) {
      await vi.advanceTimersByTimeAsync(800)
      pane.paint('loading extensions')
    }
    await vi.advanceTimersByTimeAsync(1_600)
    expect(pane.wrote('draft')).toEqual([])
    // tui-idle confirms it after 3 s of quiet, on its next 2 s poll: within the extended budget.
    await vi.advanceTimersByTimeAsync(3_000)

    expect(pane.wrote('draft')).toEqual([[pane.ptyId, '\x1b[200~draft text\x1b[201~']])
  })

  it("waits past the shell's own quiet prompt for a marking shell's late command-start mark", async () => {
    const pane = await createGooseWorktree('runtime-goose-draft-late-mark', {
      startupDraft: 'draft text'
    })
    // The shell arms bracketed paste for its own prompt, so the base 1.5 s quiet window fires first.
    pane.paint(`${PROMPT_START}~/repo % ${BRACKETED_PASTE_ON}`)
    pane.execGooseAheadOfItsOutput()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(pane.wrote('draft')).toEqual([])

    pane.paint(`${COMMAND_START}${BRACKETED_PASTE_ON}`)
    await vi.advanceTimersByTimeAsync(6_000)

    expect(pane.wrote('draft')).toEqual([[pane.ptyId, '\x1b[200~draft text\x1b[201~']])
  })

  it('pastes a startup draft after the base 1.5 s quiet window when the pane marks no commands', async () => {
    const pane = await createGooseWorktree('runtime-goose-draft-unmarked', {
      startupDraft: 'draft text'
    })
    pane.startGoose(BRACKETED_PASTE_ON)
    await vi.advanceTimersByTimeAsync(1_499)
    expect(pane.wrote('draft')).toEqual([])
    await vi.advanceTimersByTimeAsync(1)

    expect(pane.wrote('draft')).toEqual([[pane.ptyId, '\x1b[200~draft text\x1b[201~']])
  })

  it('pastes a startup follow-up into the composer, when the pane marks commands', async () => {
    const pane = await createGooseWorktree('runtime-goose-followup-marked', {
      startupPrompt: 'fix it'
    })
    pane.startGoose(`${COMMAND_START}goose banner`)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(pane.wrote('fix it')).toEqual([])

    pane.paint(BRACKETED_PASTE_ON)
    // An armed composer settles once quiet (3 s), on the next tui-idle poll (2 s).
    await vi.advanceTimersByTimeAsync(6_000)
    expect(pane.wrote('\x1b[200~fix it\x1b[201~')).toHaveLength(1)
    expect(pane.wrote('fix it\r')).toEqual([])
  })

  it("waits for a marking shell's late command-start mark, then pastes the whole follow-up", async () => {
    const pane = await createGooseWorktree('runtime-goose-followup-late-mark', {
      startupPrompt: TWO_LINE_PROMPT
    })
    pane.paint(`${PROMPT_START}~/repo % `)
    pane.execGooseAheadOfItsOutput()
    await vi.advanceTimersByTimeAsync(300)
    expect(pane.wrote('line one')).toEqual([])

    pane.paint(`${COMMAND_START}goose banner`)
    await vi.advanceTimersByTimeAsync(1_000)
    pane.paint(BRACKETED_PASTE_ON)
    await vi.advanceTimersByTimeAsync(6_000)

    expect(pane.wrote(`\x1b[200~${TWO_LINE_PROMPT}\x1b[201~`)).toHaveLength(1)
    expect(pane.wrote(`${TWO_LINE_PROMPT}\r`)).toEqual([])
  })

  it('types a startup follow-up at the end of its budget when a marking shell never marks the command', async () => {
    const pane = await createGooseWorktree('runtime-goose-followup-mark-never', {
      startupPrompt: TWO_LINE_PROMPT
    })
    pane.paint(`${PROMPT_START}~/repo % `)
    pane.execGooseAheadOfItsOutput()
    // The base follow-up polls 30 times, 150 ms apart.
    await vi.advanceTimersByTimeAsync(4_400)
    expect(pane.wrote('line one')).toEqual([])
    await vi.advanceTimersByTimeAsync(100)

    expect(pane.wrote('line one')).toEqual([[pane.ptyId, `${TWO_LINE_PROMPT}\r`]])
  })

  it('types a startup follow-up on the process match when the pane marks no commands', async () => {
    const pane = await createGooseWorktree('runtime-goose-followup-unmarked', {
      startupPrompt: 'fix it'
    })
    pane.startGoose('goose banner')
    await vi.advanceTimersByTimeAsync(300)

    expect(pane.wrote('fix it')).toEqual([[pane.ptyId, 'fix it\r']])
  })
})
