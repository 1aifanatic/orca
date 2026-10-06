import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { TAB_TOOLTIP_DELAY_MS } from './TabStripTooltipProvider'

const stateTooltipMock = vi.hoisted(() =>
  vi.fn((props: { children?: React.ReactNode }) => props.children)
)

vi.mock('@/components/StateIndicatorTooltip', () => ({
  StateIndicatorTooltip: (props: { children?: React.ReactNode; delayMs?: number }) => {
    stateTooltipMock(props)
    return <>{props.children}</>
  }
}))

import { TerminalTabLeadingIcon } from './TerminalTabLeadingIcon'

describe('TerminalTabLeadingIcon agent-state tooltip', () => {
  it('uses the tab-strip delay instead of the fast state-indicator default', () => {
    renderToStaticMarkup(
      <TerminalTabLeadingIcon
        agent="claude"
        activityStatus="working"
        shell={undefined}
        showUnreadActivity={false}
        isActive
      />
    )

    expect(stateTooltipMock).toHaveBeenCalledWith(
      expect.objectContaining({ delayMs: TAB_TOOLTIP_DELAY_MS })
    )
  })
})
