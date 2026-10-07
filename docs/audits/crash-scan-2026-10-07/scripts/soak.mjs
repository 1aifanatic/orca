// Soak driver for the hidden released v1.4.222 renderer over CDP. Normal-usage actions only.
// usage: node soak.mjs <cdpPort> <minutes> <outDir> <profileDir>
import { createRequire } from 'node:module'
import { appendFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'

if (process.env.ORCA_BACKGROUND_LAUNCH !== '1') {
  throw new Error('Run with ORCA_BACKGROUND_LAUNCH=1.')
}
const [port, minutes, outDir, profileDir] = process.argv.slice(2)
const { chromium } = createRequire(`${process.env.REPO_ROOT}/package.json`)('playwright-core')
const log = (o) =>
  appendFileSync(
    join(outDir, 'soak.ndjson'),
    `${JSON.stringify({ t: new Date().toISOString(), ...o })}\n`
  )

function listDumps() {
  const out = []
  const walk = (d) => {
    if (!existsSync(d)) {
      return
    }
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) {
        walk(p)
      } else if (e.name.endsWith('.dmp')) {
        out.push(`${p}:${statSync(p).size}`)
      }
    }
  }
  walk(join(profileDir, 'Crashpad'))
  return out
}

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
const page = browser
  .contexts()
  .flatMap((c) => c.pages())
  .find((p) => p.url().includes('renderer/index.html'))
if (!page) {
  throw new Error('main renderer page not found')
}
let crashed = false
page.on('crash', () => {
  crashed = true
  log({ ev: 'renderer-crash' })
})
page.on('close', () => log({ ev: 'page-close' }))
const cdp = await page.context().newCDPSession(page)
const baselineDumps = listDumps()
log({ ev: 'start', port, minutes: Number(minutes), baselineDumps })

const deadline = Date.now() + Number(minutes) * 60_000
const widths = [1200, 1440, 980, 1600, 1100]
let cycle = 0
let lastStat = 0
while (Date.now() < deadline && !crashed) {
  cycle++
  try {
    const rows = page.getByText(/^wt-[abc]$|^main$/)
    const count = await rows.count()
    if (count > 0) {
      await rows
        .nth(cycle % count)
        .click({ timeout: 3000 })
        .catch(() => {})
    }
    const tabs = page.getByText(/^agent-\d[ab]$/)
    const tc = await tabs.count()
    if (tc > 0) {
      await tabs
        .nth(cycle % tc)
        .click({ timeout: 2000 })
        .catch(() => {})
    }
    if (cycle % 5 === 0) {
      const theme = cycle % 10 === 0 ? 'light' : 'dark'
      await page.evaluate((th) => window.api.settings.set({ theme: th }), theme)
    }
    if (cycle % 7 === 0) {
      const w = widths[cycle % widths.length]
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: w,
        height: 900,
        deviceScaleFactor: 1,
        mobile: false
      })
    }
    if (cycle % 11 === 0) {
      await page.keyboard
        .press(process.platform === 'darwin' ? 'Meta+Comma' : 'Control+Comma')
        .catch(() => {})
      await page.waitForTimeout(400)
      await page.keyboard.press('Escape').catch(() => {})
    }
    const buttons = page.locator('button')
    const bc = await buttons.count()
    if (bc > 0) {
      await buttons
        .nth((cycle * 13) % bc)
        .hover({ timeout: 1000 })
        .catch(() => {})
    }
    await page.waitForTimeout(250)
  } catch (error) {
    log({ ev: 'action-error', cycle, error: String(error).slice(0, 300) })
    if (crashed) {
      break
    }
  }
  if (Date.now() - lastStat > 30_000) {
    lastStat = Date.now()
    const stat = await page
      .evaluate(() => ({
        heap: Math.round(performance.memory.usedJSHeapSize / 1048576),
        nodes: document.getElementsByTagName('*').length,
        dark: document.documentElement.classList.contains('dark')
      }))
      .catch((e) => ({ error: String(e).slice(0, 200) }))
    log({ ev: 'stat', cycle, ...stat, dumps: listDumps().length })
  }
}
const finalDumps = listDumps()
log({ ev: 'end', cycle, crashed, newDumps: finalDumps.filter((d) => !baselineDumps.includes(d)) })
await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => {})
await browser.close().catch(() => {})
