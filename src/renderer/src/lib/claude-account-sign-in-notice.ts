import { useEffect } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { isPairedWebClientWindow } from '@/lib/desktop-window-chrome'
import { claudeAccountToSignIn, signInToClaudeAccount } from './claude-account-sign-in'

const NOTICE_TOAST_ID = 'claude-account-sign-in-notice'

function showClaudeAccountSignInNotice(): void {
  toast.info(
    translate(
      'accounts.claude.signInNotice.title',
      'Claude accounts now stay signed in on their own.'
    ),
    {
      // Why a stable id: a late sync that resets the flag can't stack a second toast.
      id: NOTICE_TOAST_ID,
      description: translate(
        'accounts.claude.signInNotice.description',
        'Sign in once to each account to keep using it.'
      ),
      // Why no timeout: it is marked seen before showing, so an auto-close would lose it for good.
      duration: Infinity,
      action: {
        label: translate('accounts.claude.signIn', 'Sign in'),
        onClick: () => {
          // Why read again: a sign-in elsewhere may have happened since the toast appeared.
          void window.api.claudeAccounts.list().then((state) => {
            const accountId = claudeAccountToSignIn(state)
            return accountId ? signInToClaudeAccount(accountId) : false
          })
        }
      }
    }
  )
}

/** Once, on the first launch after the update: only when a saved account still needs a sign-in. */
export function useClaudeAccountSignInNotice(): void {
  // Why no hydration check: the flag defaults to true until the persisted value arrives.
  const seen = useAppStore((s) => s.claudeAccountSignInNoticeSeen)

  useEffect(() => {
    // Why skip paired web clients: the accounts are the host's, whose own window shows this.
    if (seen || isPairedWebClientWindow()) {
      return
    }
    let cancelled = false
    void window.api.claudeAccounts
      .list()
      .then((state) => {
        if (cancelled) {
          return
        }
        // Why mark either way: the update happened once; a later sign-out is not this news.
        useAppStore.getState().markClaudeAccountSignInNoticeSeen()
        if (claudeAccountToSignIn(state)) {
          showClaudeAccountSignInNotice()
        }
      })
      .catch((error: unknown) => console.warn('[claude-accounts] Sign-in notice skipped:', error))
    return () => {
      cancelled = true
    }
  }, [seen])
}
