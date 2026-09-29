import type { Page } from '@playwright/test'

export async function installMountIdentityDiagnostic(page: Page): Promise<void> {
  page.on('console', (message) => {
    if (message.text().startsWith('[mount-identity]')) {
      console.log(message.text())
    }
  })
  await page.evaluate(() => {
    let previousSnapshot = ''
    let remaining = 200
    window.__store?.subscribe((state) => {
      const rows = Object.entries(state.tabsByWorktree)
        .filter(([id]) => id.includes('live-mount'))
        .flatMap(([, tabs]) =>
          tabs.map((tab) => ({
            id: tab.id,
            ptyId: tab.ptyId,
            layout: state.terminalLayoutsByTabId[tab.id],
            ptyIds: state.ptyIdsByTabId[tab.id]
          }))
        )
      const snapshot = JSON.stringify(rows)
      if (snapshot !== previousSnapshot && remaining > 0) {
        remaining -= 1
        console.log(
          '[mount-identity]',
          JSON.stringify({ rows, stack: new Error('bindings changed').stack })
        )
        previousSnapshot = snapshot
      }
    })
  })
}
