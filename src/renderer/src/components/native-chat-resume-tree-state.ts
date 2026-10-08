import { createContext, useState } from 'react'

// The resume tree's shared state: which nodes are open, and how deep a chat row sits.

/**
 * Which nodes are open. Everything starts expanded; the state is this mount's own, so a dialog that
 * unmounts its tree on close reopens it fully expanded. Never persisted.
 */
export function useResumeTreeExpansion(): {
  isExpanded: (key: string) => boolean
  setExpanded: (key: string, expanded: boolean) => void
} {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  return {
    isExpanded: (key) => !collapsed.has(key),
    setExpanded: (key, expanded) =>
      setCollapsed((current) => {
        const next = new Set(current)
        if (expanded) {
          next.delete(key)
        } else {
          next.add(key)
        }
        return next
      })
  }
}

/** The tree depth a chat row renders at; the enclosing workspace node provides it. */
export const ResumeTreeDepthContext = createContext(0)
