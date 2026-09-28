import {
  AGENT_SESSION_RECORD_SCHEMA_VERSION,
  isPersistedAgentSessionRecord,
  type AgentSessionRecord
} from '../../shared/agent-session-record'
import { normalizeLegacyHandoffRecord } from '../../shared/agent-session-legacy-handoff-lease'

export type StoredAgentSessionRecordVerdict =
  | { record: AgentSessionRecord; normalized: boolean }
  | { reason: string }

/** This build's verdict on one stored row, whether it sits in `records` or in the quarantine. */
export function decodeStoredAgentSessionRecord(
  sessionId: string,
  value: unknown
): StoredAgentSessionRecordVerdict {
  const decoded = isPersistedAgentSessionRecord(value) ? normalizeLegacyHandoffRecord(value) : null
  if (decoded?.record.sessionId === sessionId) {
    return decoded
  }
  if (decoded) {
    return { reason: 'record_key_session_id_mismatch' }
  }
  const valueSchemaVersion =
    typeof value === 'object' && value !== null && 'schemaVersion' in value
      ? value.schemaVersion
      : undefined
  return {
    reason:
      valueSchemaVersion === AGENT_SESSION_RECORD_SCHEMA_VERSION
        ? 'current_shape_invalid'
        : 'unsupported_schema'
  }
}
