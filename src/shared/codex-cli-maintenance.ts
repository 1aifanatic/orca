import { z } from 'zod'
import type { CodexCliInstallation } from './codex-cli-installation'
import { openEnum } from './zod-salvage'
import { compareAppVersions } from './app-version'

export const CODEX_MAINTENANCE_LEGACY_CAPABILITY = 'preflight.codex-maintenance.v1' as const
export const CODEX_MAINTENANCE_CAPABILITY = 'preflight.codex-maintenance.v2' as const
export const CODEX_INSTALL_COMMAND = 'npm install -g @openai/codex'
export const CODEX_SELF_UPDATE_MINIMUM_VERSION = '0.126.0'

export const CodexMaintenanceRequest = z.object({
  operation: z.enum(['status', 'start', 'read']),
  connectionId: z.string().min(1).optional(),
  jobId: z.string().min(1).optional(),
  cwd: z.string().min(1).optional(),
  commandSettings: z
    .object({
      agentCmdOverrides: z.object({ codex: z.string().optional() }).optional(),
      agentDefaultEnv: z.object({ codex: z.record(z.string(), z.string()).optional() }).optional(),
      nativeChatInheritShellEnvironment: z.boolean().optional(),
      nativeChatShellEnvironmentVariables: z.array(z.string()).optional()
    })
    .optional()
})

export type CodexMaintenanceParams = z.infer<typeof CodexMaintenanceRequest>
export type CodexMaintenanceAction = {
  kind: 'install' | 'update' | 'unknown'
  command: string
  manual?: boolean
  installationPath?: string
}
export type CodexMaintenanceJob = {
  id: string
  phase: 'queued' | 'running' | 'completed' | 'unknown'
  action: CodexMaintenanceAction
  output: string
  exitCode: number | null
  error: string | null
  termination?: 'live' | 'unverifiable' | 'exited'
}
export type CodexMaintenanceState = {
  installation: CodexCliInstallation
  action: CodexMaintenanceAction | null
  canRun: boolean
  job: CodexMaintenanceJob | null
  currentJob?: Pick<CodexMaintenanceJob, 'id' | 'phase'> | null
  evidence?: { expiresAt: number; configurationId: string; observedAt?: number }
}

const CodexMaintenanceJobSchema = z
  .object({
    id: z.string(),
    phase: openEnum(['queued', 'running', 'completed', 'unknown'], 'unknown'),
    action: z.object({
      kind: openEnum(['install', 'update', 'unknown'], 'unknown'),
      command: z.string(),
      manual: z.boolean().optional(),
      installationPath: z.string().optional()
    }),
    output: z.string(),
    exitCode: z.number().nullable(),
    error: z.string().nullable(),
    termination: openEnum(['live', 'unverifiable', 'exited'], 'unverifiable').optional()
  })
  .nullable()

export const CodexMaintenanceStateSchema = z.object({
  installation: z.object({
    status: openEnum(['missing', 'unsupported', 'ready', 'unknown'], 'unknown'),
    version: z.string().nullable(),
    minimumVersion: z.string()
  }),
  action: z
    .object({
      kind: openEnum(['install', 'update', 'unknown'], 'unknown'),
      command: z.string(),
      manual: z.boolean().optional(),
      installationPath: z.string().optional()
    })
    .nullable(),
  canRun: z.boolean(),
  job: CodexMaintenanceJobSchema,
  currentJob: z
    .object({
      id: z.string(),
      phase: openEnum(['queued', 'running', 'completed', 'unknown'], 'unknown')
    })
    .nullable()
    .optional(),
  evidence: z
    .object({
      expiresAt: z.number().finite(),
      configurationId: z.string().min(1),
      observedAt: z.number().finite().optional()
    })
    .optional()
})

export function codexMaintenanceAction(
  installation: CodexCliInstallation,
  npmInstalled: boolean
): CodexMaintenanceAction | null {
  if (installation.status === 'missing') {
    return { kind: 'install', command: CODEX_INSTALL_COMMAND }
  }
  if (installation.status === 'unsupported') {
    const selfUpdate =
      installation.version !== null &&
      compareAppVersions(installation.version, CODEX_SELF_UPDATE_MINIMUM_VERSION) >= 0
    return {
      kind: 'update',
      command: npmInstalled || !selfUpdate ? CODEX_INSTALL_COMMAND : 'codex update'
    }
  }
  return null
}

export function codexMaintenanceManualAction(
  path: string,
  minimum: string,
  kind: 'install' | 'update' = 'update'
): CodexMaintenanceAction {
  return {
    kind,
    command: `Install Codex ${minimum} or newer at ${path}, then retry.`,
    manual: true,
    installationPath: path
  }
}
