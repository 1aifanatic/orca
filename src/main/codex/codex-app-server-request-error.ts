import { providerDiagnostic, type ProviderDiagnostic } from '../../shared/agent-session-failure'
import { isProviderDiagnosticPersonText } from '../../shared/provider-diagnostic-person-text'

/** Codex answered the call and refused it, rather than timing out or exiting. */
export class CodexAppServerRequestError extends Error {
  /** Codex's own `error.message`, kept apart from the Orca text around it. */
  readonly providerDiagnostic?: ProviderDiagnostic

  constructor(
    readonly method: string,
    readonly code: number | null,
    message: string,
    providerMessage?: string
  ) {
    super(message)
    this.name = 'CodexAppServerRequestError'
    const diagnostic =
      providerMessage === undefined
        ? undefined
        : providerDiagnostic(
            providerMessage,
            isProviderDiagnosticPersonText(providerMessage) ? 'person' : 'log'
          )
    if (diagnostic) {
      this.providerDiagnostic = diagnostic
    }
  }
}

export function isCodexAppServerRequestError(error: unknown): error is CodexAppServerRequestError {
  return error instanceof Error && error.name === 'CodexAppServerRequestError'
}
