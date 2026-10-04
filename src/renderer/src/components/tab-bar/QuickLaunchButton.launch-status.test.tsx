// @vitest-environment happy-dom

import type { ReactNode } from 'react'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StructuredLaunchState } from '@/lib/structured-agent-session-launch-registry'
import {
  BLANK_STRUCTURED_LAUNCH_REQUEST,
  structuredLaunchRequest,
  type StructuredLaunchAttempt
} from '@/lib/structured-agent-session-launch-request'

vi.mock('@/hooks/useDetectedAgents', () => ({
  useDetectedAgents: () => ({ detectedIds: ['claude', 'codex'] })
}))
vi.mock('@/hooks/useShortcutLabel', () => ({ useOptionalShortcutLabel: () => null }))
vi.mock('@/store', () => {
  const state = {
    settings: { defaultTuiAgent: 'codex', disabledTuiAgents: [] },
    worktreesByRepo: {},
    repos: [],
    openSettingsPage: vi.fn(),
    openSettingsTarget: vi.fn()
  }
  const useAppStore = Object.assign((selector: (s: typeof state) => unknown) => selector(state), {
    getState: () => state
  })
  return { useAppStore }
})
vi.mock('@/lib/agent-catalog', () => ({
  getAgentCatalog: () => [
    { id: 'claude', label: 'Claude' },
    { id: 'codex', label: 'Codex' }
  ],
  AgentIcon: ({ agent }: { agent: string }) => <span>{agent}</span>
}))
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenuItem: ({
    children,
    disabled,
    title,
    onSelect
  }: { children: ReactNode } & DivProps) => (
    <div aria-disabled={disabled ? 'true' : 'false'} title={title} onClick={onSelect}>
      {children}
    </div>
  ),
  DropdownMenuShortcut: ({ children }: { children: ReactNode }) => <span>{children}</span>
}))
vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string>) =>
    fallback.replace('{{value0}}', values?.value0 ?? '')
}))
const launchMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/launch-agent-in-new-tab', () => ({ launchAgentInNewTab: launchMock }))

type DivProps = { disabled?: boolean; title?: string; onSelect?: () => void }

import { QuickLaunchAgentMenuItems } from './QuickLaunchButton'
import {
  resetStructuredAgentLaunchRegistryForTests,
  setStructuredLaunchState
} from '@/lib/structured-agent-session-launch-registry'

const WORKTREE_ID = 'worktree-1'

function registerLaunch(
  agent: 'claude' | 'codex',
  outcome: 'pending' | 'failed',
  attempt: StructuredLaunchAttempt = {
    kind: 'first',
    request: BLANK_STRUCTURED_LAUNCH_REQUEST,
    stagedEntry: null
  }
): void {
  const sessionId = `${agent}-session`
  setStructuredLaunchState({
    identity: `${agent}:${WORKTREE_ID}`,
    intent: {
      worktreeId: WORKTREE_ID,
      sessionId,
      executionHostId: 'local',
      target: { kind: 'local' },
      agent,
      params: {
        envelope: {
          sessionId,
          clientOperationId: `operation-${sessionId}`,
          expectedRuntimeFence: null,
          payloadFingerprint: `fingerprint-${sessionId}`
        },
        worktree: `id:${WORKTREE_ID}`,
        agent
      }
    },
    promptDelivery: undefined,
    callers: {
      outcome,
      attempt,
      entries: new Set(),
      promptDeliveryResults: new Set(),
      onSettled: () => undefined
    },
    promise: new Promise(() => undefined),
    visibilityUnknown: false,
    cancelled: false,
    selection: { held: {} }
  } satisfies StructuredLaunchState)
}

function agentRowDisabled(label: string): string | null | undefined {
  return document
    .querySelector(`[title="Launch ${label} in a new terminal"]`)
    ?.getAttribute('aria-disabled')
}

describe('QuickLaunchAgentMenuItems launch status', () => {
  beforeEach(() => {
    localStorage.clear()
    resetStructuredAgentLaunchRegistryForTests()
  })
  afterEach(cleanup)

  it('keeps an agent whose chat failed to start launchable while a starting one waits', () => {
    registerLaunch('claude', 'pending')
    registerLaunch('codex', 'failed')

    render(
      <QuickLaunchAgentMenuItems
        worktreeId={WORKTREE_ID}
        groupId="group-1"
        onFocusTerminal={vi.fn()}
      />
    )

    expect(agentRowDisabled('Claude')).toBe('true')
    expect(agentRowDisabled('Codex')).toBe('false')
  })

  // A pick then opens a new chat; only a new start's own create would be joined.
  it("keeps an agent launchable while a failed chat's Retry is in flight", () => {
    registerLaunch('claude', 'pending')
    registerLaunch('codex', 'pending', { kind: 'retry' })

    render(
      <QuickLaunchAgentMenuItems
        worktreeId={WORKTREE_ID}
        groupId="group-1"
        onFocusTerminal={vi.fn()}
      />
    )

    expect(agentRowDisabled('Claude')).toBe('true')
    expect(agentRowDisabled('Codex')).toBe('false')
  })

  // A pick joins only a start of the same request; any other opens its own chat.
  it('disables an agent only for the request its starting chat carries', () => {
    registerLaunch('codex', 'pending', {
      kind: 'first',
      request: structuredLaunchRequest({ prompt: 'review notes' }),
      stagedEntry: null
    })
    const menu = (prompt?: string) => (
      <QuickLaunchAgentMenuItems
        worktreeId={WORKTREE_ID}
        groupId="group-1"
        onFocusTerminal={vi.fn()}
        {...(prompt ? { prompt } : {})}
      />
    )

    render(menu())
    expect(agentRowDisabled('Codex')).toBe('false')
    cleanup()
    render(menu('other notes'))
    expect(agentRowDisabled('Codex')).toBe('false')
    cleanup()
    render(menu('review notes'))
    expect(agentRowDisabled('Codex')).toBe('true')
  })

  // Why: a new chat saves the notes' keys with its message; the launch's own result holds them
  // until then, so a second send leaves them out.
  it('gives the launch the notes keys and hands it its own delivery result', () => {
    const delivery = Promise.resolve({ delivered: true, failureNotified: false })
    launchMock.mockReturnValue({
      surface: { kind: 'local-agent-session', tabId: 'tab-1', sessionId: 'codex-session' },
      promptDeliveryResult: delivery
    })
    const notesHandOff = { carriedNoteKeys: ['note-a'], handOff: vi.fn() }

    render(
      <QuickLaunchAgentMenuItems
        worktreeId={WORKTREE_ID}
        groupId="group-1"
        onFocusTerminal={vi.fn()}
        prompt="review notes"
        promptDelivery="submit-after-ready"
        notesHandOff={notesHandOff}
      />
    )
    fireEvent.click(document.querySelector('[title="Launch Codex in a new terminal"]')!)

    expect(launchMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ carriedNoteKeys: ['note-a'] })
    )
    expect(notesHandOff.handOff).toHaveBeenCalledExactlyOnceWith(delivery)
  })

  it('starts no agent when the menu has nothing left to send', () => {
    launchMock.mockClear()
    render(
      <QuickLaunchAgentMenuItems
        worktreeId={WORKTREE_ID}
        groupId="group-1"
        onFocusTerminal={vi.fn()}
        prompt=""
        disabled
      />
    )

    expect(agentRowDisabled('Codex')).toBe('true')
    fireEvent.click(document.querySelector('[title="Launch Codex in a new terminal"]')!)
    expect(launchMock).not.toHaveBeenCalled()
  })
})
