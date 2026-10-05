import type {
  CodexEnvironmentHomeOverride,
  CodexShellStartupHomeOverride
} from './codex-real-home-path'

export type CodexPaneHomeRoute =
  | 'real-home'
  | 'shared-home'
  | 'account-home'
  /** Older builds only; kept so their surviving panes still parse. */
  | 'custom-home'
  | 'wsl-home'

export type CodexPaneAccountRecord = {
  /** 'host' or 'wsl:<distro>' — the selection lane this pane launched from. */
  selectionKey: string
  /** Managed account id, or null for the system-default account. */
  accountId: string | null
  /** Absent only on records written before route provenance was introduced. */
  homeRoute?: CodexPaneHomeRoute
  /** The custom CODEX_HOME a shell startup file set at launch, naming the pane's home. */
  shellStartupHomeOverride?: CodexShellStartupHomeOverride
  /** The custom CODEX_HOME the launch environment set, naming the pane's home. */
  environmentHomeOverride?: CodexEnvironmentHomeOverride
}

export type CodexPaneAccountRegistryFile = {
  version: 2
  panes: Record<string, CodexPaneAccountRecord>
  /** Set after record loss until daemon inventory proves no unattributed pane remains. */
  legacyWslAttributionUnknown?: true
}
