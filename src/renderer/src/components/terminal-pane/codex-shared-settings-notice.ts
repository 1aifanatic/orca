import { useEffect } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { isPairedWebClientWindow } from '@/lib/desktop-window-chrome'
import type { CodexSharedSettingsNotice } from '../../../../shared/codex-config-sync-types'
import { whenCodexTerminalAppears } from './codex-terminal-presence'

function showCodexSharedSettingsNotice({ mcpServerNames }: CodexSharedSettingsNotice): void {
  // Why mark before showing: seen means shown, so a quit or reload never repeats it.
  useAppStore.getState().markCodexSharedSettingsNoticeSeen()
  toast.info(
    translate(
      'terminal.codexSharedSettingsNotice.title',
      'Codex in Orca now shares your Codex settings'
    ),
    {
      // Why a stable id: a late sync that resets the flag can't stack a second toast.
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
  const seen = useAppStore((s) => s.codexSharedSettingsNoticeSeen)

  useEffect(() => {
    // Why: main answers for its own Windows host, not a paired client's.
    if (seen || isPairedWebClientWindow()) {
      return
    }
    // Why no retry: only `seen` re-arms this, so a null answer waits for the next session.
    return whenCodexTerminalAppears(() => {
      void window.api.codexConfigSync
        .sharedSettingsNotice()
        .then((notice) => {
          if (notice) {
            showCodexSharedSettingsNotice(notice)
          }
        })
        .catch(console.error)
    })
  }, [seen])
}
