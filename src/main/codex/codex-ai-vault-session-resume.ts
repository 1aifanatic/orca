import type {
  AiVaultPrepareSessionResumeArgs,
  AiVaultPrepareSessionResumeResult
} from '../../shared/ai-vault-resume-preparation'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'
import { parseWslUncPath } from '../../shared/wsl-paths'
import type { CodexRuntimeHomeService } from '../codex-accounts/runtime-home-service'
import { prepareLegacySharedCodexSessionResume } from './codex-legacy-session-resume'

type CodexAiVaultRuntimeHome = Pick<
  CodexRuntimeHomeService,
  'isHostSystemDefaultRealHomeSelected' | 'resolveSelectedHostAccountCodexHomePathForResume'
>

/** Keeps window and serve AI Vault resumes behind the same refusing account-home gate. */
export async function prepareCodexAiVaultSessionResume(
  args: AiVaultPrepareSessionResumeArgs,
  options: {
    runtimeHome: CodexAiVaultRuntimeHome | null
    systemCodexHomePath: string | undefined
    /** Readies a home a pane will pin as CODEX_HOME instead of the selected account's. */
    preparePinnedLaunchHome: (home: string) => Promise<void>
  }
): Promise<AiVaultPrepareSessionResumeResult> {
  const result = await prepareLegacySharedCodexSessionResume(args, {
    isHostSystemDefaultRealHomeSelected: () =>
      options.runtimeHome?.isHostSystemDefaultRealHomeSelected() === true,
    getSelectedHostAccountCodexHomePath: () =>
      options.runtimeHome?.resolveSelectedHostAccountCodexHomePathForResume() ?? null,
    systemCodexHomePath: options.systemCodexHomePath
  })
  // Why: a fork carries no provider session, so the pane spawn never readies the home a resume
  // would; when it keeps the row's own home, that home needs the same hooks here.
  if (
    args.fork &&
    !result.useRealCodexHome &&
    !result.substituteCodexHome &&
    args.codexHome &&
    args.executionHostId === LOCAL_EXECUTION_HOST_ID &&
    parseWslUncPath(args.codexHome) === null
  ) {
    await options.preparePinnedLaunchHome(args.codexHome)
  }
  return result
}
