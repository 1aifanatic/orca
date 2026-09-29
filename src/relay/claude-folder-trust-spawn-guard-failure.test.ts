import { describe, expect, it, vi } from 'vitest'

vi.mock('../main/local-folder-trust-breadth', () => ({
  isLocalFolderTooBroadToPreTrust: () => {
    throw new Error('homedir unavailable')
  }
}))

import { applyRelayClaudeFolderTrust } from './claude-folder-trust-spawn'

describe('applyRelayClaudeFolderTrust when the breadth guard fails', () => {
  it('skips trust and never fails the spawn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(
      applyRelayClaudeFolderTrust({ workspacePath: '/srv/wt' }, {}, { wslShell: false })
    ).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})
