import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { OnboardingInlineCommandTerminal } from '@/components/onboarding/OnboardingInlineCommandTerminal'
import type {
  ClaudeAccountSignIn,
  ClaudeRateLimitAccountsState,
  ClaudeSignInRequest
} from '../../../../shared/managed-account-types'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import { getClaudeAccountErrorDescription } from './accounts-pane-action-errors'
import { buildClaudeSignInCommand } from './claude-sign-in-command'

/**
 * Runs `claude auth login` against the account's folder in a terminal the user sees (superset
 * AddAccountDialog). The account is saved only once its folder holds a login.
 */
export function ClaudeSignInDialog({
  request,
  onClose,
  onSignedIn
}: {
  request: ClaudeSignInRequest | null
  onClose: () => void
  onSignedIn: (state: ClaudeRateLimitAccountsState) => void
}): React.JSX.Element {
  const [signIn, setSignIn] = useState<ClaudeAccountSignIn | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [finishing, setFinishing] = useState(false)

  useEffect(() => {
    setSignIn(null)
    setError(null)
    if (!request) {
      return
    }
    let cancelled = false
    window.api.claudeAccounts.beginSignIn(request).then(
      (next) => !cancelled && setSignIn(next),
      (beginError: unknown) => !cancelled && setError(getClaudeAccountErrorDescription(beginError))
    )
    return () => {
      cancelled = true
    }
  }, [request])

  const finish = async (): Promise<void> => {
    if (!signIn || finishing) {
      return
    }
    setFinishing(true)
    setError(null)
    try {
      onSignedIn(
        await window.api.claudeAccounts.finishSignIn({
          accountId: signIn.accountId,
          runtime: signIn.runtime,
          wslDistro: signIn.wslDistro
        })
      )
      onClose()
    } catch (finishError) {
      setError(getClaudeAccountErrorDescription(finishError))
    } finally {
      setFinishing(false)
    }
  }

  // Why: an abandoned sign-in must not leave its folder behind; the host keeps a saved account's.
  const cancel = (): void => {
    if (signIn) {
      const { accountId, runtime, wslDistro } = signIn
      void window.api.claudeAccounts.cancelSignIn({ accountId, runtime, wslDistro }).catch(() => {})
    }
    onClose()
  }

  const terminal = signIn
    ? buildClaudeSignInCommand(signIn, navigator.userAgent.includes('Windows') ? 'win32' : 'posix')
    : null

  return (
    <Dialog open={request !== null} onOpenChange={(open) => !open && cancel()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {request?.accountId
              ? translate('accounts.claude.signInAgainTitle', 'Sign in to Claude again')
              : translate('accounts.claude.addTitle', 'Add a Claude account')}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'accounts.claude.signInDescription',
              'Press Enter to run the command, then finish signing in in your browser. The account is saved once Claude has signed in.'
            )}
          </DialogDescription>
        </DialogHeader>
        {terminal ? (
          <OnboardingInlineCommandTerminal
            command={terminal.command}
            shellOverride={terminal.shellOverride}
            forceHostRuntime
            worktreeId="claude-sign-in-terminal"
            title={translate('accounts.claude.signInTerminal', 'Claude sign-in')}
            ariaLabel={translate('accounts.claude.signInTerminal', 'Claude sign-in')}
            terminalHeightPx={240}
            terminalTopMarginPx={0}
            autoScrollIntoView={false}
            onCommandFinished={(exitCode) => {
              if (exitCode === 0) {
                void finish()
              }
            }}
          />
        ) : error ? null : (
          <div className="flex h-24 items-center justify-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            {translate('accounts.claude.preparingSignIn', 'Preparing the account folder…')}
          </div>
        )}
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={cancel}>
            {translate('auto.components.settings.AccountsPane.dbb9626ed1', 'Cancel')}
          </Button>
          <Button onClick={() => void finish()} disabled={!signIn || finishing}>
            {finishing ? <Loader2 className="size-3 animate-spin" /> : null}
            {translate('accounts.claude.signInDone', 'Done')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
