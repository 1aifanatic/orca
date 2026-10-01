import { expect, it } from 'vitest'
import { consumeExplainedLaunchRefusal, noteTerminalLaunchError } from './terminal-launch-refusals'

it('remembers a refused account launch once, so the launch watchdog stays quiet', () => {
  noteTerminalLaunchError('tab-1', 'Sign in again to use this account.')
  noteTerminalLaunchError('tab-2', 'Failed to spawn shell "/bin/zsh": boom')
  expect(consumeExplainedLaunchRefusal('tab-1')).toBe(true)
  expect(consumeExplainedLaunchRefusal('tab-1')).toBe(false)
  expect(consumeExplainedLaunchRefusal('tab-2')).toBe(false)
})
