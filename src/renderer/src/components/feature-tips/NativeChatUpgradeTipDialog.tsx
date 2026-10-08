import { useRef, type JSX } from 'react'
import type { FeatureTip } from '../../../../shared/feature-tips'
import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'
import { FeatureTipActions } from './FeatureTipActions'
import {
  FeatureTipDialogFrame,
  FeatureTipEyebrow,
  FeatureTipSettingsLine
} from './FeatureTipDialogFrame'
import { NativeChatUpgradeFeatureTipVisual } from './NativeChatUpgradeFeatureTipVisual'

export function NativeChatUpgradeTipDialog({
  open,
  tip,
  primaryBusy,
  onOpenChange,
  onPrimaryAction,
  onSettingsClick
}: {
  open: boolean
  tip: FeatureTip
  primaryBusy: boolean
  onOpenChange: (open: boolean) => void
  onPrimaryAction: () => void
  onSettingsClick: () => void
}): JSX.Element {
  const primaryButtonRef = useRef<HTMLButtonElement>(null)

  return (
    <FeatureTipDialogFrame
      open={open}
      onOpenChange={onOpenChange}
      onOpenAutoFocus={(event) => {
        event.preventDefault()
        // Why: opening must leave the badge and title in view, whatever the copy's height.
        primaryButtonRef.current?.focus({ preventScroll: true })
      }}
      visual={<NativeChatUpgradeFeatureTipVisual />}
    >
      {/* Why: only the copy scrolls, so the focused Got it button stays visible with long copy. */}
      <div className="flex min-h-0 flex-1 flex-col">
        <div
          data-testid="native-chat-upgrade-tip-copy"
          className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto"
        >
          <DialogHeader className="text-left">
            <div>
              <FeatureTipEyebrow
                label={translate('featureTips.nativeChatUpgrade.eyebrow', tip.eyebrow)}
              />
              <DialogTitle variant="feature-tip">
                {translate('featureTips.nativeChatUpgrade.title', tip.title)}
              </DialogTitle>
              <DialogDescription variant="feature-tip" className="mt-3 max-w-2xl">
                <span className="block">
                  {translate('featureTips.nativeChatUpgrade.description', tip.description)}
                </span>
                <span className="mt-3 block">
                  {translate(
                    'featureTips.nativeChatUpgrade.sessionHistoryIntro',
                    'In Agent Session History, in the right sidebar:'
                  )}
                </span>
                <span className="mt-3 block">
                  <span className="font-medium text-foreground">
                    {translate(
                      'featureTips.nativeChatUpgrade.resumeInChatLabel',
                      'Resume in New Native Chat'
                    )}
                  </span>{' '}
                  {translate(
                    'featureTips.nativeChatUpgrade.resumeInChatText',
                    'moves a CLI session into a chat.'
                  )}
                </span>
                <span className="mt-3 block">
                  <span className="font-medium text-foreground">
                    {translate(
                      'featureTips.nativeChatUpgrade.resumeInCliLabel',
                      'Resume in New CLI'
                    )}
                  </span>{' '}
                  {translate(
                    'featureTips.nativeChatUpgrade.resumeInCliText',
                    'copies a Claude or Codex chat into a new CLI session. The chat stays as it is.'
                  )}
                </span>
                <span className="mt-3 block">
                  <FeatureTipSettingsLine
                    lead={translate(
                      'featureTips.nativeChatUpgrade.settingsLead',
                      'Change it anytime in'
                    )}
                    link={translate(
                      'featureTips.nativeChatUpgrade.settingsLink',
                      'Settings → Chat'
                    )}
                    onClick={onSettingsClick}
                  />
                </span>
              </DialogDescription>
            </div>
          </DialogHeader>
        </div>

        <DialogFooter className="mt-6 flex shrink-0 sm:justify-stretch">
          <FeatureTipActions
            currentTip={tip}
            primaryBusy={primaryBusy}
            onPrimaryAction={onPrimaryAction}
            onSkip={() => onOpenChange(false)}
            showSkip={false}
            fullWidth
            primaryButtonRef={primaryButtonRef}
            label={translate('featureTips.nativeChatUpgrade.cta', tip.ctaLabel)}
          />
        </DialogFooter>
      </div>
    </FeatureTipDialogFrame>
  )
}
