// @vitest-environment happy-dom

// Machine rows inside the dialog's checkbox-column list: one column of boxes, one Select all.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '../store'
import { getDefaultSettings } from '../../../shared/constants'
import { getHostContextLabel } from '../../../shared/worktree/host-context-labels'
import { getHostDisplayLabelOverrides } from '../../../shared/host-setting-overrides'
import { buildSidebarHostOptions } from './sidebar/sidebar-host-options'
import { NativeChatResumeOnRestartModal } from './NativeChatResumeOnRestartModal'
import { TooltipProvider } from './ui/tooltip'
import type { ResumeCandidate, ResumeFailure } from './native-chat-resume-on-restart-grouping'
import {
  consumeNativeChatResumeOnRestartDialogRequest,
  requestNativeChatResumeOnRestartDialog
} from './native-chat-resume-on-restart-dialog'
import { readNativeChatRestartMachine } from './native-chat-resume-on-restart-store'
import { _resetNativeChatRestartOffer } from './native-chat-restart-offer-triggers'
import { pairedEnvironment } from './native-chat-restart-offer-test-support'
import { button, chatBox, namedBox } from './native-chat-resume-on-restart-modal.test-support'
import {
  machineRow,
  machineRowFixture as row,
  machineToggle
} from './native-chat-resume-machines.test-support'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: rpc,
  pairedRestartOffersSupport: async () => 'supported',
  subscribeStructuredAgentSessionStatus: () => new Promise(() => {})
}))
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { dismiss: vi.fn() }) }))

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let container: HTMLDivElement

type Listing = { sessions: ResumeCandidate[]; failed?: ResumeFailure[] }

const LOCAL = getHostContextLabel('local')
const SERVER_ROWS = [row('s1', 'own'), row('s2', 'other-device'), row('s3', 'automation')]

/** Reads this computer and each named server with the listing given for it. A server's resume
 *  never answers; this computer's does at once. */
async function stage(local: Listing, servers: Record<string, Listing>): Promise<void> {
  rpc.mockImplementation(async (target, method) => {
    if (method === 'agentSession.restartContinue') {
      return target.kind === 'local' ? { continued: [], ...local } : new Promise(() => {})
    }
    return target.kind === 'local' ? local : (servers[target.environmentId] ?? { sessions: [] })
  })
  await act(async () => {
    await readNativeChatRestartMachine({ kind: 'local' })
    for (const environmentId of Object.keys(servers)) {
      await readNativeChatRestartMachine({ kind: 'environment', environmentId })
    }
  })
}

async function open(focus: string | null): Promise<void> {
  await act(async () =>
    root.render(
      <TooltipProvider>
        <NativeChatResumeOnRestartModal />
      </TooltipProvider>
    )
  )
  await act(async () => requestNativeChatResumeOnRestartDialog(focus))
}

/** The grid row a checkbox heads: its first cell is the checkbox column. */
function rowOf(box: HTMLElement): HTMLElement {
  return box.parentElement!.parentElement!
}

function selectAllCount(): string | undefined {
  return namedBox('Select all chats').closest('label')?.querySelector('.tabular-nums')?.textContent
}

beforeEach(() => {
  rpc.mockReset()
  _resetNativeChatRestartOffer()
  consumeNativeChatResumeOnRestartDialogRequest()
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    settings: { ...getDefaultSettings(''), experimentalStructuredNativeChat: false },
    runtimeEnvironments: [
      pairedEnvironment('studio', 'studio-mac'),
      pairedEnvironment('build', 'build-box')
    ]
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  _resetNativeChatRestartOffer()
  consumeNativeChatResumeOnRestartDialogRequest()
  useAppStore.setState(useAppStore.getInitialState(), true)
})

it('puts each machine’s box in the list’s one checkbox column, indenting only what is under it', async () => {
  await stage({ sessions: [row('l1', 'own')] }, { studio: { sessions: SERVER_ROWS } })
  await open('environment:studio')

  expect(document.querySelectorAll('[aria-label="Select all chats"]')).toHaveLength(1)
  const machine = rowOf(machineToggle('studio-mac'))
  const workspace = rowOf(namedBox('Select all chats in workspace-s1'))
  const columns = 'grid-cols-[1.75rem_minmax(0,1fr)]'
  expect(machine.classList.contains(columns)).toBe(true)
  expect(workspace.classList.contains(columns)).toBe(true)
  expect(machine.firstElementChild?.contains(machineToggle('studio-mac'))).toBe(true)
  // Nested one level under the machine: the workspace's box, title and chats move right.
  expect(workspace.querySelector<HTMLElement>(':scope > :nth-child(2)')?.style.marginLeft).toBe(
    '40px'
  )
  expect(chatBox('s1').closest('ul')?.style.getPropertyValue('--resume-chat-indent')).toBe('60px')

  const order = [
    namedBox('Select all chats'),
    machineToggle(LOCAL),
    machineToggle('studio-mac'),
    namedBox('Select all chats in workspace-s1'),
    chatBox('s1'),
    namedBox('Select all chats in workspace-s2'),
    chatBox('s2'),
    namedBox('Select all chats in workspace-s3'),
    chatBox('s3')
  ]
  order[0]!.focus()
  for (const next of order.slice(1)) {
    await act(async () => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })
      )
    })
    expect(document.activeElement).toBe(next)
  }
})

// A machine row heads its workspaces' boxes from outside them, and sits a step further from the
// previous machine's boxes than one box from the next.
it('heads each machine’s boxes from outside them, set apart from the machine before', async () => {
  await stage({ sessions: [row('l1', 'own')] }, { studio: { sessions: SERVER_ROWS } })
  await open('environment:studio')
  await act(async () => machineRow(LOCAL).click())
  const localBox = rowOf(namedBox('Select all chats in workspace-l1')).parentElement!
  const studio = rowOf(machineToggle('studio-mac'))
  // Each workspace box draws its border in the content area; the machine row is in none of them.
  expect(localBox.querySelector(':scope > [aria-hidden="true"]')).not.toBeNull()
  expect(studio.closest('.relative')).toBeNull()
  expect(localBox.compareDocumentPosition(studio) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  expect(studio.classList.contains('mt-3')).toBe(true)
  expect(localBox.classList.contains('my-1.5')).toBe(true)
})

it('ticks and clears only its own machine’s chats from a machine’s tri-state box', async () => {
  await stage(
    { sessions: [row('l1', 'own'), row('l2', 'other-device')] },
    { studio: { sessions: SERVER_ROWS } }
  )
  await open(null)
  expect(machineToggle(LOCAL).getAttribute('aria-checked')).toBe('mixed')
  expect(machineToggle('studio-mac').getAttribute('aria-checked')).toBe('mixed')

  await act(async () => machineToggle('studio-mac').click())
  expect(machineToggle('studio-mac').getAttribute('aria-checked')).toBe('true')
  expect(machineToggle(LOCAL).getAttribute('aria-checked')).toBe('mixed')
  expect(button('Resume 4 chats')).toBeTruthy()

  await act(async () => machineToggle('studio-mac').click())
  expect(machineToggle('studio-mac').getAttribute('aria-checked')).toBe('false')
  expect(machineToggle(LOCAL).getAttribute('aria-checked')).toBe('mixed')
  expect(button('Resume 1 chat')).toBeTruthy()
})

// Another device's chat starts unticked but can be picked, so Select all counts and ticks it; a
// failure no retry can fix cannot be picked at all, so it counts nowhere.
it('counts one Select all across machines, others’ chats included, unfixable failures not', async () => {
  const unfixable = {
    ...row('s4', 'own'),
    failedAt: 1_800_000_060_000,
    outcome: 'refused' as const,
    reason: 'agent_session_restart_work_superseded',
    retryable: false
  }
  await stage(
    { sessions: [row('l1', 'own')] },
    { studio: { sessions: [row('s1', 'own'), row('s2', 'other-device')], failed: [unfixable] } }
  )
  await open('environment:studio')
  const selectAll = namedBox('Select all chats')
  expect(selectAll.getAttribute('aria-checked')).toBe('mixed')
  expect(selectAllCount()).toBe('2 of 3 selected')

  await act(async () => selectAll.click())
  expect(selectAll.getAttribute('aria-checked')).toBe('true')
  expect(selectAllCount()).toBe('3 of 3 selected')
  expect(chatBox('s2').getAttribute('aria-checked')).toBe('true')
  expect(chatBox('s4').getAttribute('aria-checked')).toBe('false')
  expect(button('Resume 3 chats')).toBeTruthy()

  await act(async () => selectAll.click())
  expect(selectAllCount()).toBe('0 of 3 selected')
  expect(button('Resume 0 chats').disabled).toBe(true)
})

// A machine mid-resume is locked; its ticks show the run, not a choice Select all can change.
it('leaves a machine whose resume is running out of Select all', async () => {
  await stage({ sessions: [row('l1', 'own')] }, { studio: { sessions: SERVER_ROWS } })
  await open('environment:studio')
  await act(async () => button('Resume 2 chats').click())
  await open('environment:studio')
  expect(machineToggle('studio-mac').hasAttribute('disabled')).toBe(true)
  expect(selectAllCount()).toBe('1 of 1 selected')
  await act(async () => namedBox('Select all chats').click())
  expect(selectAllCount()).toBe('0 of 1 selected')
  expect(chatBox('s1').getAttribute('aria-checked')).toBe('true')
  expect(button('Resuming…').disabled).toBe(true)
})

// With every machine mid-resume there is nothing to choose; Select all shows the run instead.
it('shows the run in Select all while every machine is resuming', async () => {
  await stage(
    { sessions: [] },
    { studio: { sessions: SERVER_ROWS }, build: { sessions: [row('b1', 'own')] } }
  )
  await open(null)
  await act(async () => button('Resume 2 chats').click())
  await open(null)
  const selectAll = namedBox('Select all chats')
  expect(selectAll.hasAttribute('disabled')).toBe(true)
  expect(selectAll.getAttribute('aria-checked')).toBe('mixed')
  expect(selectAllCount()).toBe('2 of 4 selected')
})

// The machine row names the server; a chip saying the same on every workspace under it would only
// repeat it, so a paired server's workspaces carry none.
it('names a paired server once, on its machine row, not again on each workspace', async () => {
  await stage({ sessions: [row('l1', 'own')] }, { studio: { sessions: SERVER_ROWS } })
  await open('environment:studio')
  for (const sessionId of ['s1', 's2', 's3']) {
    const workspace = rowOf(namedBox(`Select all chats in workspace-${sessionId}`))
    expect(workspace.textContent).not.toContain('studio')
  }
})

// The machine row and a workspace's host chip read one source, the sidebar's host names; a host
// renamed in its settings reads the new name on both, and no name shows twice for one host.
it('names each machine as the sidebar does, a rename included, and an SSH host only on its chip', async () => {
  useAppStore.setState({
    settings: {
      ...getDefaultSettings(''),
      experimentalStructuredNativeChat: false,
      hostSettingOverrides: {
        local: { displayLabel: 'Desk' },
        'runtime:studio': { displayLabel: 'Studio' }
      }
    },
    sshTargetLabels: new Map([['devbox-1', 'devbox']])
  })
  const onSsh = { ...row('l2', 'own'), executionHostId: 'ssh:devbox-1' as const }
  await stage({ sessions: [row('l1', 'own'), onSsh] }, { studio: { sessions: SERVER_ROWS } })
  await open('environment:studio')
  // The labels the sidebar's own host sections are built from.
  const state = useAppStore.getState()
  const sidebar = new Map(
    buildSidebarHostOptions({
      repos: state.repos,
      sshTargetLabels: state.sshTargetLabels,
      sshConnectionStates: state.sshConnectionStates,
      settings: state.settings,
      runtimeEnvironments: state.runtimeEnvironments,
      runtimeStatusByEnvironmentId: state.runtimeStatusByEnvironmentId,
      hostLabelOverrides: getHostDisplayLabelOverrides(state.settings)
    }).map((host) => [host.id, host.label])
  )
  expect([sidebar.get('local'), sidebar.get('runtime:studio')]).toEqual(['Desk', 'Studio'])
  expect(machineToggle('Desk')).toBeTruthy()
  expect(machineToggle('Studio')).toBeTruthy()
  await act(async () => machineRow('Desk').click())
  expect(rowOf(namedBox('Select all chats in workspace-l2')).textContent).toContain('devbox')
  expect(rowOf(namedBox('Select all chats in workspace-l1')).textContent).not.toContain('Desk')
  expect(rowOf(namedBox('Select all chats in workspace-s1')).textContent).not.toContain('Studio')
})
