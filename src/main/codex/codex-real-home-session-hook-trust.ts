import { readHooksJsonWithRaw } from '../agent-hooks/installer-utils'
import {
  codexAppServerCapabilityCache,
  getCodexAppServerHostKey
} from './codex-app-server-capability-cache'
import { getCodexManagedHookInstallMaterial } from './codex-hook-definition'
import { createCodexHookTrustEntry } from './codex-hook-identity'
import { readOrcaEntryTrust } from './codex-real-home-entry-trust'
import { getRealHomeConfigTomlPath, getRealHomeHooksJsonPath } from './codex-real-home-hooks-json'
import {
  computeTrustedHash,
  computeTrustKey,
  getCodexExplicitHomeHookSourcePath,
  readHookTrustEntries
} from './config-toml-trust'

/** One `[hooks.state."<key>"]` trust record, held by a single Codex process only. */
export type CodexSessionHookTrust = { key: string; trustedHash: string }

/**
 * Orca's own entries in the real ~/.codex that Codex would list for review, each
 * with the hash of exactly that entry's content. A resume passes them as `-c`
 * overrides, so it need not wait for the background approval; nothing is written.
 */
export function readRealHomeCodexSessionHookTrust(): CodexSessionHookTrust[] {
  try {
    // Why: a Codex known to lack hook trust has nothing to approve.
    if (!codexAppServerCapabilityCache.shouldTry(getCodexAppServerHostKey({ kind: 'native' }))) {
      return []
    }
    const hooksJsonPath = getRealHomeHooksJsonPath()
    const hooks = readHooksJsonWithRaw(hooksJsonPath).config?.hooks
    if (!hooks) {
      return []
    }
    const command = getCodexManagedHookInstallMaterial().command
    const trustStates = readHookTrustEntries(getRealHomeConfigTomlPath())
    // Why both: Codex keys a default home by its logical path, an explicit CODEX_HOME by its real path.
    const sourcePaths = new Set([hooksJsonPath, getCodexExplicitHomeHookSourcePath(hooksJsonPath)])
    const trust = new Map<string, string>()
    for (const [eventName, definitions] of Object.entries(hooks)) {
      if (!Array.isArray(definitions)) {
        continue
      }
      definitions.forEach((definition, groupIndex) =>
        definition.hooks?.forEach((hook, handlerIndex) => {
          const entry =
            hook.command === command
              ? createCodexHookTrustEntry(
                  hooksJsonPath,
                  eventName,
                  groupIndex,
                  handlerIndex,
                  definition,
                  hook
                )
              : null
          const state = entry ? readOrcaEntryTrust(entry, trustStates) : null
          if (!entry || (state !== 'untrusted' && state !== 'stale')) {
            return
          }
          const trustedHash = computeTrustedHash(entry)
          for (const sourcePath of sourcePaths) {
            trust.set(computeTrustKey({ ...entry, sourcePath }), trustedHash)
          }
        })
      )
    }
    return [...trust].map(([key, trustedHash]) => ({ key, trustedHash }))
  } catch (error) {
    // Why: without overrides the resume still runs; Codex only lists the entry for review.
    console.warn('[codex-real-home-hooks] could not read Orca entry trust for a resume:', error)
    return []
  }
}

// Why literal strings: a TOML literal string needs no escapes, so no `"` reaches a
// Windows shell's native-argument quoting; a key it cannot hold gets no override.
function fitsTomlLiteralString(value: string): boolean {
  return [...value].every((char) => char !== "'" && char >= ' ' && char !== '\u007f')
}

/**
 * The `-c` value for these records: one inline table, since Codex splits a `-c`
 * key on every `.` and a hooks.json path contains one. Null when one cannot be spelled.
 */
export function formatCodexSessionHookTrustOverride(
  trust: readonly CodexSessionHookTrust[]
): string | null {
  if (
    trust.length === 0 ||
    !trust.every(({ key, trustedHash }) => fitsTomlLiteralString(key + trustedHash))
  ) {
    return null
  }
  const records = trust.map(({ key, trustedHash }) => `'${key}'={trusted_hash='${trustedHash}'}`)
  return `hooks.state={${records.join(',')}}`
}
