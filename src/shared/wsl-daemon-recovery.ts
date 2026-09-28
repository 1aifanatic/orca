import { z } from 'zod'

const identity = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => value.trim() === value && !/[\0\r\n]/.test(value))
const guestPath = identity.refine(
  (value) =>
    value.startsWith('/') &&
    !value.includes('\\') &&
    !value
      .split('/')
      .slice(1)
      .some((part) => part === '.' || part === '..' || part === '')
)
const endpoint = z
  .object({
    distro: identity,
    distributionId: identity,
    userName: identity,
    userId: z.string().regex(/^\d+$/),
    home: guestPath,
    runtime: guestPath,
    entry: guestPath,
    envBinary: guestPath,
    socket: guestPath,
    tokenPath: guestPath,
    serverBuildId: identity
  })
  .strict()
const recovery = z
  .object({
    kind: z.literal('daemon'),
    distro: identity,
    relayBuildId: identity,
    endpoint
  })
  .strict()
  .refine((value) => value.distro === value.endpoint.distro)

export type WslDaemonRecovery = z.infer<typeof recovery>
export type PersistedWslDaemonEndpoint = z.infer<typeof endpoint>

/** Only endpoint identity is persisted; authentication remains in the guest-private token file. */
export function normalizeWslDaemonRecovery(value: unknown): WslDaemonRecovery | null {
  const parsed = recovery.safeParse(value)
  return parsed.success ? parsed.data : null
}
