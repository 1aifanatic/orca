import type { CreateWebRuntimeSessionBrowserTabArgs } from '@/runtime/web-runtime-browser-creation-context'

type PairedBrowserTabCreator = (args: CreateWebRuntimeSessionBrowserTabArgs) => Promise<boolean>

let registeredCreator: PairedBrowserTabCreator | null = null

// Why a registration slot: the runtime module imports the store, so the store cannot import it
// statically, and a lazy import would put an await before the staged row the click must paint.
export function registerPairedBrowserTabCreator(create: PairedBrowserTabCreator): void {
  registeredCreator = create
}

export function getRegisteredPairedBrowserTabCreator(): PairedBrowserTabCreator | null {
  return registeredCreator
}

export async function loadPairedBrowserTabCreator(): Promise<PairedBrowserTabCreator> {
  const { createWebRuntimeSessionBrowserTab } = await import('@/runtime/web-runtime-session')
  return createWebRuntimeSessionBrowserTab
}
