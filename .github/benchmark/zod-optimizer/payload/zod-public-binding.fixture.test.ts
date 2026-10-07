import { expect, it } from 'vitest'
import * as root from 'zod'
import * as v4 from 'zod/v4'
import * as core from 'zod/v4/core'

it('keeps the public Zod entries bound to the same schema and configuration owners', () => {
  expect(root.z.string).toBe(v4.z.string)
  expect(root.ZodError).toBe(v4.ZodError)
  expect(root.config).toBe(v4.config)
  expect(root.config).toBe(core.config)
  expect(root.globalRegistry).toBe(core.globalRegistry)
  expect(root.core.$ZodError).toBe(core.$ZodError)
  expect(root.core.$ZodString).toBe(core.$ZodString)
  expect(root.config()).toBe(core.config())
  expect(root.z.string()).toBeInstanceOf(v4.ZodString)
  const parsed = root.z.string().safeParse(123)
  expect(parsed.success).toBe(false)
  if (!parsed.success) {
    expect(parsed.error).toBeInstanceOf(v4.ZodError)
  }
})
