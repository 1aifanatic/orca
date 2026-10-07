// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type * as ReactModule from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentChatPermissionMode } from '../../../../shared/agent-chat-permission-mode'
import type { NativeChatPermissionModePickerState } from './native-chat-permission-mode-labels'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string | number>) =>
    Object.entries(values ?? {}).reduce(
      (text, [name, value]) => text.replaceAll(`{{${name}}}`, String(value)),
      fallback
    )
}))

vi.mock('@/components/ui/button', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  )
}))

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))

vi.mock('@/components/ui/dropdown-menu', () => {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: require returns the react module this type names.
  const React = require('react') as typeof ReactModule
  return {
    DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    DropdownMenuTrigger: ({
      children,
      disabled
    }: {
      children: React.ReactNode
      disabled?: boolean
    }) => (
      <div data-testid="permission-trigger" data-disabled={disabled || undefined}>
        {children}
      </div>
    ),
    DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="permission-menu">{children}</div>
    ),
    DropdownMenuRadioGroup: ({
      children,
      value,
      onValueChange,
      'aria-label': ariaLabel
    }: {
      children: React.ReactNode
      value?: string
      onValueChange?: (value: string) => void
      'aria-label'?: string
    }) => (
      <div role="radiogroup" aria-label={ariaLabel}>
        {React.Children.map(children, (child) => {
          if (!React.isValidElement(child)) {
            return child
          }
          // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: every child is a DropdownMenuRadioItem with these props.
          const props = child.props as {
            value?: string
            disabled?: boolean
            children?: React.ReactNode
          }
          return (
            <button
              role="radio"
              aria-checked={props.value === value}
              disabled={props.disabled}
              data-value={props.value}
              onClick={() => props.value !== undefined && onValueChange?.(props.value)}
            >
              {props.children}
            </button>
          )
        })}
      </div>
    ),
    DropdownMenuRadioItem: ({ children }: { children: React.ReactNode; value: string }) => (
      <span>{children}</span>
    )
  }
})

import { NativeChatPermissionModePicker } from './NativeChatPermissionModePicker'

function picker(
  overrides: Partial<NativeChatPermissionModePickerState> = {}
): NativeChatPermissionModePickerState {
  return {
    current: 'ask',
    supported: ['ask', 'accept-edits', 'auto', 'bypass'],
    pending: false,
    disabled: false,
    setMode: vi.fn(async () => true),
    ...overrides
  }
}

function option(mode: AgentChatPermissionMode): HTMLElement {
  return screen.getByRole('radio', {
    name: (_name, element) => element.getAttribute('data-value') === mode
  })
}

afterEach(cleanup)

describe('NativeChatPermissionModePicker', () => {
  // A terminal-backed chat, or a host that offers no picker, gets no pill.
  it('renders nothing without a picker', () => {
    const { container } = render(<NativeChatPermissionModePicker picker={null} />)
    expect(container.innerHTML).toBe('')
  })

  it('lists each mode the agent offers, in order, with what it does', () => {
    render(<NativeChatPermissionModePicker picker={picker()} />)

    const menu = screen.getByTestId('permission-menu')
    expect(
      within(menu)
        .getAllByRole('radio')
        .map((row) => row.getAttribute('data-value'))
    ).toEqual(['ask', 'accept-edits', 'auto', 'bypass'])
    expect(within(menu).getByText('Ask for approval')).toBeTruthy()
    expect(within(menu).getByText('Always asks before edits and commands')).toBeTruthy()
    expect(within(menu).getByText('Edits files without asking; asks before commands')).toBeTruthy()
    expect(
      within(menu).getByText('Only asks for actions detected as potentially unsafe')
    ).toBeTruthy()
    expect(within(menu).getByText('Never asks; unrestricted access to your computer')).toBeTruthy()
  })

  it('offers Codex no edits-only mode', () => {
    render(
      <NativeChatPermissionModePicker picker={picker({ supported: ['ask', 'auto', 'bypass'] })} />
    )
    expect(screen.queryByText('Accept edits')).toBeNull()
  })

  it('names the current mode on the pill, by category for assistive tech', () => {
    render(<NativeChatPermissionModePicker picker={picker({ current: 'auto' })} />)
    const trigger = screen.getByRole('button', { name: 'Permissions Approve for me' })
    expect(trigger.textContent).toContain('Approve for me')
    expect(option('auto').getAttribute('aria-checked')).toBe('true')
  })

  it('shows Full access in the warning colour on the pill and in the menu', () => {
    render(<NativeChatPermissionModePicker picker={picker({ current: 'bypass' })} />)

    const trigger = screen.getByRole('button', { name: 'Permissions Full access' })
    expect(trigger.querySelector('.text-status-warning')?.textContent).toBe('Full access')
    expect(option('bypass').querySelector('.text-status-warning')).not.toBeNull()
    expect(option('ask').querySelector('.text-status-warning')).toBeNull()
  })

  it('keeps the ordinary colour on the pill for any other mode', () => {
    render(<NativeChatPermissionModePicker picker={picker({ current: 'ask' })} />)
    const trigger = screen.getByRole('button', { name: 'Permissions Ask for approval' })
    expect(trigger.querySelector('.text-status-warning')).toBeNull()
  })

  it('sends a pick of another mode and nothing for the current one', () => {
    const state = picker({ current: 'ask' })
    render(<NativeChatPermissionModePicker picker={state} />)

    fireEvent.click(option('ask'))
    expect(state.setMode).not.toHaveBeenCalled()
    fireEvent.click(option('bypass'))
    expect(state.setMode).toHaveBeenCalledWith('bypass')
  })

  it('locks the pill while nothing can carry a pick and the rows while one is in flight', () => {
    const { rerender } = render(
      <NativeChatPermissionModePicker picker={picker({ disabled: true })} />
    )
    expect(screen.getByTestId('permission-trigger').getAttribute('data-disabled')).toBe('true')

    rerender(<NativeChatPermissionModePicker picker={picker({ pending: true })} />)
    expect(option('bypass')).toHaveProperty('disabled', true)
  })
})
