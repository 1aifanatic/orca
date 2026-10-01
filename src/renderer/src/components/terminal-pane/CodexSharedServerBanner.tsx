import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Check, Copy, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { isCodexSharedServerWarningEnabled } from '../../../../shared/codex-terminal-server-isolation'

export const CODEX_DISABLE_AUTO_START_COMMAND = 'codex features disable daemon_auto_start'
// Why a second step: turning auto-start off stops new servers, but a running one is still joined.
const CODEX_STOP_SHARED_SERVER_COMMAND = 'codex app-server daemon stop'
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
  const [fixOpen, setFixOpen] = useState(false)

  return (
    <div
      ref={ref}
      role="status"
      // Why pr-20: the pane's own split/close controls float over its top-right corner.
      className="pane-top-banner @container border-b border-status-warning-border bg-status-warning-background py-2 pr-16 pl-3 text-xs"
    >
      {/* Why a container query: split panes are narrow, so actions drop below the text there.
          Narrow and wide variants never share a property, so an unlayered utility cannot override them. */}
      <div className="@[44rem]:flex @[44rem]:items-center @[44rem]:gap-2">
        <div className="flex min-w-0 flex-1 items-start gap-2.5">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-status-warning" aria-hidden="true" />
          <div className="min-w-0 leading-5">
            <p className="font-medium text-foreground">
              {translate(
                'terminal.codexSharedServerBanner.title',
                'This Codex is sharing a server with your other Codex tabs'
              )}
            </p>
            <p className="text-muted-foreground">
              {translate(
                'terminal.codexSharedServerBanner.body',
                'Sessions may end unexpectedly, and agent status may be wrong.'
              )}{' '}
              <button
                type="button"
                className="text-foreground underline underline-offset-2 hover:text-foreground/80"
                onClick={() => setFixOpen(true)}
              >
                {translate('terminal.codexSharedServerBanner.learnMore', 'Learn more')}
              </button>
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1 @[44rem]:shrink-0 @max-[44rem]:mt-1.5 @max-[44rem]:pl-6.5">
          <Button type="button" variant="outline" size="xs" onClick={() => setFixOpen(true)}>
            {translate('terminal.codexSharedServerBanner.fix', 'Fix')}
          </Button>
          <Button type="button" variant="ghost" size="xs" onClick={onDontShowAgain}>
            {translate('terminal.codexSharedServerBanner.dontShowAgain', "Don't show again")}
          </Button>
          <Button type="button" variant="ghost" size="xs" onClick={onDismiss}>
            {translate('terminal.codexSharedServerBanner.dismiss', 'Dismiss')}
          </Button>
        </div>
      </div>
      <CodexSharedServerFixDialog open={fixOpen} onOpenChange={setFixOpen} />
    </div>
  )
}

function CommandBlock({ command }: { command: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) {
      return
    }
    const timer = setTimeout(() => setCopied(false), 1_500)
    return () => clearTimeout(timer)
  }, [copied])

  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-muted py-1.5 pr-1.5 pl-3">
      <code className="min-w-0 flex-1 overflow-x-auto font-mono text-xs whitespace-nowrap">
        {command}
      </code>
      <Button
        type="button"
        variant="outline"
        size="xs"
        onClick={() =>
          void window.api.ui
            .writeClipboardText(command)
            .then(() => setCopied(true))
            .catch(() => {})
        }
      >
        {copied ? <Check /> : <Copy />}
        {copied
          ? translate('terminal.codexSharedServerBanner.copied', 'Copied')
          : translate('terminal.codexSharedServerBanner.copy', 'Copy')}
      </Button>
    </div>
  )
}

function FixStep({
  step,
  title,
  command,
  note,
  warning
}: {
  step: number
  title: string
  command: string
  note?: string
  warning?: string
}): React.JSX.Element {
  return (
    <div className="flex gap-3">
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground">
        {step}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <p className="text-sm font-medium">{title}</p>
        <CommandBlock command={command} />
        {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
        {warning ? <p className="text-xs text-status-warning">{warning}</p> : null}
      </div>
    </div>
  )
}

function CodexSharedServerFixDialog({
  open,
  onOpenChange
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {translate(
              'terminal.codexSharedServerBanner.dialogTitle',
              'Give each Codex tab its own server'
            )}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'terminal.codexSharedServerBanner.dialogDescription',
              'Codex sessions started directly in a terminal share one background server. Orca keeps the Codex sessions it starts separate. When sessions share a server, closing one can end the others, and agent status can be wrong.'
            )}
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm font-medium">
          {translate(
            'terminal.codexSharedServerBanner.stepsHeading',
            'Run these once in any terminal'
          )}
        </p>
        <div className="flex flex-col gap-4">
          <FixStep
            step={1}
            title={translate('terminal.codexSharedServerBanner.step1Title', 'Turn off Codex server sharing')}
            command={CODEX_DISABLE_AUTO_START_COMMAND}
            note={translate(
              'terminal.codexSharedServerBanner.step1Note',
              'This changes your Codex settings, so it also applies outside Orca.'
            )}
          />
          <FixStep
            step={2}
            title={translate('terminal.codexSharedServerBanner.step2Title', 'Stop the running shared server')}
            command={CODEX_STOP_SHARED_SERVER_COMMAND}
            warning={translate(
              'terminal.codexSharedServerBanner.step2Warning',
              'Closes any open Codex sessions that share the server'
            )}
          />
        </div>
        <DialogFooter className="items-center sm:justify-between">
          <p className="text-xs text-muted-foreground">
            {translate(
              'terminal.codexSharedServerBanner.undo',
              'To undo, run codex features enable daemon_auto_start.'
            )}
          </p>
          <Button type="button" onClick={() => onOpenChange(false)}>
            {translate('terminal.codexSharedServerBanner.done', 'Done')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
