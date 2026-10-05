import { unwrapLoginShellCommand } from '../../../../shared/native-chat-tool-preview-prefix'

export function nativeChatToolInputText(input: unknown, key: string): string | null {
  let value = input
  if (typeof value === 'string') {
    const raw = value
    try {
      value = JSON.parse(value)
    } catch {
      return key === 'command' ? raw : null
    }
  }
  if (value === null || typeof value !== 'object' || !(key in value)) {
    return null
  }
  const field: unknown = Reflect.get(value, key)
  if (typeof field === 'string') {
    return field
  }
  return (key === 'command' || key === 'cmd') &&
    Array.isArray(field) &&
    field.every((part) => typeof part === 'string')
    ? field.join(' ')
    : null
}

export function nativeChatFullCommand(input: unknown): string | null {
  const command = nativeChatToolInputText(input, 'command') || nativeChatToolInputText(input, 'cmd')
  return command?.trim() ? unwrapLoginShellCommand(command).trim() : null
}
