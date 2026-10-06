import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

const tooltipProviderMock = vi.hoisted(() => vi.fn())

vi.mock('@/components/ui/tooltip', () => ({
  TooltipProvider: (props: { children?: React.ReactNode }) => {
    tooltipProviderMock(props)
    return <div data-tooltip-provider>{props.children}</div>
  }
}))

import { TAB_TOOLTIP_DELAY_MS, TabStripTooltipProvider } from './TabStripTooltipProvider'

describe('TabStripTooltipProvider', () => {
  it('delays tab tooltips past the app default and disables Radix skip-delay', () => {
    const markup = renderToStaticMarkup(
      <TabStripTooltipProvider>
        <span>tab</span>
      </TabStripTooltipProvider>
    )

    expect(markup).toContain('data-tooltip-provider')
    expect(tooltipProviderMock).toHaveBeenCalledWith(
      expect.objectContaining({
        delayDuration: TAB_TOOLTIP_DELAY_MS,
        skipDelayDuration: 0
      })
    )
    // Why: pinned against the App provider's 400ms so a future edit can't quietly
    // make tab tooltips as eager as every other surface.
    expect(TAB_TOOLTIP_DELAY_MS).toBeGreaterThan(400)
  })
})
