import { createContext, useContext } from 'react'
import { usePageBridgeClientIfPresent } from '../transport/client-context'

// Set by the wide host layout while the user has hidden its sidebar; null otherwise.
// Detail headers render a "Show sidebar" button from it, since the hide button
// goes away with the sidebar it lives in.
export const HostSidebarRevealContext = createContext<(() => void) | null>(null)

export function useHostSidebarReveal(): (() => void) | null {
  const reveal = useContext(HostSidebarRevealContext)
  const pageBridge = usePageBridgeClientIfPresent()
  // A page-local callback cannot reveal the native sidebar outside its document.
  return pageBridge ? null : reveal
}
