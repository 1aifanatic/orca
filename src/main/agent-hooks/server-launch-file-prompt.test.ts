import { describe, expect, it } from 'vitest'
import { makePaneKey } from '../../shared/stable-pane-id'
import { buildLaunchFilePointer, carryInLaunchFile } from '../../shared/launch-prompt-file'
import { AgentHookServer } from './server'
import { rememberLaunchFilePrompt } from './launch-file-prompt-by-pane'

const LAUNCHED = makePaneKey('tab-launched', '55555555-5555-4555-8555-555555555555')
const POINTER = buildLaunchFilePointer('/tmp/orca-launch-file-a1/task-context.md')

describe('a status row whose agent reports its launch file’s pointer', () => {
  // Why: the agent's own hook sees only the pointer sentence; every Orca reader of the row (status
  // row, dashboard, phone) must see the prompt the user wrote.
  it('shows the prompt the file carries', () => {
    rememberLaunchFilePrompt(LAUNCHED, carryInLaunchFile('fix the flaky test', false).launchFile)
    const server = new AgentHookServer()
    server.ingestTerminalStatus({
      paneKey: LAUNCHED,
      tabId: 'tab-launched',
      worktreeId: 'wt-1',
      payload: { state: 'working', prompt: POINTER }
    })
    expect(server.getStatusSnapshot()).toEqual([
      expect.objectContaining({ paneKey: LAUNCHED, prompt: 'fix the flaky test' })
    ])
  })

  it('leaves a sensitive file’s pointer, whose content is never kept', () => {
    const pane = makePaneKey('tab-sensitive', '66666666-6666-4666-8666-666666666666')
    rememberLaunchFilePrompt(pane, carryInLaunchFile('token dcap_secret', true).launchFile)
    const server = new AgentHookServer()
    server.ingestTerminalStatus({
      paneKey: pane,
      tabId: 'tab-sensitive',
      worktreeId: 'wt-1',
      payload: { state: 'working', prompt: POINTER }
    })
    expect(server.getStatusSnapshot()).toEqual([expect.objectContaining({ prompt: POINTER })])
  })
})
