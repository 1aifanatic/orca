import { describe, expect, it } from 'vitest'
import { isTerminalPaneOnClient } from './terminal-pane-client-host'

const repo = (id: string, owner: { connectionId?: string; executionHostId?: string }) => ({
  id,
  ...owner
})

const state = {
  repos: [
    repo('local-repo', { executionHostId: 'local' }),
    repo('ssh-repo', { connectionId: 'box', executionHostId: 'ssh:box' }),
    repo('managed-repo', { executionHostId: 'runtime:env-1' })
  ],
  worktreesByRepo: {}
}

describe('whether a terminal pane runs on this client', () => {
  it('is true only for a local workspace', () => {
    expect(isTerminalPaneOnClient(state, 'local-repo::/home/me/app')).toBe(true)
    expect(isTerminalPaneOnClient(state, 'ssh-repo::/srv/app')).toBe(false)
    expect(isTerminalPaneOnClient(state, 'managed-repo::/root/repo')).toBe(false)
  })

  it('is false while the workspace host is still unknown', () => {
    expect(isTerminalPaneOnClient(state, 'not-loaded::/srv/app')).toBe(false)
  })
})
