import type { Page } from '@playwright/test'

export async function installMountIdentityDiagnostic(page: Page): Promise<void> {
  page.on('console', (message) => {
    if (message.text().startsWith('[mount-identity]')) {
      console.log(message.text())
    }
  })
  await page.evaluate(() => {
    window.__store?.subscribe((state, previous) => {
      if (state.tabsByWorktree === previous.tabsByWorktree) {
        return
      }
      const before = new Set(
        Object.values(previous.tabsByWorktree)
          .flat()
          .map((tab) => tab.id)
      )
      const added = Object.values(state.tabsByWorktree)
        .flat()
        .filter((tab) => !before.has(tab.id))
      if (added.length) {
        console.log(
          '[mount-identity]',
          JSON.stringify({ added, stack: new Error('tab added').stack })
        )
      }
    })
  })
}
