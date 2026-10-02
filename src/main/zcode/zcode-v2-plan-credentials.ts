import { createDecipheriv, createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir, platform, userInfo } from 'node:os'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { ZCODE_PLAN_SITE_BASE_URLS } from '../../shared/zcode-plan-sites'

const selectionSchema = z.object({
  schemaVersion: z.literal(1),
  config: z.object({
    defaultModelSelection: z
      .object({
        providerId: z.string().trim().min(1),
        modelId: z.string().trim().min(1)
      })
      .optional()
  })
})
const credentialSchema = z.record(z.string(), z.string())
const sites = new Map([
  ['account:zai-individual-coding-plan', 'zai'],
  ['account:bigmodel-individual-coding-plan', 'bigmodel']
] as const)

export type ZcodeCredentialHost = {
  home: string
  platform: string
  username: string
  env: NodeJS.ProcessEnv
}

export type ZcodeV2PlanCredential =
  | { status: 'absent' | 'unavailable' | 'error' }
  | { status: 'ok'; apiKey: string; baseUrl: string; identity: string; configPath: string }

export function localZcodeCredentialHost(): ZcodeCredentialHost {
  let username = 'unknown'
  try {
    username = userInfo().username
  } catch {
    // Upstream uses the same fallback in sandboxed hosts.
  }
  return { home: homedir(), platform: platform(), username, env: process.env }
}

function userPath(value: string, home: string): string {
  if (value === '~') {
    return home
  }
  return value.startsWith('~/') ? join(home, value.slice(2)) : resolve(value)
}

// Read-only enc:v1 compatibility with ZCode 29628c9 credential-cipher.ts.
function decrypt(value: string, host: ZcodeCredentialHost): string {
  if (!value.startsWith('enc:v1:')) {
    return value
  }
  const parts = value.slice(7).split('.')
  const [nonce, tag, ciphertext] = parts
  if (parts.length !== 3 || !nonce || !tag || !ciphertext) {
    throw new Error('Invalid credential')
  }
  const iv = Buffer.from(nonce, 'base64url')
  const authTag = Buffer.from(tag, 'base64url')
  if (iv.length !== 12 || authTag.length !== 16) {
    throw new Error('Invalid credential')
  }
  const secret =
    host.env.ZCODE_CREDENTIAL_SECRET?.trim() ||
    `zcode-credential-fallback:${host.platform}:${host.home}:${host.username}`
  const key = createHash('sha256').update(secret).digest()
  const cipher = createDecipheriv('aes-256-gcm', key, iv)
  cipher.setAuthTag(authTag)
  return Buffer.concat([
    cipher.update(Buffer.from(ciphertext, 'base64url')),
    cipher.final()
  ]).toString('utf8')
}

export function readZcodeV2PlanCredential(
  host = localZcodeCredentialHost()
): ZcodeV2PlanCredential {
  const base = userPath(host.env.ZCODE_DATA_BASE_DIR ?? host.home, host.home)
  const configPath =
    (host.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE?.trim()
      ? userPath(host.env.ZCODE_PERSONAL_PROVIDER_CONFIG_FILE.trim(), host.home)
      : '') || join(base, '.zcode', 'v2', 'provider_config.json')
  let rawConfig: string
  try {
    rawConfig = readFileSync(configPath, 'utf8')
  } catch (error) {
    return {
      status:
        error instanceof Error && 'code' in error && error.code === 'ENOENT' ? 'absent' : 'error'
    }
  }
  try {
    const selection = selectionSchema.parse(JSON.parse(rawConfig)).config.defaultModelSelection
    if (!selection) {
      return { status: 'unavailable' }
    }
    const site = [...sites].find(([provider]) => provider === selection.providerId)?.[1]
    if (!site) {
      return { status: 'unavailable' }
    }
    const store = credentialSchema.parse(
      JSON.parse(readFileSync(join(base, '.zcode', 'v2', 'credentials.json'), 'utf8'))
    )
    const rawIdentity = store[`account-provider:${selection.providerId}:identity`]
    if (!rawIdentity) {
      return { status: 'unavailable' }
    }
    const identity = decrypt(rawIdentity, host).trim()
    if (!identity) {
      return { status: 'unavailable' }
    }
    const rawKey =
      store[
        `account-provider:coding-plan:${selection.providerId}:account:${encodeURIComponent(identity)}:api-key`
      ]
    if (!rawKey) {
      return { status: 'unavailable' }
    }
    const apiKey = decrypt(rawKey, host).trim()
    if (!apiKey || /[\r\n]/.test(apiKey)) {
      return { status: 'error' }
    }
    return {
      status: 'ok',
      apiKey,
      baseUrl: ZCODE_PLAN_SITE_BASE_URLS[site],
      identity: JSON.stringify([selection.providerId, identity]),
      configPath
    }
  } catch {
    return { status: 'error' }
  }
}
