export type AgentSessionOptionChoice = {
  value: string
  label: string
  description?: string
}

export type AgentSessionModelOption = {
  id: string
  label: string
  description?: string
  isDefault: boolean
  defaultEffort?: string
  efforts: AgentSessionOptionChoice[]
  contextWindowTokens?: number
  /** Provider catalog fact. Absent means the host could not determine support. */
  supportsFastMode?: boolean
}
