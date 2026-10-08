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
        primaryButtonRef.current?.focus()
      }}
      visual={<NativeChatUpgradeFeatureTipVisual />}
    >
      <DialogHeader className="text-left">
        <div>
          <FeatureTipEyebrow label={tip.eyebrow} />
          <DialogTitle variant="feature-tip">{tip.title}</DialogTitle>
          <DialogDescription variant="feature-tip" className="mt-3 max-w-2xl">
            <span className="block">{tip.description}</span>
            <span className="mt-3 block">
              {translate(
                'featureTips.nativeChatUpgrade.sessionHistoryIntro',
                'To move a conversation between a chat and a terminal, open Agent Session History in the worktree sidebar:'
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
                'continues a CLI session as a native chat.'
              )}
            </span>
            <span className="mt-3 block">
              <span className="font-medium text-foreground">
                {translate('featureTips.nativeChatUpgrade.resumeInCliLabel', 'Resume in New CLI')}
              </span>{' '}
              {translate(
                'featureTips.nativeChatUpgrade.resumeInCliText',
                'starts a new CLI session from a copy of the chat. The chat stays as it is, and the two don’t stay in sync.'
              )}
            </span>
            <span className="mt-3 block">
              <FeatureTipSettingsLine
                lead={translate(
                  'featureTips.nativeChatUpgrade.settingsLead',
                  'Change it anytime in'
                )}
                link={translate('featureTips.nativeChatUpgrade.settingsLink', 'Settings → Chat')}
                onClick={onSettingsClick}
              />
            </span>
          </DialogDescription>
        </div>
      </DialogHeader>

      <DialogFooter className="mt-8 flex sm:justify-stretch">
        <FeatureTipActions
          currentTip={tip}
          primaryBusy={primaryBusy}
          onPrimaryAction={onPrimaryAction}
          onSkip={() => onOpenChange(false)}
          showSkip={false}
          fullWidth
          primaryButtonRef={primaryButtonRef}
          label={tip.ctaLabel}
        />
      </DialogFooter>
    </FeatureTipDialogFrame>
  )
}
