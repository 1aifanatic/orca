import { describe, expect, it } from 'vitest'
import { launchPromptDelivered } from './launch-prompt-delivered'

describe('launchPromptDelivered', () => {
  it('counts a launch with no prompt delivery to wait on as started', async () => {
    await expect(launchPromptDelivered({})).resolves.toBe(true)
  })

  it('answers by the delivery, and a delivery that failed outright as not delivered', async () => {
    await expect(
      launchPromptDelivered({ promptDeliveryResult: Promise.resolve({ delivered: true }) })
    ).resolves.toBe(true)
    await expect(
      launchPromptDelivered({ promptDeliveryResult: Promise.resolve({ delivered: false }) })
    ).resolves.toBe(false)
    await expect(
      launchPromptDelivered({ promptDeliveryResult: Promise.reject(new Error('lost')) })
    ).resolves.toBe(false)
  })
})
