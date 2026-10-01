import { z } from 'zod'

function hasUnsafeLaunchEnvChars(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i)
    if (code <= 0x1f || code === 0x7f) {
      return true
    }
  }
  return false
}

export function isUnsafeObjectKey(value: string): boolean {
  return value === '__proto__' || value === 'constructor' || value === 'prototype'
}

const sleepingAgentLaunchEnvSchema = z.preprocess(
  (raw) => {
    if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
      return undefined
    }
    const cleaned: Record<string, string> = Object.create(null)
    for (const [key, value] of Object.entries(raw)) {
      const trimmedKey = key.trim()
      if (
        trimmedKey.length === 0 ||
        isUnsafeObjectKey(trimmedKey) ||
        trimmedKey.includes('=') ||
        hasUnsafeLaunchEnvChars(trimmedKey) ||
        typeof value !== 'string' ||
        value.includes('\0')
      ) {
        return undefined
      }
      cleaned[trimmedKey] = value
    }
    return { ...cleaned }
  },
  z.record(z.string(), z.string())
)

const sleepingAgentLaunchConfigBaseSchema = z.object({
  agentCommand: z.string().optional(),
  agentArgs: z.string(),
  agentEnv: sleepingAgentLaunchEnvSchema,
  // Why: AI Vault can scan arbitrary OMP roots, so cold restore must retain
  // the exact provider resume locator instead of reconstructing its store.
  ompResumeFilePath: z
    .string()
    .trim()
    .min(1)
    .max(32 * 1024)
    .refine((value) => !hasUnsafeLaunchEnvChars(value))
    .optional()
})

export const sleepingAgentLaunchConfigSchema = z.preprocess((raw) => {
  const parsed = sleepingAgentLaunchConfigBaseSchema.safeParse(raw)
  return parsed.success ? parsed.data : undefined
}, sleepingAgentLaunchConfigBaseSchema.optional())
