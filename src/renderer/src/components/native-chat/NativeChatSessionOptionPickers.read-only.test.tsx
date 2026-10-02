// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import type * as ReactModule from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import type { SessionOptionDescriptor } from '../../../../shared/native-chat-session-options'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))
vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>
}))
const mounts = vi.hoisted(() => new Array<boolean>())
vi.mock('@/components/ui/dropdown-menu', async () => {
  const React = await vi.importActual<typeof ReactModule>('react')
  const Pass = ({ children }: { children?: React.ReactNode }) => <div>{children}</div>
  return {
    // Records each mount and whether it mounted open, as an uncontrolled menu opens on defaultOpen.
    DropdownMenu: ({
      children,
      defaultOpen
    }: {
      children: React.ReactNode
      defaultOpen?: boolean
    }) => {
      React.useEffect(() => {
        mounts.push(Boolean(defaultOpen))
      }, [])
      return <div>{children}</div>
    },
    DropdownMenuTrigger: Pass,
    DropdownMenuContent: Pass,
    DropdownMenuLabel: Pass,
    DropdownMenuSeparator: () => <hr />,
    DropdownMenuItem: Pass,
    DropdownMenuRadioGroup: Pass,
    DropdownMenuRadioItem: Pass
  }
})

import { NativeChatSessionOptionPickers } from './NativeChatSessionOptionPickers'

const surface = {
  getSnapshot: vi.fn(() => []),
  setOption: vi.fn(),
  invokeAction: vi.fn(),
  subscribe: vi.fn(() => vi.fn())
}
const model: SessionOptionDescriptor = {
  id: 'model',
  label: 'Model',
  category: 'model',
  kind: {
    type: 'select',
    currentValue: 'opus',
    choices: [
      { value: 'opus', label: 'Opus' },
      { value: 'sonnet', label: 'Sonnet' }
    ]
  },
  valueSource: 'applied',
  transport: 'catalog',
  settable: true
}

afterEach(() => {
  cleanup()
  mounts.length = 0
})

it('an old /model request does not reopen its menu when a read-only chat unlocks', () => {
  const props = { surface, snapshot: [model], isWorking: false }
  const request = { id: 'model', sequence: 1 }
  const { rerender } = render(<NativeChatSessionOptionPickers {...props} pickerRequest={request} />)
  expect(mounts).toEqual([true])
  rerender(<NativeChatSessionOptionPickers {...props} pickerRequest={request} disabled />)
  rerender(<NativeChatSessionOptionPickers {...props} pickerRequest={request} disabled={false} />)
  expect(mounts).toEqual([true])
})

it('a request made while locked mounts the menu shut', () => {
  render(
    <NativeChatSessionOptionPickers
      surface={surface}
      snapshot={[model]}
      isWorking={false}
      pickerRequest={{ id: 'model', sequence: 2 }}
      disabled
    />
  )
  expect(mounts).toEqual([false])
})
