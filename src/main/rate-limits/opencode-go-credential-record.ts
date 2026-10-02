// Electron-free: the foreign SQLite reader worker parses credential rows with it too.

/** OpenCode's provider/integration id for the Go subscription. */
export const OPENCODE_GO_INTEGRATION_ID = 'opencode-go'

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function trimmedKey(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

/** Reads `{ type: <kind>, key: "…" }` from an already-narrowed record. */
export function keyFromCredentialRecord(value: unknown, kind: string): string | null {
  if (!isRecord(value) || value.type !== kind) {
    return null
  }
  return trimmedKey(value.key)
}
