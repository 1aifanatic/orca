/**
 * Deploy failures that mean managed orcad can't run on this host at all, as opposed to failures
 * a later connect may not hit again. Only these send a host back to the pinned-relay ladder.
 */

/** No orcad build exists for this host's platform or target. */
export class OrcadHostUnsupportedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OrcadHostUnsupportedError'
  }
}

/** This build carries no orcad template (dev builds): retried once the app version changes. */
export class OrcadArtifactsUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OrcadArtifactsUnavailableError'
  }
}

/** The host refuses port forwarding and can't run the stdio bridge either. */
export class OrcadStdioBridgeUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OrcadStdioBridgeUnavailableError'
  }
}

export const ORCAD_TUNNEL_UNAVAILABLE_REASON = 'ssh_tunnel_unavailable'

export type OrcadHostUnavailableReason =
  | 'unsupported_host'
  | 'artifacts_unavailable'
  | 'libc_unidentified'
  | 'runtime_self_test'
  | 'security_software'
  | 'native_preflight'
  | typeof ORCAD_TUNNEL_UNAVAILABLE_REASON

const UNAVAILABLE_BY_ERROR_NAME: Record<string, OrcadHostUnavailableReason> = {
  OrcadHostUnsupportedError: 'unsupported_host',
  OrcadArtifactsUnavailableError: 'artifacts_unavailable',
  OrcadRemoteLaunchUnsupportedError: 'unsupported_host',
  UnidentifiedHostLibcError: 'libc_unidentified',
  RemoteNodeRuntimeSelfTestError: 'runtime_self_test',
  RemoteNodeRuntimeSecurityModifiedError: 'security_software',
  OrcadStdioBridgeUnavailableError: ORCAD_TUNNEL_UNAVAILABLE_REASON
}

// Why only these deferrals: the candidate's native preflight (libc floor, missing libraries) and
// its PTY self-test fail the same way on every retry; activation races and live runtimes don't.
const UNAVAILABLE_BY_DEFERRAL_CODE: Record<string, OrcadHostUnavailableReason> = {
  orcad_candidate_preflight_failed: 'native_preflight',
  orcad_activation_pty_self_test_failed: 'native_preflight'
}

export function classifyOrcadHostUnavailable(failure: unknown): OrcadHostUnavailableReason | null {
  if (failure instanceof Error) {
    return UNAVAILABLE_BY_ERROR_NAME[failure.name] ?? null
  }
  if (failure && typeof failure === 'object' && 'code' in failure) {
    const code = failure.code
    return typeof code === 'string' ? (UNAVAILABLE_BY_DEFERRAL_CODE[code] ?? null) : null
  }
  return null
}
