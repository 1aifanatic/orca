// @vitest-environment happy-dom
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { AGENT_CHAT_PERMISSION_MODES } from '../../../../shared/agent-chat-permission-mode'
import {
  nativeChatPermissionModeLabel,
  nativeChatPermissionModeDescription
} from '../native-chat/native-chat-permission-mode-labels'
import { AgentsPane } from './AgentsPane'
import { TooltipProvider } from '../ui/tooltip'

vi.mock('@/hooks/useDetectedAgents', () => ({
  useDetectedAgents: () => ({
    detectedIds: ['claude', 'codex', 'goose'],
    isLoading: false,
    detectionFailed: false,
    isRefreshing: false,
    refresh: vi.fn()
  })
}))

afterEach(cleanup)

type UpdateSettings = (updates: Partial<GlobalSettings>) => void

function renderPane(overrides: Partial<GlobalSettings>, updateSettings: UpdateSettings) {
  return render(
    <TooltipProvider>
      <AgentsPane
        settings={{ ...getDefaultSettings('/tmp'), ...overrides }}
        updateSettings={updateSettings}
      />
    </TooltipProvider>
  )
}

async function permissionControl(name: string): Promise<HTMLElement> {
  if (name !== 'Agent Permissions' && !screen.queryByRole('combobox', { name })) {
    const row = document.querySelector(`[data-agent-row="${name.split(' ')[0]?.toLowerCase()}"]`)
    if (!(row instanceof HTMLElement)) {
      throw new Error(`No row for ${name}`)
    }
    await userEvent.click(within(row).getByRole('button', { name: 'Expand command override' }))
  }
  return screen.getByRole('combobox', { name })
}

async function openPicker(name: string): Promise<void> {
  const control = await permissionControl(name)
  control.focus()
  await userEvent.keyboard('{Enter}')
}

async function selectMode(label: string): Promise<void> {
  const option = screen
    .getAllByRole('option')
    .find((element) => element.textContent?.startsWith(label))
  expect(option).toBeDefined()
  if (option) {
    await userEvent.click(option)
  }
}

describe('Agent Permissions setting', () => {
  it('offers the chat picker labels, descriptions and warning tone for all four modes', async () => {
    renderPane({}, vi.fn())
    await openPicker('Agent Permissions')
    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(4)
    for (const [index, mode] of AGENT_CHAT_PERMISSION_MODES.entries()) {
      expect(options[index]?.textContent).toContain(nativeChatPermissionModeLabel(mode))
      expect(options[index]?.textContent).toContain(nativeChatPermissionModeDescription(mode))
      expect(options[index]?.querySelector('svg')).toBeTruthy()
    }
    expect(options[3]?.querySelector('.text-status-warning')).toBeTruthy()
  })

  it.each(AGENT_CHAT_PERMISSION_MODES)(
    'changes only the shared default when %s is selected',
    async (mode) => {
      const updateSettings = vi.fn<UpdateSettings>()
      renderPane(
        {
          agentPermissionMode: mode === 'bypass' ? 'ask' : 'bypass',
          agentPermissionModeOverrides: { codex: 'ask' }
        },
        updateSettings
      )
      await openPicker('Agent Permissions')
      await selectMode(nativeChatPermissionModeLabel(mode))
      expect(updateSettings).toHaveBeenCalledExactlyOnceWith({ agentPermissionMode: mode })
    }
  )

  it('keeps per-agent choices when the selected default is picked again', async () => {
    const updateSettings = vi.fn<UpdateSettings>()
    renderPane({ agentPermissionModeOverrides: { codex: 'ask' } }, updateSettings)
    await openPicker('Agent Permissions')
    await selectMode('Full access')
    expect(updateSettings).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain(
      'Codex runs Ask for approval: it has its own setting.'
    )
  })

  it.each([
    [
      'Claude',
      [
        'Default (Approve for me)',
        'Ask for approval',
        'Accept edits',
        'Approve for me',
        'Full access'
      ]
    ],
    ['Codex', ['Default (Approve for me)', 'Ask for approval', 'Approve for me', 'Full access']],
    ['Goose', ['Default (Ask for approval)', 'Ask for approval', 'Full access']]
  ])('offers only supported modes for %s', async (agent, labels) => {
    renderPane({ agentPermissionMode: 'auto' }, vi.fn())
    await openPicker(`${agent} permissions`)
    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(labels.length)
    for (const [index, label] of labels.entries()) {
      expect(options[index]?.textContent).toContain(label)
    }
  })

  it('sets and clears only one agent override', async () => {
    const updateSettings = vi.fn<UpdateSettings>()
    const view = renderPane({ agentPermissionModeOverrides: { codex: 'ask' } }, updateSettings)
    await openPicker('Claude permissions')
    await selectMode('Accept edits')
    expect(updateSettings).toHaveBeenLastCalledWith({
      agentPermissionModeOverrides: { codex: 'ask', claude: 'accept-edits' }
    })
    view.unmount()
    renderPane(
      { agentPermissionModeOverrides: { codex: 'ask', claude: 'accept-edits' } },
      updateSettings
    )
    await openPicker('Claude permissions')
    await selectMode('Default (Full access)')
    expect(updateSettings).toHaveBeenLastCalledWith({
      agentPermissionModeOverrides: { codex: 'ask' }
    })
  })

  it('names intermediate overrides and stricter unsupported defaults accurately', async () => {
    renderPane(
      { agentPermissionMode: 'auto', agentPermissionModeOverrides: { claude: 'accept-edits' } },
      vi.fn()
    )
    expect(document.body.textContent).toContain('Claude runs Accept edits: it has its own setting.')
    expect(document.body.textContent).toContain(
      'Goose runs Ask for approval: this agent does not support the default mode.'
    )
    expect((await permissionControl('Goose permissions')).textContent).toBe(
      'Default (Ask for approval)'
    )
  })
})
