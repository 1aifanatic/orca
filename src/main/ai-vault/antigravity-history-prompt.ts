import { createHash } from 'node:crypto'

export function antigravityHistoryPromptHash(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 4096) {
    return null
  }
  const prompt = value.replace(/\s+/g, ' ').trim()
  return prompt ? createHash('sha256').update(prompt).digest('hex') : null
}
