import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import { readActiveClaudeKeychainCredentialsStrict } from '../claude-accounts/keychain'
import type { ClaudeRuntimeAuthPreparation } from '../claude-accounts/runtime-auth-service'

export type ClaudeOAuthCredentialSource =
  | 'scoped-keychain'
  | 'legacy-keychain'
  | 'credentials-file'
  | 'none'
export type ClaudeOAuthCredentialReadResult = {
  token: string | null
  hasRefreshableCredentials: boolean
  source: ClaudeOAuthCredentialSource
  keychainUnavailable?: boolean
  unavailable?: boolean
  expired?: boolean
}
type ClaudeOAuthCredentialReadOptions = {
  credentialsFileConfigDir?: string
  keychainConfigDir?: string
}
const schema = z.object({
  claudeAiOauth: z
    .object({
      accessToken: z.string().optional(),
      refreshToken: z.string().optional(),
      expiresAt: z.number().optional()
    })
    .optional()
})
export function parseClaudeOAuthCredentialsJson(
  raw: string,
  source: ClaudeOAuthCredentialSource
): ClaudeOAuthCredentialReadResult {
  try {
    const oauth = schema.parse(JSON.parse(raw)).claudeAiOauth
    const expired = oauth?.expiresAt !== undefined && oauth.expiresAt <= Date.now()
    return {
      token: expired ? null : oauth?.accessToken || null,
      hasRefreshableCredentials: Boolean(oauth?.refreshToken),
      source,
      expired
    }
  } catch {
    return { ...emptyClaudeOAuthCredentialReadResult(), unavailable: true }
  }
}
export function emptyClaudeOAuthCredentialReadResult(): ClaudeOAuthCredentialReadResult {
  return { token: null, hasRefreshableCredentials: false, source: 'none' }
}
export async function readClaudeCredentialsFromStrictKeychain(
  configDir: string | undefined,
  source: ClaudeOAuthCredentialSource
): Promise<ClaudeOAuthCredentialReadResult> {
  try {
    const contents = await readActiveClaudeKeychainCredentialsStrict(configDir)
    return contents
      ? parseClaudeOAuthCredentialsJson(contents, source)
      : emptyClaudeOAuthCredentialReadResult()
  } catch {
    return {
      ...emptyClaudeOAuthCredentialReadResult(),
      unavailable: true,
      keychainUnavailable: true
    }
  }
}
export async function readClaudeOAuthCredentials(
  options?: ClaudeOAuthCredentialReadOptions
): Promise<ClaudeOAuthCredentialReadResult> {
  const keychain =
    process.platform === 'darwin'
      ? await readClaudeCredentialsFromStrictKeychain(
          options?.keychainConfigDir,
          options?.keychainConfigDir ? 'scoped-keychain' : 'legacy-keychain'
        )
      : emptyClaudeOAuthCredentialReadResult()
  if (keychain.token || keychain.expired) {
    return keychain
  }
  try {
    return parseClaudeOAuthCredentialsJson(
      await readFile(
        path.join(
          options?.credentialsFileConfigDir ?? path.join(homedir(), '.claude'),
          '.credentials.json'
        ),
        'utf8'
      ),
      'credentials-file'
    )
  } catch (error) {
    return isDefinitiveAbsence(error) ? keychain : { ...keychain, unavailable: true }
  }
}
export function resolveClaudeOAuthCredentialReadOptions(
  authPreparation?: ClaudeRuntimeAuthPreparation
): ClaudeOAuthCredentialReadOptions | undefined {
  if (!authPreparation) {
    return undefined
  }
  return {
    credentialsFileConfigDir: authPreparation.configDir,
    // An unsuffixed lookup is exclusively System Default, never a fallback from a profile.
    keychainConfigDir:
      authPreparation.profileLaunch?.profile || authPreparation.envPatch.CLAUDE_CONFIG_DIR
        ? authPreparation.configDir
        : undefined
  }
}
