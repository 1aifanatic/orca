import { useEffect } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { isPairedWebClientWindow } from '@/lib/desktop-window-chrome'
import type { CodexSharedSettingsNotice } from '../../../../shared/persisted-ui-state-types'
import {
  didCodexNoticeInputsChange,
  hasCodexTerminal,
  isCodexTerminalServerIsolationNoticeShowing,
  shouldShowCodexTerminalServerIsolationNotice,
  type CodexNoticeState
} from './codex-terminal-server-isolation-notice'

type CodexSharedSettingsNoticeState = CodexNoticeState & Pick<AppState, 'codexSharedSettingsNotice'>

export function getDueCodexSharedSettingsNotice(
  state: CodexSharedSettingsNoticeState
): CodexSharedSettingsNotice | null {
  const notice = state.codexSharedSettingsNotice
  return notice &&
    state.persistedUIReady &&
    hasCodexTerminal(state) &&
    // Why: one Codex notice at a time; the server-isolation one goes first.
    !shouldShowCodexTerminalServerIsolationNotice(state) &&
    !isCodexTerminalServerIsolationNoticeShowing()
    ? notice
    : null
}

function showCodexSharedSettingsNotice({ mcpServerNames }: CodexSharedSettingsNotice): void {
  // Why clear before showing: shown means seen, so a quit or reload never repeats it.
  useAppStore.getState().clearCodexSharedSettingsNotice()
  toast.info(
    translate(
      'terminal.codexSharedSettingsNotice.title',
      'Codex in Orca now shares your Codex settings'
    ),
    {
      // Why a stable id: a late sync that re-hydrates the notice can't stack a second toast.
      id: 'codex-shared-settings-notice',
      description:
        mcpServerNames.length === 0
          ? translate(
              'terminal.codexSharedSettingsNotice.description',
              'Codex in Orca on Windows now uses the same settings folder as Codex outside Orca. It may ask you to trust a folder or approve a command again.'
            )
          : translate(
              'terminal.codexSharedSettingsNotice.descriptionWithMcpServers',
              'Codex in Orca on Windows now uses the same settings folder as Codex outside Orca. It may ask you to trust a folder or approve a command again. MCP servers you added from an Orca terminal ({{names}}) need to be added again.',
              { names: mcpServerNames.join(', ') }
            ),
      duration: 15_000
    }
  )
}

export function useCodexSharedSettingsNotice(): void {
  const notice = useAppStore((s) => s.codexSharedSettingsNotice)

  useEffect(() => {
    // Why: main decides this for its own local Windows host, not a paired client's.
    if (!notice || isPairedWebClientWindow()) {
      return
    }
    const showIfDue = (state: CodexSharedSettingsNoticeState): boolean => {
      const due = getDueCodexSharedSettingsNotice(state)
      if (due) {
        showCodexSharedSettingsNotice(due)
      }
      return due !== null
    }
    if (showIfDue(useAppStore.getState())) {
      return
    }
    // Why: also re-checks once a showing isolation notice is gone, on the next Codex activity.
    const unsubscribe = useAppStore.subscribe((state, previous) => {
      if (didCodexNoticeInputsChange(state, previous) && showIfDue(state)) {
        unsubscribe()
      }
    })
    return unsubscribe
  }, [notice])
}
