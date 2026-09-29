import type { TuiAgent } from '../../../../shared/tui-agent'
import {
  normalizeAgentProviderSession,
  type AgentProviderSessionMetadata
} from '../../../../shared/agent-session-resume'
import { SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV } from '../../../../shared/setup-agent-sequencing'
import {
  dropAgentResumeArgvFromCommand,
  findAgentResumeArgvSuffix
} from '../../../../shared/agent-resume-argv-drop'
import { quoteStartupArg, type AgentStartupShell } from '../../../../shared/tui-agent-startup-shell'
import { resolveWindowsShellStartupFamily } from '../../../../shared/windows-terminal-shell'
import type { CodexAccountSelectionTarget } from '../../../codex-accounts/runtime-selection'
import { dropUnverifiedCodexResumeArgv } from '../../../codex/codex-unverified-resume-launch'
import type { CodexSessionResumePreparation } from '../../../codex/codex-session-resume-home'
import {
  formatCodexSessionHookTrustOverride,
  type CodexSessionHookTrust
} from '../../../codex/codex-real-home-session-hook-trust'
import { CODEX_RESUME_AUTH_UNAVAILABLE_MESSAGE, codexHomePathsEqual } from './codex-home'
import type { PrepareCodexSessionResume } from './types'

export type CodexResumeLaunch = {
  codexResumeHome: Extract<CodexSessionResumePreparation, { outcome: 'resume' }> | null
  command: string | undefined
  notifyResumeUnavailable: boolean
  droppedResumeArgv: boolean
  providerSession: AgentProviderSessionMetadata | null
  /** The quoted `-c` override spliced in front of the resume argv, if any. */
  sessionHookTrustArgs: string | null
}

export type PreparedCodexResumeHome = {
  providerSession: AgentProviderSessionMetadata
  preparation: Promise<CodexSessionResumePreparation | null>
  startupShell: AgentStartupShell
}

export type PrepareCodexResumeHomeArgs = {
  connectionId?: string | null
  launchAgent?: TuiAgent
  providerSession?: AgentProviderSessionMetadata
  target: CodexAccountSelectionTarget
  launchEnv?: NodeJS.ProcessEnv
  workspacePath?: string
  /** The pane's resolved shell; on Windows it decides how the command line is quoted. */
  shellOverride?: string
}

/** The dialect the pane's shell parses the launch command in. */
export function resolveCodexResumeStartupShell(
  platform: NodeJS.Platform,
  shellOverride: string | undefined
): AgentStartupShell {
  return platform === 'win32' ? resolveWindowsShellStartupFamily(shellOverride) : 'posix'
}

export function prepareCodexResumeHome(
  prepareCodexSessionResume: PrepareCodexSessionResume | undefined,
  args: PrepareCodexResumeHomeArgs
): PreparedCodexResumeHome | null {
  if (args.connectionId || args.launchAgent !== 'codex' || !prepareCodexSessionResume) {
    return null
  }
  const providerSession = normalizeAgentProviderSession(args.providerSession)
  if (!providerSession) {
    return null
  }
  return {
    providerSession,
    preparation: prepareCodexSessionResume({
      providerSession,
      target: args.target,
      launchEnv: args.launchEnv,
      workspacePath: args.workspacePath
    }),
    startupShell: resolveCodexResumeStartupShell(process.platform, args.shellOverride)
  }
}

/** Kept separate from resolveCodexResumeLaunch so non-Codex spawns never await:
 *  an extra tick reorders the pane-spawn reservation races this handler arbitrates. */
export function noCodexResumeLaunch(command: string | undefined): CodexResumeLaunch {
  return {
    codexResumeHome: null,
    command,
    notifyResumeUnavailable: false,
    droppedResumeArgv: false,
    providerSession: null,
    sessionHookTrustArgs: null
  }
}

// Why: cmd expands `%` and `!` even inside double quotes, and a caret there is literal.
const CMD_UNQUOTABLE = /[\^&|<>()%!"]/

function quoteSessionHookTrustArgs(
  trust: readonly CodexSessionHookTrust[] | undefined,
  shell: AgentStartupShell
): string | null {
  const override = trust ? formatCodexSessionHookTrustOverride(trust) : null
  if (!override || (shell === 'cmd' && CMD_UNQUOTABLE.test(override))) {
    return null
  }
  return `${quoteStartupArg('-c', shell)} ${quoteStartupArg(override, shell)}`
}

/** Puts the override before `resume <id>`, where Codex reads it as a root flag. */
function insertBeforeCodexResumeArgv(
  command: string,
  providerSession: AgentProviderSessionMetadata,
  args: string
): string | null {
  const found = findAgentResumeArgvSuffix({ command, agent: 'codex', providerSession })
  return found.status === 'found' ? `${found.base} ${args} ${found.suffix}` : null
}

/** The command a Codex launch actually runs: unchanged when provenance is verified,
 *  stripped of `resume <id>` when it is not. */
export function resolveCodexResumeLaunch(
  command: string | undefined,
  preparation: PreparedCodexResumeHome
): Promise<CodexResumeLaunch> {
  return preparation.preparation.then((prepared) => {
    const providerSession = preparation.providerSession
    if (prepared?.outcome !== 'fresh') {
      const trustArgs = quoteSessionHookTrustArgs(
        prepared?.sessionHookTrust,
        preparation.startupShell
      )
      const trustedCommand =
        trustArgs && command
          ? insertBeforeCodexResumeArgv(command, providerSession, trustArgs)
          : null
      return {
        codexResumeHome: prepared ?? null,
        command: trustedCommand ?? command,
        notifyResumeUnavailable: false,
        droppedResumeArgv: false,
        providerSession,
        sessionHookTrustArgs: trustedCommand ? trustArgs : null
      }
    }
    const dropped = dropUnverifiedCodexResumeArgv({
      command,
      providerSession,
      claimedCodexProvenance: prepared.claimedCodexProvenance
    })
    return {
      codexResumeHome: null,
      command: dropped.command,
      // Why: staying silent only makes sense for metadata that positively belongs to
      // another agent; a resume with no transcript path at all still owes the user a notice.
      notifyResumeUnavailable:
        dropped.droppedResumeArgv &&
        (prepared.claimedCodexProvenance || !providerSession.transcriptPath),
      droppedResumeArgv: dropped.droppedResumeArgv,
      providerSession,
      sessionHookTrustArgs: null
    }
  })
}

export async function reconcileSharedRuntimeResumeHome(
  resumeHome: Extract<CodexSessionResumePreparation, { outcome: 'resume' }>,
  resolveCurrentHome: () => string | null | Promise<string | null>
): Promise<string> {
  if (!resumeHome.reconcileSharedRuntimeAuth) {
    return resumeHome.codexHomePath
  }
  const currentHome = await resolveCurrentHome()
  if (!codexHomePathsEqual(currentHome, resumeHome.codexHomePath)) {
    throw new Error(CODEX_RESUME_AUTH_UNAVAILABLE_MESSAGE)
  }
  return resumeHome.codexHomePath
}

/** Why: buildPtyHostEnv prefers ORCA_SEQUENCED_STARTUP_COMMAND over the launch command
 *  and the sequenced wrapper `eval`s it, so a resume argv rewrite has to go there too. */
export function rewriteSequencedStartupResumeArgv<T extends Record<string, string> | undefined>(
  env: T,
  launch: CodexResumeLaunch
): T {
  const sequenced = env?.[SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]
  if (!env || !sequenced || !launch.providerSession) {
    return env
  }
  let rewritten: string | null = null
  if (launch.droppedResumeArgv) {
    const drop = dropAgentResumeArgvFromCommand({
      command: sequenced,
      agent: 'codex',
      providerSession: launch.providerSession
    })
    rewritten = drop.status === 'dropped' ? drop.command : null
  } else if (launch.sessionHookTrustArgs) {
    rewritten = insertBeforeCodexResumeArgv(
      sequenced,
      launch.providerSession,
      launch.sessionHookTrustArgs
    )
  }
  return rewritten === null
    ? env
    : { ...env, [SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV]: rewritten }
}
