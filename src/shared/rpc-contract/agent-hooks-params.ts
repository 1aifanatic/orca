import { z } from 'zod'

export const CodexTerminalLaunchCapabilityParams = z
  .object({
    executablePath: z.string().min(1).max(4_096),
    terminalHandle: z.string().min(1).max(512),
    wslDistro: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[^\\/\r\n]+$/)
      .optional()
  })
  .strict()

export const PrepareCodexForWslPaneParams = z
  .object({
    codexHome: z.string().max(4_096),
    orcaCodexHome: z.string().max(4_096),
    wslDistro: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .regex(/^[^\\/\r\n]+$/)
  })
  .strict()
