import { z } from 'zod'

const originalEnvironment = z.object({
  XDG_DATA_HOME: z.string().nullable(),
  XDG_STATE_HOME: z.string().nullable(),
  OPENCODE_AUTH_CONTENT: z.string().nullable(),
  OPENCODE_DB: z.string().nullable()
})
const ORIGINAL_ENV = 'ORCA_DATA_ACCOUNT_ORIGINAL_ENV'
export const MANAGED_DATA_ACCOUNT_BASELINE_ENV_KEYS = [
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'OPENCODE_AUTH_CONTENT',
  'OPENCODE_DB'
] as const

export function getInheritedManagedDataAccountEnvKeysToDelete(
  environment: Record<string, string> | undefined
): string[] {
  return [
    ...MANAGED_DATA_ACCOUNT_BASELINE_ENV_KEYS,
    'ORCA_DATA_ACCOUNT_DATA_HOME',
    'ORCA_DATA_ACCOUNT_STATE_HOME',
    'ORCA_DATA_ACCOUNT_PROVIDER',
    ORIGINAL_ENV
  ].filter((key) => environment?.[key] === undefined)
}

export function captureManagedDataAccountOriginalEnvironment(
  environment: Record<string, string>
): void {
  environment[ORIGINAL_ENV] = JSON.stringify(
    Object.fromEntries(
      MANAGED_DATA_ACCOUNT_BASELINE_ENV_KEYS.map((key) => [key, environment[key] ?? null])
    )
  )
}

export function restoreManagedDataAccountEnvironment(
  environment: Record<string, string | undefined>,
  restoreOriginal = true
): void {
  let original: z.infer<typeof originalEnvironment> | undefined
  try {
    const parsed = originalEnvironment.safeParse(JSON.parse(environment[ORIGINAL_ENV] ?? 'null'))
    if (restoreOriginal && parsed.success) {
      original = parsed.data
    }
  } catch {
    // Older panes have no baseline snapshot; strip only their owned overrides.
  }
  function restore(
    key: (typeof MANAGED_DATA_ACCOUNT_BASELINE_ENV_KEYS)[number],
    ownedValue: string | undefined
  ): void {
    if (ownedValue === undefined || environment[key] !== ownedValue) {
      return
    }
    const value = original?.[key]
    if (typeof value === 'string') {
      environment[key] = value
    } else {
      delete environment[key]
    }
  }
  if (environment.ORCA_DATA_ACCOUNT_DATA_HOME) {
    restore('XDG_DATA_HOME', environment.ORCA_DATA_ACCOUNT_DATA_HOME)
    restore('XDG_STATE_HOME', environment.ORCA_DATA_ACCOUNT_STATE_HOME)
    if (environment.ORCA_DATA_ACCOUNT_PROVIDER === 'opencode') {
      restore('OPENCODE_AUTH_CONTENT', '')
      restore('OPENCODE_DB', 'opencode.db')
    }
  }
  delete environment.ORCA_DATA_ACCOUNT_DATA_HOME
  delete environment.ORCA_DATA_ACCOUNT_STATE_HOME
  delete environment.ORCA_DATA_ACCOUNT_PROVIDER
  delete environment[ORIGINAL_ENV]
}
