import Database from '../../../src/main/sqlite/sync-database'
import { importReleaseCheckoutModule, type ReleaseCheckout } from './release-checkout'

export function historicalStoreMaps(value: unknown) {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('records' in value) ||
    !(value.records instanceof Map) ||
    !('unreadableRecords' in value) ||
    !(value.unreadableRecords instanceof Map)
  ) {
    throw new Error('historical store must expose readable and unreadable records')
  }
  return value
}

export function historicalRecord(value: unknown) {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('lease' in value) ||
    typeof value.lease !== 'object' ||
    value.lease === null ||
    !('providerHandleChain' in value) ||
    !Array.isArray(value.providerHandleChain)
  ) {
    throw new Error('historical record must hold a chain and lease')
  }
  return { ...value, lease: value.lease, providerHandleChain: value.providerHandleChain }
}

export async function historicalStore(checkout: ReleaseCheckout) {
  const [rows, drafts, handles] = await Promise.all([
    importReleaseCheckoutModule(checkout, 'src/main/runtime/agent-session-record-rows.ts'),
    importReleaseCheckoutModule(checkout, 'src/main/runtime/agent-session-store-draft.ts'),
    importReleaseCheckoutModule(checkout, 'src/shared/agent-session-provider-handle.ts')
  ])
  const loadRows = rows.loadAgentSessionStoreRows
  const writeRows = rows.writeAgentSessionStoreRows
  const draftState = drafts.draftAgentSessionStoreState
  const rowWrites = drafts.agentSessionStoreDraftRowWrites
  const appendLink = handles.appendAgentSessionProviderHandleLink
  const key = handles.agentSessionProviderHandleKey
  if (
    typeof loadRows !== 'function' ||
    typeof writeRows !== 'function' ||
    typeof draftState !== 'function' ||
    typeof rowWrites !== 'function' ||
    typeof appendLink !== 'function' ||
    typeof key !== 'function'
  ) {
    throw new Error('historical exports are not callable')
  }
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE agent_session_records (session_id TEXT PRIMARY KEY, record_json TEXT);
    CREATE TABLE agent_session_operations (operation_key TEXT PRIMARY KEY, row_json TEXT);
    CREATE TABLE agent_session_retired_claim_keys (key_id TEXT PRIMARY KEY, retired_at INTEGER);
    CREATE TABLE agent_session_tabs (tab_id TEXT PRIMARY KEY, session_id TEXT, position INTEGER);
    CREATE TABLE agent_session_store_meta (key TEXT PRIMARY KEY, value TEXT);
  `)
  return {
    db,
    appendLink,
    key,
    insert: (sessionId: string, value: unknown) =>
      db
        .prepare('INSERT INTO agent_session_records VALUES (?, ?)')
        .run(sessionId, JSON.stringify(value)),
    load: () => historicalStoreMaps(loadRows(db, 'local')),
    draft: (loaded: unknown) => historicalStoreMaps(draftState(loaded)),
    write: (loaded: unknown, draft: unknown) => writeRows(db, rowWrites(loaded, draft)),
    read: (sessionId: string): unknown => {
      const raw = db
        .prepare('SELECT record_json FROM agent_session_records WHERE session_id = ?')
        .get(sessionId)?.record_json
      if (typeof raw !== 'string') {
        throw new Error('historical writer lost the stored row')
      }
      return JSON.parse(raw)
    }
  }
}

export function historicalHandle(provider: 'claude' | 'codex', nativeId: string, neutral: boolean) {
  if (neutral) {
    return {
      transport: provider === 'claude' ? 'claude-sdk' : 'codex-app-server',
      agent: provider,
      nativeId
    }
  }
  return provider === 'claude'
    ? { provider, sessionId: nativeId, leafUuid: null }
    : { provider, threadId: nativeId }
}
