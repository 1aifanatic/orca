let openBrowser: ((url: string) => Promise<void>) | null = null

/** Installed by the desktop app; a host without it (a server) signs in nowhere. */
export function setBotToolSignInBrowser(open: ((url: string) => Promise<void>) | null): void {
  openBrowser = open
}

export function getBotToolSignInBrowser(): ((url: string) => Promise<void>) | null {
  return openBrowser
}
