import { useId, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Textarea } from '@/components/ui/textarea'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import { hasExtraAgentArgs } from '../../../../shared/automation-extra-agent-args'
import { AUTOMATION_EDITOR_SECTION_LABEL_CLASS } from './automation-page-parts'
import {
  draftExtraAgentArgsNeedFreshSession,
  getDraftExtraAgentArgsError
} from './automation-draft-model'
import type { AutomationDraft } from './AutomationEditorDialog'

type AutomationExtraAgentArgsFieldProps = {
  draft: AutomationDraft
  onDraftChange: (updater: (current: AutomationDraft) => AutomationDraft) => void
}

export function AutomationExtraAgentArgsField({
  draft,
  onDraftChange
}: AutomationExtraAgentArgsFieldProps): React.JSX.Element {
  const hasExtras = hasExtraAgentArgs(draft.extraAgentArgs)
  const [open, setOpen] = useState(hasExtras)
  const error = getDraftExtraAgentArgsError(draft)
  const needsFreshSession = draftExtraAgentArgsNeedFreshSession(draft)
  // Why: a problem the user must fix can't hide behind a collapsed section.
  const expanded = open || Boolean(error) || needsFreshSession
  const inputId = useId()
  const messageId = useId()
  return (
    <Collapsible open={expanded} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button
          type="button"
          className="flex w-full items-center justify-between gap-2 rounded-sm text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          <span className={AUTOMATION_EDITOR_SECTION_LABEL_CLASS}>
            {translate('auto.components.automations.extraAgentArgs.advanced', 'Advanced')}
          </span>
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            {!expanded && hasExtras
              ? translate('auto.components.automations.extraAgentArgs.configured', 'Configured')
              : null}
            <ChevronDown
              className={cn('size-3.5 transition-transform', expanded && 'rotate-180')}
            />
          </span>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-2 space-y-1.5">
          <label htmlFor={inputId} className="block text-xs text-muted-foreground">
            {translate('auto.components.automations.extraAgentArgs.label', 'Extra agent arguments')}
          </label>
          <Textarea
            id={inputId}
            variant="code"
            value={draft.extraAgentArgs}
            spellCheck={false}
            aria-invalid={Boolean(error) || needsFreshSession}
            aria-describedby={messageId}
            placeholder="--model opus --add-dir docs"
            onChange={(event) =>
              onDraftChange((current) => ({
                ...current,
                extraAgentArgs: event.target.value
              }))
            }
            className="min-h-14 resize-none"
          />
          <div id={messageId} className="space-y-1.5">
            {error ? <p className="text-xs text-destructive">{error}</p> : null}
            {needsFreshSession ? (
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs text-destructive">
                  {translate(
                    'auto.components.automations.extraAgentArgs.needsFreshSession',
                    'Extra arguments require a fresh session for every run.'
                  )}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  className="shrink-0"
                  onClick={() => onDraftChange((current) => ({ ...current, reuseSession: false }))}
                >
                  {translate(
                    'auto.components.automations.extraAgentArgs.useFreshSessions',
                    'Use fresh sessions'
                  )}
                </Button>
              </div>
            ) : null}
            <p className="text-[11px] text-muted-foreground">
              {translate(
                'auto.components.automations.extraAgentArgs.helper',
                "Added to this host's default arguments for each fresh session."
              )}
            </p>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
