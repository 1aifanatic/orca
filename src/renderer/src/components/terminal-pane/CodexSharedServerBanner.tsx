import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Check, Copy, Info, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { isCodexSharedServerWarningEnabled } from '../../../../shared/codex-terminal-server-isolation'

export const CODEX_DISABLE_AUTO_START_COMMAND = 'codex features disable daemon_auto_start'
// Why a ladder: Codex joins or starts the server a few seconds after its process appears.
const CHECK_DELAYS_MS = [1_000, 4_000, 10_000] as const
// Why module scope: a pane remounts on tab switches, and × must hold for the app session.
const dismissedPtyIds = new Set<string>()

/** Asks on the ladder until an answer is yes; returns a cancel that drops any later answer. */
function askUntilOnSharedServer(
  ask: (ptyId: string) => Promise<boolean>,
  ptyId: string,
  onJoined: () => void
): () => void {
  let cancelled = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const schedule = (attempt: number): void => {
    timer = setTimeout(() => {
      void ask(ptyId)
        .catch(() => false)
        .then((joined) => {
          if (cancelled) {
            return
          }
          if (joined) {
            onJoined()
          } else if (attempt + 1 < CHECK_DELAYS_MS.length) {
            schedule(attempt + 1)
          }
        })
    }, CHECK_DELAYS_MS[attempt])
  }
  schedule(0)
  return () => {
    cancelled = true
    clearTimeout(timer)
  }
}

function usePaneCodexOnSharedServer(ptyId: string, enabled: boolean): boolean {
  const [joined, setJoined] = useState(false)
  useEffect(() => {
    const ask = window.api.pty.isCodexOnSharedServer
    if (!enabled || !ask) {
      return
    }
    const cancel = askUntilOnSharedServer(ask, ptyId, () => setJoined(true))
    return () => {
      cancel()
      setJoined(false)
    }
  }, [enabled, ptyId])
  return joined
}

/** Reserves the banner's height at the top of its pane so the terminal refits below it. */
function useReservePaneTopSpace(): React.RefObject<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const banner = ref.current
    const pane = banner?.parentElement
    if (!banner || !pane) {
      return
    }
    const reserve = (): void => {
      pane.style.setProperty('--orca-pane-top-banner-height', `${banner.offsetHeight}px`)
    }
    reserve()
    pane.dataset.topBanner = ''
    const observer = new ResizeObserver(reserve)
    observer.observe(banner)
    return () => {
      observer.disconnect()
      delete pane.dataset.topBanner
      pane.style.removeProperty('--orca-pane-top-banner-height')
    }
  }, [])
  return ref
}

export function CodexSharedServerBanner({
  ptyId,
  paneKey
}: {
  ptyId: string
  paneKey: string
}): React.JSX.Element | null {
  const [dismissed, setDismissed] = useState(() => dismissedPtyIds.has(ptyId))
  const warningEnabled = useAppStore(
    (state) => state.settings !== null && isCodexSharedServerWarningEnabled(state.settings)
  )
  // Why either signal: a typed codex is seen by the process read, or by its hooks when that read has no command marks.
  const codexInPane = useAppStore(
    (state) =>
      state.paneForegroundAgentByPaneKey[paneKey]?.agent === 'codex' ||
      state.agentStatusByPaneKey[paneKey]?.agentType === 'codex'
  )
  const joined = usePaneCodexOnSharedServer(ptyId, warningEnabled && codexInPane && !dismissed)
  if (!joined) {
    return null
  }
  return (
    <CodexSharedServerBannerContent
      onDismiss={() => {
        dismissedPtyIds.add(ptyId)
        setDismissed(true)
      }}
      onDontShowAgain={() =>
        void useAppStore.getState().updateSettings({ codexSharedServerWarning: false })
      }
    />
  )
}

export function CodexSharedServerBannerContent({
  onDismiss,
  onDontShowAgain
}: {
  onDismiss: () => void
  onDontShowAgain: () => void
}): React.JSX.Element {
  const ref = useReservePaneTopSpace()
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) {
      return
    }
    const timer = setTimeout(() => setCopied(false), 1_500)
    return () => clearTimeout(timer)
  }, [copied])

  return (
    <div
      ref={ref}
      role="status"
      // Why pr-20: the pane's own split/close controls float over its top-right corner.
      className="pane-top-banner flex items-start gap-2 border-b border-border bg-card py-2 pr-20 pl-3 text-xs text-card-foreground"
    >
      <Info className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <p className="leading-5">
          {translate(
            'terminal.codexSharedServerBanner.body',
            'This Codex is sharing a server with other tabs, so its agent status may be wrong. To stop this for good, run:'
          )}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <code className="rounded-sm border border-border bg-muted px-1.5 py-0.5 font-mono text-xs">
            {CODEX_DISABLE_AUTO_START_COMMAND}
          </code>
          <Button
            type="button"
            variant="outline"
            size="xs"
            onClick={() =>
              void window.api.ui
                .writeClipboardText(CODEX_DISABLE_AUTO_START_COMMAND)
                .then(() => setCopied(true))
                .catch(() => {})
            }
          >
            {copied ? <Check /> : <Copy />}
            {copied
              ? translate('terminal.codexSharedServerBanner.copied', 'Copied')
              : translate('terminal.codexSharedServerBanner.copy', 'Copy')}
          </Button>
          <Button type="button" variant="ghost" size="xs" onClick={onDontShowAgain}>
            {translate('terminal.codexSharedServerBanner.dontShowAgain', "Don't show again")}
          </Button>
        </div>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={translate('terminal.codexSharedServerBanner.dismiss', 'Dismiss')}
        onClick={onDismiss}
      >
        <X />
      </Button>
    </div>
  )
}
