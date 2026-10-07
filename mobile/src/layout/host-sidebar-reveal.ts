import { createContext, useContext } from 'react'

// Set by the wide host layout while the user has hidden its sidebar; null otherwise.
// Detail headers render a "Show sidebar" button from it, since the hide button
// goes away with the sidebar it lives in.
export const HostSidebarRevealContext = createContext<(() => void) | null>(null)

export function useHostSidebarReveal(): (() => void) | null {
  return useContext(HostSidebarRevealContext)
}
