import { useRef, useState } from 'react'

export function useAgentLaunchFieldWrite(): {
  pending: boolean
  write: (save: () => void | Promise<void>, onSaved?: () => void) => void
} {
  const busy = useRef(false)
  const [pending, setPending] = useState(false)
  const write = (save: () => void | Promise<void>, onSaved?: () => void): void => {
    if (busy.current) {
      return
    }
    const result = save()
    if (!result) {
      onSaved?.()
      return
    }
    busy.current = true
    setPending(true)
    void result
      .then(onSaved)
      .catch(() => {})
      .finally(() => {
        busy.current = false
        setPending(false)
      })
  }
  return { pending, write }
}
