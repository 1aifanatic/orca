// Field checks shared by the manifest and receipt parsers; each throws a labeled error.

/** The one bounded-array check; `errorPrefix` names the manifest or dormant error family. */
export function boundedList<T>(
  value: unknown,
  maximum: number,
  parse: (entry: unknown) => T,
  errorPrefix: string
): T[] {
  if (!Array.isArray(value)) {
    throw new Error(`${errorPrefix}_invalid`)
  }
  if (value.length > maximum) {
    throw new Error(`${errorPrefix}_too_many`)
  }
  return value.map(parse)
}

export function boundedArray<T>(
  value: unknown,
  maximum: number,
  parse: (entry: unknown) => T,
  label: string
): T[] {
  return boundedList(value, maximum, parse, `orcad_migration_manifest_${label}`)
}

export function assertUniqueIds(values: { id: string }[], label: string): void {
  const ids = new Set<string>()
  for (const value of values) {
    if (ids.has(value.id)) {
      throw new Error(`orcad_migration_manifest_${label}_duplicate_id`)
    }
    ids.add(value.id)
  }
}

export function boundedStringArray(value: unknown, maximum: number, label: string): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string' && entry)) {
    throw new Error(`${label}_invalid`)
  }
  if (value.length > maximum || new Set(value).size !== value.length) {
    throw new Error(`${label}_invalid`)
  }
  return [...value]
}

export function nonEmptyString(value: unknown, error: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(error)
  }
  return value
}

export function requiredString(value: unknown, label: string): string {
  return nonEmptyString(value, `${label}_invalid`)
}

export function requiredFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label}_invalid`)
  }
  return value
}

export function requiredDate(value: unknown, label: string): string {
  const result = requiredString(value, label)
  if (!Number.isFinite(Date.parse(result))) {
    throw new Error(`${label}_invalid`)
  }
  return result
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
