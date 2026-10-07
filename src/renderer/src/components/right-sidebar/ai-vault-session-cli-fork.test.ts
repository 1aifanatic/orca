import { describe, expect, it } from 'vitest'
import { aiVaultSessionCliForkWorktreeId } from './ai-vault-session-cli-fork'

const OWNED = { sessionId: 'chat-1', workspaceId: 'repo-1::worktree-1' }
const RESUMABLE = { worktreeId: 'repo-1::worktree-2', disabled: false }

describe('Resume in New CLI eligibility', () => {
  it('offers the fork for Claude and Codex rows native chat owns', () => {
    expect(
      aiVaultSessionCliForkWorktreeId({ agent: 'claude', structuredSession: OWNED }, RESUMABLE)
    ).toBe('repo-1::worktree-2')
    expect(
      aiVaultSessionCliForkWorktreeId({ agent: 'codex', structuredSession: OWNED }, RESUMABLE)
    ).toBe('repo-1::worktree-2')
  })

  it('leaves rows no chat owns to plain Resume', () => {
    expect(aiVaultSessionCliForkWorktreeId({ agent: 'claude' }, RESUMABLE)).toBeNull()
  })

  it('withholds the fork when resume is blocked or has no target', () => {
    const session = { agent: 'claude' as const, structuredSession: OWNED }
    expect(aiVaultSessionCliForkWorktreeId(session, { worktreeId: 'w', disabled: true })).toBeNull()
    expect(
      aiVaultSessionCliForkWorktreeId(session, { worktreeId: null, disabled: false })
    ).toBeNull()
  })
})
