import { createContext, useState } from 'react'

// The resume tree's shared state: which nodes are open, and how deep a chat row sits.

/**
 * Which nodes are open. Everything starts expanded unless `defaultExpanded` says otherwise; what the
 * user opens or closes then wins, also over a default that changes as answers arrive. The state is
 * this mount's own, so a dialog that unmounts its tree on close reopens it from the defaults. Never
 * persisted.
 */
export function useResumeTreeExpansion(defaultExpanded?: (key: string) => boolean): {
  isExpanded: (key: string) => boolean
  setExpanded: (key: string, expanded: boolean) => void
} {
  const [chosen, setChosen] = useState<ReadonlyMap<string, boolean>>(() => new Map())
  return {
    isExpanded: (key) => chosen.get(key) ?? defaultExpanded?.(key) ?? true,
    setExpanded: (key, expanded) => setChosen((current) => new Map(current).set(key, expanded))
  }
}

/** The tree depth a chat row renders at; the enclosing workspace node provides it. */
export const ResumeTreeDepthContext = createContext(0)
