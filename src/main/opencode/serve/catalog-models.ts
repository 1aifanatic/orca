import type { AgentSessionModelOption } from '../../../shared/agent-session-wire'
import { openCodeObjectSchema } from './native-protocol'

export function openCodeCatalogModels(value: unknown, major: 1 | 2): AgentSessionModelOption[] {
  const root = openCodeObjectSchema.safeParse(value)
  if (!root.success) {
    return []
  }
  const models: Record<string, unknown>[] = []
  if (major === 1 && Array.isArray(root.data.providers)) {
    for (const provider of root.data.providers.slice(0, 128)) {
      const p = openCodeObjectSchema.safeParse(provider)
      const children = openCodeObjectSchema.safeParse(p.success ? p.data.models : null)
      if (!p.success || !children.success || typeof p.data.id !== 'string') {
        continue
      }
      for (const child of Object.values(children.data).slice(0, 2_000 - models.length)) {
        const model = openCodeObjectSchema.safeParse(child)
        if (model.success) {
          models.push({ ...model.data, providerID: p.data.id })
        }
      }
    }
  } else if (major === 2 && Array.isArray(root.data.data)) {
    for (const child of root.data.data.slice(0, 2_000)) {
      const model = openCodeObjectSchema.safeParse(child)
      if (model.success && model.data.enabled !== false) {
        models.push(model.data)
      }
    }
  }
  return models.slice(0, 2_000).flatMap((model): AgentSessionModelOption[] => {
    if (
      typeof model.id !== 'string' ||
      typeof model.providerID !== 'string' ||
      model.id.length + model.providerID.length + 1 > 512
    ) {
      return []
    }
    const variantObject = openCodeObjectSchema.safeParse(model.variants)
    const limit = openCodeObjectSchema.safeParse(model.limit)
    const context = limit.success ? limit.data.context : undefined
    const variants = Array.isArray(model.variants)
      ? model.variants.slice(0, 64).flatMap((variant) => {
          const row = openCodeObjectSchema.safeParse(variant)
          return row.success && typeof row.data.id === 'string' && row.data.id.length <= 256
            ? [row.data.id]
            : []
        })
      : variantObject.success
        ? Object.keys(variantObject.data)
            .slice(0, 64)
            .filter((key) => key.length <= 256)
        : []
    return [
      {
        id: `${model.providerID}/${model.id}`,
        label: (typeof model.name === 'string' ? model.name : model.id).slice(0, 512),
        isDefault: false,
        ...(typeof context === 'number' && Number.isSafeInteger(context) && context > 0
          ? { contextWindowTokens: context }
          : {}),
        efforts: variants.length
          ? [
              { value: 'default', label: 'Default' },
              ...variants.map((value) => ({ value, label: value }))
            ]
          : [],
        ...(variants.length ? { defaultEffort: 'default' } : {})
      }
    ]
  })
}
