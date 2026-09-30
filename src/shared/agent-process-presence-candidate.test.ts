import { describe, expect, it } from 'vitest'
import { selectDiscoveredAgentOwner } from './agent-process-presence-candidate'
const root = { pid: 10, ppid: 1, command: 'claude' }
describe('discovered process ownership', () => {
  it('binds nested agents to the outer terminal owner', () => {
    expect(
      selectDiscoveredAgentOwner(12, [
        root,
        { pid: 11, ppid: 10, command: 'sh' },
        { pid: 12, ppid: 11, command: 'claude' }
      ])
    ).toEqual({ processId: 10, processName: 'claude' })
    expect(selectDiscoveredAgentOwner(12, [root, { pid: 12, ppid: 10, command: 'codex' }])).toEqual(
      { processId: 10, processName: 'claude' }
    )
  })
  it('refuses sibling owners and malformed ancestry', () => {
    expect(
      selectDiscoveredAgentOwner(10, [root, { pid: 12, ppid: 1, command: 'claude' }])
    ).toBeNull()
    expect(selectDiscoveredAgentOwner(99, [root])).toBeNull()
  })
  it('keeps the wrapper process as owner', () => {
    expect(
      selectDiscoveredAgentOwner(12, [
        { ...root, command: 'omp' },
        { pid: 12, ppid: 10, command: 'pi' }
      ])
    ).toEqual({ processId: 10, processName: 'omp' })
  })
})
