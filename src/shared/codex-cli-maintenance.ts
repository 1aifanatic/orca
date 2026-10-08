import { z } from 'zod'
import type { CodexCliInstallation } from './codex-cli-installation'
import { openEnum } from './zod-salvage'

export const CODEX_MAINTENANCE_CAPABILITY = 'preflight.codex-maintenance.v1' as const
export const CODEX_INSTALL_COMMAND = 'npm install -g @openai/codex'

export const CodexMaintenanceRequest = z.object({
  operation: z.enum(['status', 'start', 'read']),
  connectionId: z.string().min(1).optional(),
  jobId: z.string().min(1).optional()
})

export type CodexMaintenanceParams = z.infer<typeof CodexMaintenanceRequest>
export type CodexMaintenanceAction = { kind: 'install' | 'update' | 'unknown'; command: string }
export type CodexMaintenanceJob = {
  id: string
  phase: 'queued' | 'running' | 'completed' | 'unknown'
  action: CodexMaintenanceAction
  output: string
  exitCode: number | null
  error: string | null
}
export type CodexMaintenanceState = {
  installation: CodexCliInstallation
  action: CodexMaintenanceAction | null
  canRun: boolean
  job: CodexMaintenanceJob | null
}

export const CodexMaintenanceStateSchema = z.object({
  installation: z.object({
    status: openEnum(['missing', 'unsupported', 'ready', 'unknown'], 'unknown'),
    version: z.string().nullable(),
    minimumVersion: z.string()
  }),
  action: z
    .object({ kind: openEnum(['install', 'update', 'unknown'], 'unknown'), command: z.string() })
    .nullable(),
  canRun: z.boolean(),
  job: z
    .object({
      id: z.string(),
      phase: openEnum(['queued', 'running', 'completed', 'unknown'], 'unknown'),
      action: z.object({
        kind: openEnum(['install', 'update', 'unknown'], 'unknown'),
        command: z.string()
      }),
      output: z.string(),
      exitCode: z.number().nullable(),
      error: z.string().nullable()
    })
    .nullable()
})

export function codexMaintenanceAction(
  installation: CodexCliInstallation,
  npmInstalled: boolean
): CodexMaintenanceAction | null {
  if (installation.status === 'missing') {
    return { kind: 'install', command: CODEX_INSTALL_COMMAND }
  }
  if (installation.status === 'unsupported') {
    return { kind: 'update', command: npmInstalled ? CODEX_INSTALL_COMMAND : 'codex update' }
  }
  return null
}
