// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { SessionOptionDescriptor } from '../../../../shared/native-chat-session-options'
import { TooltipProvider } from '@/components/ui/tooltip'

vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

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

afterEach(cleanup)

function pickers(disabled: boolean): React.JSX.Element {
  return (
    <TooltipProvider>
      <NativeChatSessionOptionPickers
        surface={surface}
        snapshot={[model]}
        isWorking={false}
        pickerRequest={{ id: 'model', sequence: 1 }}
        disabled={disabled}
      />
    </TooltipProvider>
  )
}

it('a menu open when the lock lands offers nothing the host would refuse', async () => {
  const { rerender } = render(pickers(false))
  expect(document.querySelector('[role="menu"]')).not.toBeNull()
  rerender(pickers(true))
  const sonnet = [...document.querySelectorAll('[role="menuitemradio"]')].find((node) =>
    node.textContent?.includes('Sonnet')
  )
  expect(sonnet?.getAttribute('aria-disabled')).toBe('true')
  await act(async () => {
    fireEvent.click(sonnet!)
  })
  expect(surface.setOption).not.toHaveBeenCalled()
})
