import { z } from 'zod'

// Why: a paired desktop relays each of its phones to this host as an ordinary phone device it owns.
export const DELEGATED_MOBILE_DEVICE_SYNC_METHOD = 'pairing.delegatedMobileDevice.sync'
export const DELEGATED_MOBILE_DEVICE_SYNC_MAX_PHONES = 32

const DelegatedPhoneSchema = z
  .object({
    phoneKey: z.string().min(1).max(128),
    name: z.string().min(1).max(128)
  })
  .strict()

export const DelegatedMobileDeviceSyncParamsSchema = z
  .object({
    phones: z
      .array(DelegatedPhoneSchema)
      .max(DELEGATED_MOBILE_DEVICE_SYNC_MAX_PHONES)
      .refine((phones) => new Set(phones.map((phone) => phone.phoneKey)).size === phones.length, {
        message: 'duplicate phoneKey'
      })
  })
  .strict()

export type DelegatedMobileDeviceSyncParams = z.infer<typeof DelegatedMobileDeviceSyncParamsSchema>

export type DelegatedMobileDeviceSyncResult = {
  devices: { phoneKey: string; deviceId: string; token: string }[]
}

// Why: the paired desktop relays a phone to this host only when the host can mint its delegated device.
export const DELEGATED_MOBILE_DEVICE_SYNC_RUNTIME_CAPABILITY =
  'pairing.delegated-mobile-device.v1' as const
