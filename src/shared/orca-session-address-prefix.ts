// A leaf with no imports, so the CLI entry can spell a session address without the codec's zod graph.
export const ORCA_SESSION_ADDRESS_PREFIX = 'orca_session_id:'

// What earlier builds spelled; still read, so an agent told that address reaches its session, never written.
const LEGACY_ORCA_SESSION_ADDRESS_PREFIX = 'session:'

/** `value` respelled with the current prefix when it carries the legacy one; anything else unchanged. */
export function respellLegacyOrcaSessionAddress(value: string): string {
  return value.startsWith(LEGACY_ORCA_SESSION_ADDRESS_PREFIX)
    ? `${ORCA_SESSION_ADDRESS_PREFIX}${value.slice(LEGACY_ORCA_SESSION_ADDRESS_PREFIX.length)}`
    : value
}

/** Whether `value` is spelled as a session address, current or legacy, valid or not. */
export function isSpelledAsOrcaSessionAddress(value: string): boolean {
  return respellLegacyOrcaSessionAddress(value).startsWith(ORCA_SESSION_ADDRESS_PREFIX)
}
