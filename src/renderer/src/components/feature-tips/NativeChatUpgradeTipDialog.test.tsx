import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { FEATURE_TIPS } from '../../../../shared/feature-tips'
import { NativeChatUpgradeTipDialog } from './NativeChatUpgradeTipDialog'

vi.mock('./NativeChatUpgradeFeatureTipVisual', () => ({
  NativeChatUpgradeFeatureTipVisual: () => <div data-testid="native-chat-upgrade-visual" />
}))

vi.mock('@/components/ui/dialog', () => ({
  Dialog: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <footer>{children}</footer>,
  DialogHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h1>{children}</h1>
}))

vi.mock('./FeatureTipActions', () => ({
  FeatureTipActions: ({ label, showSkip }: { label: string; showSkip: boolean }) => (
    <div data-testid="feature-tip-actions" data-skip={String(showSkip)}>
      {label}
    </div>
  )
}))

describe('NativeChatUpgradeTipDialog', () => {
  it('explains both Resume actions honestly and points at Chat settings', () => {
    const tip = FEATURE_TIPS.find((entry) => entry.id === 'native-chat-upgrade')
    if (!tip) {
      throw new Error('Expected native-chat-upgrade feature tip')
    }
    const markup = renderToStaticMarkup(
      <NativeChatUpgradeTipDialog
        open
        tip={tip}
        primaryBusy={false}
        onOpenChange={vi.fn()}
        onPrimaryAction={vi.fn()}
        onSettingsClick={vi.fn()}
      />
    )

    expect(markup).toContain('native-chat-upgrade-visual')
    expect(markup).toContain(tip.title)
    expect(markup).toContain('Agent Session History')
    expect(markup).toContain('Resume in New Native Chat')
    expect(markup).toContain('Resume in New CLI')
    expect(markup).toContain('The chat stays as it is')
    expect(markup).toContain('Settings → Chat')
    expect(markup).toContain('data-skip="false"')
    expect(markup).toContain('Got it')
  })
})
