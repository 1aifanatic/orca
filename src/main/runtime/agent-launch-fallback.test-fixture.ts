import { vi, type Mock, type MockInstance } from 'vitest'
import type { OrcaRuntimeService } from './orca-runtime'
import type { TuiAgent } from '../../shared/tui-agent'
import type { TerminalProcessInspection } from '../../shared/terminal-process-inspection'
import { createAgentPromptSubmissionRuntime } from './agent-prompt-submission-runtime-test-fixture'
import { deliverTerminalAgentLaunchPrompt } from './rpc/methods/agent-launch-terminal-prompt'

type LaunchPromptArguments = Partial<Parameters<typeof deliverTerminalAgentLaunchPrompt>[0]>
type LaunchFallbackRuntime = {
  runtime: OrcaRuntimeService
  handle: string
  writes: string[]
  writeTimes: number[]
  inspectProcess: Mock<() => Promise<TerminalProcessInspection>>
  fallback: MockInstance<OrcaRuntimeService['waitForAgentLaunchFallback']>
  composer: MockInstance<OrcaRuntimeService['waitForFreshWorkerComposer']>
  deliver: (extra?: LaunchPromptArguments) => Promise<boolean>
  onComposerUnobserved: Mock<() => void>
}

export async function createLaunchFallbackRuntime(
  options: {
    agent?: TuiAgent
    process?: TerminalProcessInspection
    legacy?: boolean
    unavailable?: boolean
  } = {}
): Promise<LaunchFallbackRuntime> {
  const agent = options.agent ?? 'opencode'
  const { runtime, handle, writes } = await createAgentPromptSubmissionRuntime(() => {}, agent)
  const writeTimes: number[] = []
  const inspection = options.process ?? { foregroundProcess: null, hasChildProcesses: false }
  const inspectProcess = vi.fn(async (): Promise<TerminalProcessInspection> => {
    if (options.unavailable) {
      throw new Error('inspection_unavailable')
    }
    return inspection
  })
  runtime.setPtyController({
    write: (_ptyId, data) => {
      writes.push(data)
      writeTimes.push(Date.now())
      return true
    },
    kill: () => true,
    getForegroundProcess: async () => inspection.foregroundProcess,
    hasChildProcesses: async () => inspection.hasChildProcesses,
    ...(options.legacy ? {} : { inspectProcess })
  })
  // Simulate Windows/WSL's existing unknown verdict without substituting the readiness or writer.
  vi.mocked(runtime.readLaunchedAgentForeground).mockResolvedValue('unknown')
  vi.spyOn(runtime, 'launchedAgentHostProvesAgent').mockReturnValue(false)
  const fallback = vi.spyOn(runtime, 'waitForAgentLaunchFallback')
  const composer = vi.spyOn(runtime, 'waitForFreshWorkerComposer')
  const onComposerUnobserved = vi.fn<() => void>()
  const deliver = (extra: LaunchPromptArguments = {}) =>
    deliverTerminalAgentLaunchPrompt({
      runtime,
      handle,
      agent,
      freshLaunch: true,
      text: 'fix the conflict\nthen test',
      callerKey: 'trusted-local:desktop',
      onComposerUnobserved,
      ...extra
    })
  return {
    runtime,
    handle,
    writes,
    writeTimes,
    inspectProcess,
    fallback,
    composer,
    deliver,
    onComposerUnobserved
  }
}
