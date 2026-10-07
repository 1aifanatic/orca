import { vi } from 'vitest'
import type { TuiAgent } from '../../shared/tui-agent'
import { OrcaRuntimeService } from './orca-runtime'
import { makeStore } from './runtime-rpc-worktree-store-fixtures'
import { settledWriteStub } from '../providers/settled-pty-write-stub'

export const AGENT_PROMPT_TEST_WORKTREE_PATH = '/tmp/worktree-a'
export const AGENT_PROMPT_TEST_WORKTREE_ID = 'repo-1::/tmp/worktree-a'

export async function createAgentPromptSubmissionRuntime(
  onWrite: (runtime: OrcaRuntimeService, data: string, writeIndex: number) => void,
  launchAgent: TuiAgent = 'aider'
): Promise<{ runtime: OrcaRuntimeService; handle: string; writes: string[] }> {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this store fixture implements the operations these prompt tests exercise; missing operations fail on use.
  const runtime = new OrcaRuntimeService(makeStore() as never)
  const writes: string[] = []
  const write = (_ptyId: string, data: string): boolean => {
    writes.push(data)
    onWrite(runtime, data, writes.length)
    return true
  }
  runtime.setPtyController({
    spawn: async () => ({ id: 'pty-prompt' }),
    write,
    writeWithSettlement: settledWriteStub(write),
    kill: () => true,
    getForegroundProcess: async () => null
  })
  const terminal = await runtime.createTerminal(`path:${AGENT_PROMPT_TEST_WORKTREE_PATH}`, {
    launchAgent
  })
  // The pane holds a live agent, which its host would find in front of its terminal.
  vi.spyOn(runtime, 'readLaunchedAgentForeground').mockResolvedValue('agent')
  return { runtime, handle: terminal.handle, writes }
}
