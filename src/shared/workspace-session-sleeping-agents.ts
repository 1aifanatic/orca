import { z } from 'zod'
import {
  sleepingAgentLaunchConfigSchema,
  isUnsafeObjectKey
} from './agent-resume-launch-config-schema'
export { sleepingAgentLaunchConfigSchema } from './agent-resume-launch-config-schema'
import {
  getAgentResumeArgv,
  normalizeAgentProviderSession,
  RESUMABLE_TUI_AGENTS
} from './agent-session-resume'
import { isValidTerminalTabId } from './terminal-tab-id'
import { normalizeMainAgentStatusField } from './agent-status-types'
import { salvagingRecord } from './zod-salvage'

const terminalTabIdSchema = z
  .string()
  .min(1)
  .refine(isValidTerminalTabId, 'terminal tab id must not contain ":"')

const agentProviderSessionSchema = z.unknown().transform((raw, ctx) => {
  const session = normalizeAgentProviderSession(raw)
  if (!session) {
    ctx.addIssue({ code: 'custom', message: 'Invalid provider session' })
    return z.NEVER
  }
  return session
})

const sleepingAgentSessionRecordSchema = z
  .object({
    paneKey: z.string().refine((value) => value.length > 0),
    tabId: terminalTabIdSchema.optional(),
    worktreeId: z.string().min(1),
    agent: z.enum(RESUMABLE_TUI_AGENTS),
    providerSession: agentProviderSessionSchema,
    prompt: z.string(),
    state: z.enum(['working', 'blocked', 'waiting', 'done']),
    capturedAt: z.number().finite().positive(),
    updatedAt: z.number().finite().positive(),
    terminalTitle: z.string().optional(),
    lastAssistantMessage: z.string().optional(),
    interrupted: z.boolean().optional(),
    // A malformed value drops the field, never the record.
    mainAgent: z.unknown().transform(normalizeMainAgentStatusField).optional(),
    connectionId: z.string().nullable().optional(),
    launchConfig: sleepingAgentLaunchConfigSchema.optional(),
    origin: z.enum(['worktree-sleep', 'quit', 'live']).optional(),
    restoreOnTabOpenOnly: z.boolean().optional()
  })
  .refine(
    (record) => getAgentResumeArgv(record.agent, record.providerSession) !== null,
    // Why: a hydrated record must be directly resumable; Pi additionally needs
    // its persisted transcript path and agents must use their supported key.
    { message: 'provider session is not resumable for this agent', path: ['providerSession'] }
  )

export const sleepingAgentSessionsByPaneKeySchema = salvagingRecord(
  z.string().refine((paneKey) => !isUnsafeObjectKey(paneKey)),
  sleepingAgentSessionRecordSchema,
  (paneKey, record) => record.paneKey === paneKey
).transform((records) => (Object.keys(records).length > 0 ? records : undefined))
