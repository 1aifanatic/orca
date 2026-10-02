/**
 * The client-side journal of a dormant migration from a relay-hosted SSH target into a managed
 * orcad. Kept outside the profile store so an older build rewriting the profile cannot strip it.
 */
import { z } from 'zod'
import {
  parseOrcadMigrationManifest,
  type OrcadMigrationManifest
} from './orcad-migration-manifest'

export const ORCAD_MIGRATION_SOURCE_CUTOVER_VERSION = 1
export const MAX_ORCAD_MIGRATION_SOURCE_CUTOVERS = 4

export const ORCAD_MIGRATION_SOURCE_CUTOVER_PHASES = [
  'source-fenced',
  'destination-staged',
  'destination-committed',
  'source-retired'
] as const

export type OrcadMigrationSourceCutoverPhase =
  (typeof ORCAD_MIGRATION_SOURCE_CUTOVER_PHASES)[number]

const CutoverRecordSchema = z
  .object({
    version: z.literal(ORCAD_MIGRATION_SOURCE_CUTOVER_VERSION),
    migrationId: z.string().min(1).max(128),
    phase: z.enum(ORCAD_MIGRATION_SOURCE_CUTOVER_PHASES),
    startedAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    destinationEnvironmentId: z.string().min(1).max(256),
    destinationName: z.string().min(1).max(1_024),
    // What the fence binds to: the exact registration and the manifest the destination will see.
    sshTargetId: z.string().min(1).max(1_024),
    sshTargetGeneration: z.number().int().positive(),
    manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
    manifest: z.unknown()
  })
  .strict()

export type OrcadMigrationSourceCutover = Omit<z.infer<typeof CutoverRecordSchema>, 'manifest'> & {
  manifest: OrcadMigrationManifest
}

/** Throws on anything that is not exactly a cutover whose manifest matches its binding. */
export function parseOrcadMigrationSourceCutover(value: unknown): OrcadMigrationSourceCutover {
  const record = CutoverRecordSchema.parse(value)
  const manifest = parseOrcadMigrationManifest(record.manifest)
  if (
    manifest.migrationId !== record.migrationId ||
    manifest.manifestSha256 !== record.manifestSha256 ||
    manifest.source.sshTargetId !== record.sshTargetId ||
    manifest.source.sshTargetGeneration !== record.sshTargetGeneration ||
    manifest.destinationEnvironmentId !== record.destinationEnvironmentId
  ) {
    throw new Error('orcad_migration_cutover_binding_mismatch')
  }
  return { ...record, manifest }
}
